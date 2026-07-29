import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CoordinatorPaths } from "../src/coordinator.js";
import { CircuitBreakerOpenError, NetworkGate } from "../src/throttle.js";

test("network gate serializes work and persists minimum start spacing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-gate-"));
  const paths = await coordinatorPaths(directory);
  let clockNs = 1_000_000_000n;
  const sleeps: number[] = [];
  const options = {
    paths,
    intervalMs: 3_000,
    monotonicNowNs: () => clockNs,
    wallNowMs: () => Number(clockNs / 1_000_000n),
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      clockNs += BigInt(Math.ceil(milliseconds * 1_000_000));
    },
  };
  const first = new NetworkGate(options);
  const second = new NetworkGate(options);
  try {
    await first.run(async () => "one", {
      classifyValue: () => ({ kind: "success" }),
      classifyError: () => ({ kind: "retryable" }),
    });
    await second.run(async () => "two", {
      classifyValue: () => ({ kind: "success" }),
      classifyError: () => ({ kind: "retryable" }),
    });
    assert.deepEqual(sleeps, [3_000]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared breaker opens after consecutive retryable failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arxiv-breaker-"));
  const paths = await coordinatorPaths(directory);
  let wall = 10_000;
  const gate = new NetworkGate({
    paths,
    intervalMs: 1,
    breakerThreshold: 2,
    breakerOpenMs: 60_000,
    monotonicNowNs: () => BigInt(wall) * 1_000_000n,
    wallNowMs: () => wall,
    sleep: async (milliseconds) => {
      wall += milliseconds;
    },
  });
  const runFailure = async (): Promise<void> => {
    await assert.rejects(
      gate.run(
        async () => {
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        },
        {
          classifyValue: () => ({ kind: "success" }),
          classifyError: () => ({ kind: "retryable" }),
        },
      ),
      /reset/,
    );
  };
  try {
    await runFailure();
    await runFailure();
    let invoked = false;
    await assert.rejects(
      gate.run(
        async () => {
          invoked = true;
          return "unexpected";
        },
        {
          classifyValue: () => ({ kind: "success" }),
          classifyError: () => ({ kind: "retryable" }),
        },
      ),
      CircuitBreakerOpenError,
    );
    assert.equal(invoked, false);

    wall += 60_001;
    assert.equal(
      await gate.run(async () => "recovered", {
        classifyValue: () => ({ kind: "success" }),
        classifyError: () => ({ kind: "retryable" }),
      }),
      "recovered",
    );
    assert.equal(gate.peekOpenUntil(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function coordinatorPaths(root: string): Promise<CoordinatorPaths> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return {
    root,
    networkDatabase: join(root, "network.sqlite"),
    lastRequestStart: join(root, "last-request-start"),
    breaker: join(root, "breaker.json"),
  };
}
