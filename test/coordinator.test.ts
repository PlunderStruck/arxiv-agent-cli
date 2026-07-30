import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  SqliteMutex,
  SqliteMutexAbortedError,
  SqliteMutexTimeoutError,
  withSqliteMutex,
} from "../src/coordinator.js";

test("a schema-free SQLite mutex serializes independent connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-agent-cli-mutex-"));
  const databasePath = join(directory, "mutex.sqlite");
  const holder = createTestMutex(databasePath);
  const waiter = createTestMutex(databasePath, { acquisitionTimeoutMs: 80 });

  try {
    const guard = await holder.acquire();
    try {
      await assert.rejects(
        waiter.acquire(),
        (error: unknown) =>
          error instanceof SqliteMutexTimeoutError &&
          error.databasePath === databasePath &&
          error.timeoutMs === 80,
      );
    } finally {
      guard.rollback();
    }

    const nextGuard = await waiter.acquire();
    nextGuard.commit();
    nextGuard.rollback();
    assert.equal(nextGuard.released, true);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      assert.deepEqual(rows, []);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an already-aborted acquisition fails before opening the SQLite database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-agent-cli-abort-"));
  const databasePath = join(directory, "mutex.sqlite");
  const mutex = createTestMutex(databasePath);
  const controller = new AbortController();
  controller.abort(new Error("cancel before acquire"));

  try {
    await assert.rejects(
      mutex.acquire({ signal: controller.signal }),
      SqliteMutexAbortedError,
    );

    const database = new DatabaseSync(databasePath, {
      readOnly: true,
      open: false,
    });
    assert.throws(() => database.open());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("withSqliteMutex rolls back and releases after work fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-agent-cli-rollback-"));
  const databasePath = join(directory, "mutex.sqlite");
  const mutex = createTestMutex(databasePath);

  try {
    await assert.rejects(
      withSqliteMutex(mutex, async () => {
        throw new Error("planned failure");
      }),
      /planned failure/,
    );

    const guard = await createTestMutex(databasePath).acquire();
    guard.rollback();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "SIGKILL releases a held SQLite mutex for a waiting process",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arxiv-agent-cli-crash-"));
    const databasePath = join(directory, "mutex.sqlite");
    const fixture = new URL("./fixtures/lock-holder.js", import.meta.url);
    const child = fork(fixture, [databasePath], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });

    try {
      // Forking a Node process and opening SQLite can take seconds on a loaded
      // CI runner. This deadline exists only so a genuinely broken fixture fails
      // instead of hanging forever, so keep it far above any plausible stall.
      const [message] = await once(child, "message", {
        signal: AbortSignal.timeout(60_000),
      });
      assert.deepEqual(message, { type: "acquired" });

      const waiter = createTestMutex(databasePath, {
        acquisitionTimeoutMs: 60_000,
      });
      const startedAt = performance.now();
      const waiting = waiter.acquire();
      const exit = once(child, "exit");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 100);

      const guard = await waiting;
      const elapsedMs = performance.now() - startedAt;
      clearTimeout(killTimer);
      guard.rollback();
      await exit;

      // The property under test is that SIGKILL released the lock: the waiter
      // must not acquire before the kill at 100 ms, and must acquire afterwards.
      // The lower bound proves the lock was genuinely held; `await waiting`
      // resolving at all proves it was released. An upper bound here would only
      // re-assert how fast the machine is, which is not a property of the mutex.
      assert.ok(elapsedMs >= 75, `waiter acquired too early after ${elapsedMs} ms`);
    } finally {
      child.kill("SIGKILL");
      await delay(10);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function createTestMutex(
  databasePath: string,
  overrides: {
    readonly acquisitionTimeoutMs?: number;
  } = {},
): SqliteMutex {
  return new SqliteMutex({
    databasePath,
    busyTimeoutMs: 10,
    acquisitionTimeoutMs: overrides.acquisitionTimeoutMs ?? 500,
    retryDelayMinMs: 2,
    retryDelayMaxMs: 5,
  });
}
