import assert from "node:assert/strict";
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArxivClient,
  InvalidPdfError,
  InvalidRedirectError,
  ResponseTooLargeError,
} from "../src/arxiv/client.js";
import type { CoordinatorPaths } from "../src/coordinator.js";
import { NodeHttpTransport, type RequestFunction } from "../src/http/transport.js";
import { NetworkGate } from "../src/throttle.js";
import { atomFeed } from "./fixtures/atom.js";

test("arXiv client retries a retryable response through the gate", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.statusCode = 500;
      response.end("retry");
    } else {
      response.setHeader("content-type", "application/atom+xml");
      response.end(atomFeed());
    }
  });
  const origin = await listen(server);
  const fixture = await createClient(origin, { maxAttempts: 2 });
  try {
    const result = await fixture.client.search({ query: "speculative decoding" });
    assert.equal(result.entries[0]?.exactId, "2211.17192v2");
    assert.equal(requests, 2);
    assert.deepEqual(fixture.backoffs, [3_000]);
  } finally {
    fixture.destroy();
    await close(server);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("arXiv client refuses HTML masquerading as a PDF", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<html>busy</html>");
  });
  const origin = await listen(server);
  const fixture = await createClient(origin, { maxAttempts: 1 });
  try {
    await assert.rejects(
      fixture.client.downloadPdf("2211.17192v2"),
      InvalidPdfError,
    );
  } finally {
    fixture.destroy();
    await close(server);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("redirect validation runs before an unsafe destination is requested", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.statusCode = 302;
    response.setHeader("location", "https://example.com/stolen");
    response.end();
  });
  const origin = await listen(server);
  const fixture = await createClient(origin, { maxAttempts: 1 });
  try {
    await assert.rejects(
      fixture.client.search({ query: "redirect" }),
      InvalidRedirectError,
    );
    assert.equal(requests, 1);
  } finally {
    fixture.destroy();
    await close(server);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("client aborts a server that accepts and never sends headers", async () => {
  let accepted!: () => void;
  const requestAccepted = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const server = createServer(() => {
    accepted();
  });
  const origin = await listen(server);
  const fixture = await createClient(origin, {
    maxAttempts: 1,
    connectHeadersTimeoutMs: 40,
  });
  try {
    const pending = fixture.client.search({ query: "timeout" });
    await requestAccepted;
    await assert.rejects(pending, /failed after 1 attempt/);
  } finally {
    fixture.destroy();
    await close(server);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("client rejects an Atom body declared above 5 MiB before caching or parsing", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-length", String(6 * 1024 * 1024));
    response.end("oversized");
  });
  const origin = await listen(server);
  const fixture = await createClient(origin, { maxAttempts: 1 });
  try {
    await assert.rejects(
      fixture.client.search({ query: "oversized" }),
      ResponseTooLargeError,
    );
  } finally {
    fixture.destroy();
    await close(server);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createClient(
  origin: URL,
  options: {
    readonly maxAttempts: number;
    readonly connectHeadersTimeoutMs?: number;
  },
): Promise<{
  readonly client: ArxivClient;
  readonly directory: string;
  readonly backoffs: number[];
  readonly destroy: () => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-client-"));
  const paths = await coordinatorPaths(directory);
  let monotonicMs = 1_000;
  const backoffs: number[] = [];
  const gate = new NetworkGate({
    paths,
    intervalMs: 1,
    monotonicNowNs: () => BigInt(monotonicMs) * 1_000_000n,
    wallNowMs: () => monotonicMs,
    sleep: async (milliseconds) => {
      monotonicMs += milliseconds;
    },
  });
  const agent = new HttpAgent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1 });
  const transport = new NodeHttpTransport({
    protocol: "http:",
    request: httpRequest as RequestFunction,
    agent,
    userAgent: "arxiv-agent-cli-test/0.1.0",
  });
  const client = new ArxivClient({
    transport,
    gate,
    queryOrigin: new URL("/api/query", origin),
    pdfOrigin: new URL("/pdf/", origin),
    maxAttempts: options.maxAttempts,
    now: () => monotonicMs,
    sleep: async (milliseconds) => {
      backoffs.push(milliseconds);
      monotonicMs += milliseconds;
    },
    random: () => 0,
    connectHeadersTimeoutMs: options.connectHeadersTimeoutMs ?? 2_000,
    bodyStallTimeoutMs: 2_000,
    queryAttemptTimeoutMs: 5_000,
    queryOperationTimeoutMs: 20_000,
  });
  return { client, directory, backoffs, destroy: () => agent.destroy() };
}

async function coordinatorPaths(root: string): Promise<CoordinatorPaths> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return {
    root,
    networkDatabase: join(root, "network.sqlite"),
    lastRequestStart: join(root, "last-request-start"),
    breaker: join(root, "breaker.json"),
  };
}

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/`);
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
