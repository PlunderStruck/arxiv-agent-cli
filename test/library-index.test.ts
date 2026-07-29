import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendLibraryEvent,
  CorruptIndexError,
  readLibraryIndex,
  UnsupportedIndexVersionError,
  type LibraryRecord,
} from "../src/library/index.js";

test("append-only index folds add/remove/restore and ignores only a torn final line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-index-"));
  const path = join(directory, "index.jsonl");
  const record = fixtureRecord();
  try {
    appendLibraryEvent(path, { v: 1, op: "add", ...record });
    appendLibraryEvent(path, {
      v: 1,
      op: "rm",
      id: record.id,
      version: record.version,
      ts: "2026-01-02T00:00:00.000Z",
    });
    appendLibraryEvent(path, {
      v: 1,
      op: "restore",
      id: record.id,
      version: record.version,
      file: record.file,
      ts: "2026-01-03T00:00:00.000Z",
    });
    await appendFile(path, '{"v":1,"op":"rm"');
    const folded = readLibraryIndex(path);
    assert.equal(folded.records.get("2211.17192v2")?.active, true);
    assert.equal(folded.ignoredTornTail, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("complete corruption and newer versions stop index writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-index-corrupt-"));
  const path = join(directory, "index.jsonl");
  try {
    await writeFile(path, `${JSON.stringify({ v: 1, op: "wat" })}\n`);
    assert.throws(() => readLibraryIndex(path), CorruptIndexError);
    await writeFile(path, `${JSON.stringify({ v: 2, op: "add" })}\n`);
    assert.throws(() => readLibraryIndex(path), UnsupportedIndexVersionError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

export function fixtureRecord(): LibraryRecord {
  return {
    id: "2211.17192",
    version: 2,
    file: "papers/2211.17192v2-fast-inference.pdf",
    bytes: 123,
    sha256: "a".repeat(64),
    pages: 1,
    title: "Fast Inference",
    authors: [{ name: "Author", affiliation: null }],
    primaryCategory: "cs.LG",
    categories: ["cs.LG"],
    publishedAt: "2022-11-30T00:00:00Z",
    updatedAt: "2023-01-10T00:00:00Z",
    summary: "Summary",
    doi: null,
    journalRef: null,
    comment: null,
    metadataFetchedAt: "2026-01-01T00:00:00.000Z",
    metadataState: "complete",
    addedAt: "2026-01-01T00:00:00.000Z",
  };
}
