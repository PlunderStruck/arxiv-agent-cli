import assert from "node:assert/strict";
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import {
  Agent as HttpsAgent,
  createServer as createHttpsServer,
  request as httpsRequest,
  type Server as HttpsServer,
} from "node:https";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { SqliteMutex, withSqliteMutex } from "../src/coordinator.js";
import {
  createHttpsTransport,
  IncompleteResponseError,
  NodeHttpTransport,
  type RequestFunction,
  UnsupportedProtocolError,
  type WireResponse,
} from "../src/http/transport.js";
import {
  TEST_TLS_CERTIFICATE,
  TEST_TLS_KEY,
} from "./fixtures/tls-certificate.js";

test("transport resolves only after its non-keep-alive socket closes", async () => {
  let connectionHeader: string | undefined;
  const server = createServer((request, response) => {
    connectionHeader = request.headers.connection;
    response.end("ok");
  });
  const origin = await listen(server);
  let socketClosed = false;
  let assignedSocket: Duplex | undefined;
  const transport = createTestTransport((socket) => {
    assignedSocket = socket;
    socket.once("close", () => {
      socketClosed = true;
    });
  });

  try {
    const result = await transport.request(new URL("/paper", origin), {}, readUtf8);

    assert.equal(result.statusCode, 200);
    assert.equal(result.value, "ok");
    assert.equal(connectionHeader, "close");
    assert.ok(assignedSocket !== undefined);
    assert.equal(socketClosed, true);
    assert.equal(assignedSocket.destroyed, true);
  } finally {
    await close(server);
  }
});

test("the production HTTPS factory rejects plaintext URLs before opening a socket", async () => {
  let socketAssigned = false;
  const transport = createHttpsTransport({
    userAgent: "arxiv-agent-cli-test/0.1.0",
    onSocket: () => {
      socketAssigned = true;
    },
  });

  await assert.rejects(
    transport.request(new URL("http://127.0.0.1/not-https"), {}, readUtf8),
    UnsupportedProtocolError,
  );
  assert.equal(socketAssigned, false);
});

test("a response consumer cannot return before reading the complete body", async () => {
  const server = createServer((_request, response) => {
    response.write("still-streaming");
  });
  const origin = await listen(server);
  let socketClosed = false;
  const transport = createTestTransport((socket) => {
    socket.once("close", () => {
      socketClosed = true;
    });
  });

  try {
    await assert.rejects(
      transport.request(new URL("/partial", origin), {}, async () => "too-early"),
      IncompleteResponseError,
    );
    assert.equal(socketClosed, true);
  } finally {
    await close(server);
  }
});

test("HTTPS uses a new socket while resuming the prior TLS session", async () => {
  const server = createHttpsServer(
    {
      key: TEST_TLS_KEY,
      cert: TEST_TLS_CERTIFICATE,
    },
    (_request, response) => response.end("secure"),
  );
  const origin = await listen(server, "https:");
  const sockets: Duplex[] = [];
  const sessionReuse: Promise<boolean>[] = [];
  const agent = new HttpsAgent({
    keepAlive: false,
    maxSockets: 1,
    maxTotalSockets: 1,
    rejectUnauthorized: false,
  });
  const transport = new NodeHttpTransport({
    protocol: "https:",
    request: httpsRequest,
    agent,
    userAgent: "arxiv-agent-cli-test/0.1.0",
    onSocket: (socket) => {
      sockets.push(socket);
      sessionReuse.push(
        new Promise((resolve) => {
          const tlsSocket = socket as import("node:tls").TLSSocket;
          tlsSocket.once("secureConnect", () => resolve(tlsSocket.isSessionReused()));
        }),
      );
    },
  });

  try {
    const first = await transport.request(new URL("/first", origin), {}, readUtf8);
    const second = await transport.request(new URL("/second", origin), {}, readUtf8);
    const reuse = await Promise.all(sessionReuse);

    assert.equal(first.value, "secure");
    assert.equal(second.value, "secure");
    assert.equal(sockets.length, 2);
    assert.notEqual(sockets[0], sockets[1]);
    assert.deepEqual(reuse, [false, true]);
  } finally {
    agent.destroy();
    await close(server);
  }
});

