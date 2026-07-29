import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QueryCache } from "../src/cache.js";

test("query cache distinguishes fresh and stale values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-cache-"));
  let now = 1_000;
  const cache = new QueryCache({ directory, ttlMs: 100, now: () => now });
  try {
    await cache.put("key", { answer: 42 });
    assert.deepEqual((await cache.get<{ answer: number }>("key"))?.value, { answer: 42 });
    now = 1_101;
    assert.equal(await cache.get("key"), undefined);
    const stale = await cache.get<{ answer: number }>("key", true);
    assert.equal(stale?.stale, true);
    assert.equal(stale?.ageMs, 101);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt cache entries are deleted and bounded LRU evicts old values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-cache-lru-"));
  let now = 1;
  const cache = new QueryCache({
    directory,
    maxEntries: 2,
    maxBytes: 1_000_000,
    now: () => now,
  });
  try {
    await cache.put("one", 1);
    now += 1;
    await cache.put("two", 2);
    now += 1;
    await cache.put("three", 3);
    assert.equal((await readdir(directory)).length, 2);
    assert.equal(await cache.get("one"), undefined);

    const before = new Set(await readdir(directory));
    now += 1;
    await cache.put("broken", { answer: "will corrupt" });
    const pathName = (await readdir(directory)).find((name) => !before.has(name));
    assert.ok(pathName !== undefined);
    const path = join(directory, pathName);
    await writeFile(path, "{bad");
    assert.equal(await cache.get("broken"), undefined);
    assert.equal((await readdir(directory)).includes(path.split("/").at(-1) ?? ""), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
