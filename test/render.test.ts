import assert from "node:assert/strict";
import test from "node:test";

import type { TextCommandResult } from "../src/commands/text.js";
import type { LibraryEntry } from "../src/library/store.js";
import { renderText, TEXT_OUTPUT_CHARS } from "../src/render.js";

test("text rendering enforces the same declared budget in human and JSON output", () => {
  const result: TextCommandResult = {
    entry: libraryEntry(),
    range: { start: 1, end: 5 },
    totalPages: 20,
    text: "bounded evidence ".repeat(3_000),
  };

  const human = renderText(result, { json: false, cliVersion: "test" });
  assert.ok(human.length <= TEXT_OUTPUT_CHARS);
  assert.match(human, /\[\d+ chars, \d+ shown\]/);
  assert.match(human, /narrower: arxiv text 2211\.17192v2 --pages 1-1/);

  const json = renderText(result, { json: true, cliVersion: "test" });
  assert.ok(json.length <= TEXT_OUTPUT_CHARS);
  const parsed = JSON.parse(json);
  assert.equal(parsed.outputTruncated, true);
  assert.equal(parsed.truncatedFields[0].field, "text");
  assert.equal(parsed.truncatedFields[0].totalChars, result.text.length);
});

function libraryEntry(): LibraryEntry {
  return {
    exactId: "2211.17192v2",
    path: "/tmp/2211.17192v2.pdf",
    state: "live",
    record: {
      id: "2211.17192",
      version: 2,
      file: "papers/2211.17192v2.pdf",
      bytes: 1_000,
      sha256: "0".repeat(64),
      pages: 20,
      title: "Fast Inference from Transformers via Speculative Decoding",
      authors: [{ name: "Yaniv Leviathan", affiliation: null }],
      primaryCategory: "cs.LG",
      categories: ["cs.LG"],
      publishedAt: "2022-11-30T00:00:00Z",
      updatedAt: "2023-01-10T00:00:00Z",
      summary: "summary",
      doi: null,
      journalRef: null,
      comment: null,
      metadataFetchedAt: "2026-01-01T00:00:00.000Z",
      metadataState: "complete",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}