test("aborting a request destroys and closes its assigned socket before rejection", async () => {
  let accepted!: () => void;
  const requestAccepted = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const server = createServer(() => {
    accepted();
    // Intentionally never send headers.
  });
  const origin = await listen(server);
  const controller = new AbortController();
  let socketClosed = false;
  const transport = createTestTransport((socket) => {
    socket.once("close", () => {
      socketClosed = true;
    });
  });

  try {
    const pending = transport.request(
      new URL("/never-responds", origin),
      { signal: controller.signal },
      readUtf8,
    );
    await requestAccepted;
    controller.abort(new Error("test abort"));

    await assert.rejects(pending);
    assert.equal(socketClosed, true);
  } finally {
    await close(server);
  }
});

test("withSqliteMutex retains ownership until the transport socket closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-agent-cli-compose-"));
  const databasePath = join(directory, "network.sqlite");
  let finishResponse!: () => void;
  let accepted!: () => void;
  const requestAccepted = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const server = createServer((_request, response) => {
    response.write("part-1");
    finishResponse = () => response.end("-part-2");
    accepted();
  });
  const origin = await listen(server);
  let sequence = 0;
  let socketClosedAt = 0;
  const transport = createTestTransport((socket) => {
    socket.once("close", () => {
      socketClosedAt = ++sequence;
    });
  });
  const holder = createTestMutex(databasePath);
  const waiter = createTestMutex(databasePath);

  try {
    const first = withSqliteMutex(holder, async () => {
      return await transport.request(new URL("/stream", origin), {}, readUtf8);
    });
    await requestAccepted;

    let waiterAcquired = false;
    const second = waiter.acquire().then((guard) => {
      waiterAcquired = true;
      const acquiredAt = ++sequence;
      return { acquiredAt, guard };
    });

    await delay(30);
    assert.equal(waiterAcquired, false);

    finishResponse();
    const firstResult = await first;
    const { acquiredAt, guard } = await second;
    guard.rollback();

    assert.equal(firstResult.value, "part-1-part-2");
    assert.ok(socketClosedAt > 0);
    assert.ok(
      socketClosedAt < acquiredAt,
      `waiter acquired at ${acquiredAt} before socket closed at ${socketClosedAt}`,
    );
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

function createTestTransport(onSocket?: (socket: Duplex) => void): NodeHttpTransport {
  const agent = new HttpAgent({
    keepAlive: false,
    maxSockets: 1,
    maxTotalSockets: 1,
  });

  return new NodeHttpTransport({
    protocol: "http:",
    request: httpRequest as RequestFunction,
    agent,
    userAgent: "arxiv-agent-cli-test/0.1.0",
    ...(onSocket === undefined ? {} : { onSocket }),
  });
}

function createTestMutex(databasePath: string): SqliteMutex {
  return new SqliteMutex({
    databasePath,
    busyTimeoutMs: 10,
    // This test deliberately makes the waiter block until the holder's socket
    // closes, and asserts only the ordering of those two events. Any wall-clock
    // acquisition cap here is therefore scaffolding that can only produce false
    // failures when CI scheduling stalls the holder: it turns "the machine was
    // busy" into "the mutex is broken". Keep it far above any plausible stall so
    // a genuine failure to release still surfaces, as a timeout rather than a
    // hang, without load being able to trip it.
    acquisitionTimeoutMs: 60_000,
    retryDelayMinMs: 2,
    retryDelayMaxMs: 5,
  });
}

async function readUtf8(response: WireResponse): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

type TestServer = Server | HttpsServer;

async function listen(
  server: TestServer,
  protocol: "http:" | "https:" = "http:",
): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return new URL(`${protocol}//127.0.0.1:${address.port}/`);
}

async function close(server: TestServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}
