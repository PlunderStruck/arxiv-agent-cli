import { Agent as HttpAgent, request as httpRequest } from "node:http";

import { ArxivClient } from "../src/arxiv/client.js";
import { QueryCache } from "../src/cache.js";
import { CLI_VERSION, runCli } from "../src/cli.js";
import type { CommandContext } from "../src/commands/context.js";
import { NodeHttpTransport, type RequestFunction } from "../src/http/transport.js";
import { configuredLibraryRoot } from "../src/library/paths.js";
import { LibraryStore } from "../src/library/store.js";
import { NetworkGate } from "../src/throttle.js";

const originText = process.env["ARXIV_FIXTURE_ORIGIN"];
if (originText === undefined) {
  throw new Error("ARXIV_FIXTURE_ORIGIN is required by the test fixture CLI");
}
const origin = new URL(originText);
if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
  throw new Error("ARXIV_FIXTURE_ORIGIN must be a loopback HTTP URL");
}

const diagnostic = (message: string): void => {
  process.stderr.write(`arxiv: ${message}\n`);
};
const library = await LibraryStore.create({ root: configuredLibraryRoot() });
const agent = new HttpAgent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1 });
const transport = new NodeHttpTransport({
  protocol: "http:",
  request: httpRequest as RequestFunction,
  agent,
  userAgent: `arxiv-agent-cli-fixture/${CLI_VERSION}`,
});
const client = new ArxivClient({
  transport,
  gate: new NetworkGate({ onWait: diagnostic }),
  queryOrigin: new URL("/api/query", origin),
  pdfOrigin: new URL("/pdf/", origin),
  onWait: diagnostic,
});
const context: CommandContext = {
  client,
  library,
  cache: new QueryCache({ directory: library.cacheDirectory }),
  cliVersion: CLI_VERSION,
  now: () => new Date(),
  diagnostic,
  debug: (message) => {
    if (process.env["ARXIV_DEBUG"] === "1") {
      diagnostic(`[debug] ${message}`);
    }
  },
};

try {
  process.exitCode = await runCli(process.argv.slice(2), { context });
} finally {
  agent.destroy();
}
