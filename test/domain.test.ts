import assert from "node:assert/strict";
import test from "node:test";

import { AtomFeedError, parseAtomFeed } from "../src/arxiv/atom.js";
import { buildSearchUrl, tokenize } from "../src/arxiv/query.js";
import { CliError } from "../src/errors.js";
import {
  decodePaperFilename,
  idSlug,
  paperFilename,
  parseArxivId,
  safeLibraryFile,
} from "../src/library/paths.js";
import { atomFeed } from "./fixtures/atom.js";

test("modern and legacy arXiv IDs retain base/version identity", () => {
  assert.deepEqual(parseArxivId("2211.17192v2"), {
    input: "2211.17192v2",
    baseId: "2211.17192",
    version: 2,
    exactId: "2211.17192v2",
    legacy: false,
  });
  assert.equal(parseArxivId("math.GT/0309136").baseId, "math.GT/0309136");
  assert.equal(idSlug("math.GT/0309136"), "math.GT_0309136");
  assert.throws(() => parseArxivId("2302.0131"), CliError);
  assert.equal(parseArxivId("1412.1234").baseId, "1412.1234");
  assert.throws(() => parseArxivId("../../../.ssh/authorized_keys"), CliError);
});

test("paper filenames round-trip slash-bearing legacy IDs without traversal", () => {
  const filename = paperFilename("math.GT/0309136", 1, "A result: with symbols");
  assert.equal(filename, "math.GT_0309136v1-a-result-with-symbols.pdf");
  assert.deepEqual(decodePaperFilename(filename), {
    baseId: "math.GT/0309136",
    version: 1,
  });
  assert.throws(() => safeLibraryFile("/tmp/papers", "../outside.pdf"), CliError);
});

test("search query terms are AND-joined and date/category filters are encoded", () => {
  const url = buildSearchUrl({
    query: 'sparse "auto encoder"',
    category: "cs.LG",
    since: "2024-01-01",
    until: "2024-12-31",
    limit: 20,
    offset: 10,
    sort: "updated",
  });
  assert.equal(
    url.searchParams.get("search_query"),
    'all:sparse AND all:"auto encoder" AND cat:cs.LG AND submittedDate:[202401010000 TO 202412312359]',
  );
  assert.equal(url.searchParams.get("max_results"), "20");
  assert.equal(url.searchParams.get("start"), "10");
  assert.equal(url.searchParams.get("sortBy"), "lastUpdatedDate");
  assert.deepEqual(tokenize('one "two words" three'), ["one", "two words", "three"]);
  assert.equal(
    buildSearchUrl({ query: "attention OR cat:all" }).searchParams.get("search_query"),
    'all:attention AND all:OR AND all:"cat:all"',
  );
  assert.equal(
    buildSearchUrl({ query: "optics", category: "physics.optics" })
      .searchParams.get("search_query"),
    "all:optics AND cat:physics.optics",
  );
});

test("Atom parser produces versioned typed metadata and detects API errors", () => {
  const feed = parseAtomFeed(atomFeed());
  assert.equal(feed.total, 1);
  assert.equal(feed.entries[0]?.exactId, "2211.17192v2");
  assert.equal(feed.entries[0]?.authors[0]?.name, "Yaniv Leviathan");
  assert.deepEqual(feed.entries[0]?.categories, ["cs.LG", "cs.CL"]);

  assert.throws(
    () =>
      parseAtomFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>http://export.arxiv.org/api/errors#x</id><title>Error</title></feed>`),
    AtomFeedError,
  );
  assert.throws(
    () => parseAtomFeed(`<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]><feed></feed>`),
    CliError,
  );
  assert.throws(() => parseAtomFeed("<feed><title>cut off</title>"), CliError);
});
