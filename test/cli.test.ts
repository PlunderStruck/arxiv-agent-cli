import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { AtomFeed, PaperMetadata } from "../src/arxiv/atom.js";
import type { ArxivClientApi } from "../src/arxiv/client.js";
import type { SearchQueryOptions } from "../src/arxiv/query.js";
import { QueryCache } from "../src/cache.js";
import { CLI_VERSION, runCli } from "../src/cli.js";
import type { CommandContext } from "../src/commands/context.js";
import { LibraryStore } from "../src/library/store.js";
import { makeMetadata } from "./fixtures/metadata.js";
import { makeTestPdf } from "./fixtures/pdf.js";

const execFileAsync = promisify(execFile);

test("compiled CLI executes when launched through the installed symlink shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-bin-"));
  const executable = join(directory, "arxiv");
  const compiledCli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  try {
    await symlink(compiledCli, executable);
    const result = await execFileAsync(executable, ["--version"]);
    assert.equal(result.stdout.trim(), CLI_VERSION);
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI refuses output and download caps before calling the client", async () => {
  const fixture = await cliFixture();
  try {
    const search = await fixture.run(["search", "attention", "--limit", "200"]);
    assert.equal(search.code, 2);
    assert.match(search.stderr, /cap of 50/);
    const download = await fixture.run(["download", "1", "2", "3", "4"]);
    assert.equal(download.code, 2);
    assert.match(download.stderr, /at most 3/);
    assert.equal(fixture.client.calls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("CLI download and cached search overlay follow remove and restore immediately", async () => {
  const fixture = await cliFixture();
  try {
    assert.equal((await fixture.run(["download", "2211.17192"])).code, 0);
    const inLibrary = await fixture.run(["search", "speculative", "--json"]);
    assert.equal(inLibrary.code, 0);
    assert.deepEqual(JSON.parse(inLibrary.stdout).results[0].cachedVersions, [2]);

    assert.equal((await fixture.run(["library", "remove", "2211.17192"])).code, 0);
    const removed = await fixture.run(["search", "speculative", "--json"]);
    assert.deepEqual(JSON.parse(removed.stdout).results[0].cachedVersions, []);

    assert.equal((await fixture.run(["library", "restore", "2211.17192"])).code, 0);
    const restored = await fixture.run(["search", "speculative", "--json"]);
    assert.deepEqual(JSON.parse(restored.stdout).results[0].cachedVersions, [2]);
  } finally {
    await fixture.cleanup();
  }
});

test("CLI text requires a bounded page range and JSON errors remain machine-readable", async () => {
  const fixture = await cliFixture();
  try {
    await fixture.run(["download", "2211.17192"]);
    const missing = await fixture.run(["text", "2211.17192", "--json"]);
    assert.equal(missing.code, 2);
    const error = JSON.parse(missing.stdout);
    assert.equal(error.schemaVersion, 1);
    assert.equal(error.error.exitCode, 2);

    const wide = await fixture.run([
      "text",
      "2211.17192",
      "--pages",
      "1-6",
      "--json",
    ]);
    assert.equal(wide.code, 2);
    const text = await fixture.run([
      "text",
      "2211.17192",
      "--pages",
      "1-2",
      "--json",
    ]);
    assert.equal(text.code, 0);
    assert.equal(JSON.parse(text.stdout).totalPages, 2);

    const outOfRange = await fixture.run([
      "text",
      "2211.17192",
      "--pages",
      "2-3",
      "--json",
    ]);
    assert.equal(outOfRange.code, 2);
    assert.match(JSON.parse(outOfRange.stdout).error.message, /has 2 pages/);
  } finally {
    await fixture.cleanup();
  }
});

test("get JSON remains valid and below 20,000 characters for oversized metadata", async () => {
  const fixture = await cliFixture({
    summary: "longword ".repeat(10_000),
    authors: Array.from({ length: 100 }, (_value, index) => ({
      name: `Author ${index} ${"x".repeat(500)}`,
      affiliation: "Affiliation ".repeat(100),
    })),
  });
  try {
    const result = await fixture.run(["get", "2211.17192", "--json"]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.length <= 20_001);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.outputTruncated, true);
    assert.ok(parsed.truncatedFields.length > 0);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed IDs recover from cached search results with exit 3", async () => {
  const fixture = await cliFixture();
  try {
    await fixture.run(["search", "speculative"]);
    const result = await fixture.run(["get", "2211.1719"]);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /did you mean: arxiv get 2211\.17192/);
  } finally {
    await fixture.cleanup();
  }
});

test("downloading a fresh search result reuses its exact-ID metadata cache", async () => {
  const fixture = await cliFixture();
  try {
    await fixture.run(["search", "speculative"]);
    assert.equal(fixture.client.calls, 1);
    await fixture.run(["download", "2211.17192v2"]);
    assert.equal(fixture.client.calls, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("a cold exact-ID download uses one PDF request and records incomplete metadata", async () => {
  const fixture = await cliFixture();
  try {
    const result = await fixture.run(["download", "2211.17192v2"]);
    assert.equal(result.code, 0);
    assert.equal(fixture.client.calls, 1);
    const entry = await fixture.context.library.resolveLive("2211.17192v2");
    assert.equal(entry.record.metadataState, "incomplete");

    await fixture.run(["get", "2211.17192v2", "--no-stale"]);
    const refreshed = await fixture.context.library.resolveLive("2211.17192v2");
    assert.equal(refreshed.record.metadataState, "complete");
    assert.equal(refreshed.record.title, fixture.client.metadata.title);
  } finally {
    await fixture.cleanup();
  }
});

async function cliFixture(
  metadataOverrides: Partial<PaperMetadata> = {},
): Promise<{
  readonly client: FakeClient;
  readonly context: CommandContext;
  readonly run: (argv: readonly string[]) => Promise<{
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "arxiv-cli-"));
  const library = await LibraryStore.create({ root });
  const client = new FakeClient(makeMetadata(metadataOverrides));
  const context: CommandContext = {
    client,
    library,
    cache: new QueryCache({ directory: library.cacheDirectory }),
    cliVersion: "0.1.0-test",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    diagnostic: () => {},
    debug: () => {},
  };
  return {
    client,
    context,
    run: async (argv) => {
      let stdout = "";
      let stderr = "";
      const code = await runCli(argv, {
        context,
        io: {
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      });
      return { code, stdout, stderr };
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

class FakeClient implements ArxivClientApi {
  calls = 0;

  constructor(readonly metadata: PaperMetadata) {}

  searchUrl(options: SearchQueryOptions): URL {
    return new URL(`https://fixture.invalid/search?q=${encodeURIComponent(options.query)}`);
  }

  idUrl(id: string): URL {
    return new URL(`https://fixture.invalid/id/${encodeURIComponent(id)}`);
  }

  async search(_options: SearchQueryOptions): Promise<AtomFeed> {
    this.calls += 1;
    return {
      total: 1,
      start: 0,
      itemsPerPage: 1,
      entries: [this.metadata],
    };
  }

  async get(_id: string): Promise<PaperMetadata> {
    this.calls += 1;
    return this.metadata;
  }

  async downloadPdf(_exactId: string): Promise<Buffer> {
    this.calls += 1;
    return makeTestPdf(["page one", "page two"]);
  }
}
