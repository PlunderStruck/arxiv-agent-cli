import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { CliError } from "../src/errors.js";
import { LibraryStore } from "../src/library/store.js";
import { makeMetadata } from "./fixtures/metadata.js";
import { makeTestPdf } from "./fixtures/pdf.js";

test("library add/remove/restore follows filesystem membership", async () => {
  const root = await mkdtemp(join(tmpdir(), "arxiv-library-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await LibraryStore.create({ root, now: () => now });
  try {
    const added = await store.addPdf(makeMetadata(), makeTestPdf(["first", "second"]));
    assert.equal(added.record.pages, 2);
    assert.equal((await store.list()).total, 1);
    assert.deepEqual(await store.cachedVersions("2211.17192"), [2]);
    assert.equal((await store.readPdf(added)).subarray(0, 5).toString(), "%PDF-");

    const removed = await store.remove("2211.17192");
    assert.equal(removed.state, "trash");
    await assert.rejects(store.resolveLive("2211.17192"), CliError);
    assert.equal((await store.resolveTrashed("2211.17192")).exactId, "2211.17192v2");

    now = new Date("2026-01-02T00:00:00.000Z");
    const restored = await store.restore("2211.17192");
    assert.equal(restored.state, "live");
    assert.equal((await store.list()).total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciliation repairs a crash between membership rename and event append", async () => {
  const root = await mkdtemp(join(tmpdir(), "arxiv-library-crash-"));
  const store = await LibraryStore.create({ root });
  try {
    const added = await store.addPdf(makeMetadata(), makeTestPdf());
    const trashPath = join(root, "trash", basename(added.path));
    await rename(added.path, trashPath);

    await store.reconcile();
    assert.equal((await store.list()).total, 0);
    assert.equal((await store.resolveTrashed("2211.17192v2")).path, trashPath);

    await rename(trashPath, added.path);
    await store.reconcile();
    assert.equal((await store.resolveLive("2211.17192v2")).path, added.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("library repair backs up corrupt index and recovers local facts without invented metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "arxiv-library-repair-"));
  const store = await LibraryStore.create({ root });
  try {
    await store.addPdf(makeMetadata(), makeTestPdf());
    await appendFile(join(root, "index.jsonl"), "{broken}\n");
    const result = await store.repair();
    assert.equal(result.recovered, 1);
    assert.ok(result.backup?.endsWith(".bak"));
    const entry = await store.resolveLive("2211.17192v2");
    assert.equal(entry.record.metadataState, "incomplete");
    assert.equal(entry.record.pages, 1);
    assert.match(await readFile(result.backup ?? "", "utf8"), /\{broken\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repair refuses a newer index schema without rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "arxiv-library-newer-"));
  const store = await LibraryStore.create({ root });
  const indexPath = join(root, "index.jsonl");
  try {
    await appendFile(indexPath, '{"v":2,"op":"future"}\n');
    await assert.rejects(store.repair(), (error: unknown) =>
      error instanceof CliError && error.exitCode === 6 && /upgrade/.test(error.correction));
    assert.equal(await readFile(indexPath, "utf8"), '{"v":2,"op":"future"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("re-downloading a trashed exact version cannot leave duplicate membership", async () => {
  const root = await mkdtemp(join(tmpdir(), "arxiv-library-redownload-"));
  const store = await LibraryStore.create({ root });
  try {
    await store.addPdf(makeMetadata(), makeTestPdf());
    await store.remove("2211.17192v2");
    const redownloaded = await store.addPdf(makeMetadata(), makeTestPdf());
    assert.equal(redownloaded.state, "live");
    await assert.rejects(store.resolveTrashed("2211.17192v2"), CliError);
    assert.equal((await store.list()).total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("library creation refuses nested symlinks that escape the root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "arxiv-library-link-"));
  const root = join(parent, "library");
  const outside = join(parent, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "papers"));
    await assert.rejects(
      LibraryStore.create({ root }),
      (error: unknown) => error instanceof CliError && error.exitCode === 6,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
