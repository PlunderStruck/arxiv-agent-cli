import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  ensureCoordinatorPaths,
  type CoordinatorPaths,
  SqliteMutex,
  SqliteMutexAbortedError,
  SqliteMutexTimeoutError,
} from "./coordinator.js";
import { rateLimitError } from "./errors.js";

const DEFAULT_INTERVAL_MS = 3_000;
const DEFAULT_BREAKER_THRESHOLD = 3;
const DEFAULT_BREAKER_OPEN_MS = 60_000;

export type GateOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "neutral" }
  | { readonly kind: "retryable"; readonly retryAfterMs?: number };

export interface NetworkGateOptions {
  readonly paths?: CoordinatorPaths;
  readonly intervalMs?: number;
  readonly breakerThreshold?: number;
  readonly breakerOpenMs?: number;
  readonly acquisitionTimeoutMs?: number;
  readonly monotonicNowNs?: () => bigint;
  readonly wallNowMs?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly onWait?: (message: string) => void;
  readonly onDebug?: (message: string) => void;
}

export interface GateRunOptions<T> {
  readonly signal?: AbortSignal;
  readonly classifyValue: (value: T) => GateOutcome;
  readonly classifyError: (error: unknown) => GateOutcome;
}

interface PacingState {
  readonly monotonicNs: string;
  readonly wallMs: number;
}

interface BreakerState {
  readonly v: 1;
  readonly consecutiveFailures: number;
  readonly openUntil: number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(readonly openUntil: number) {
    super(`shared arXiv circuit breaker is open until ${new Date(openUntil).toISOString()}`);
    this.name = "CircuitBreakerOpenError";
  }
}

export class NetworkGate {
  readonly #paths: CoordinatorPaths;
  readonly #mutex: SqliteMutex;
  readonly #intervalMs: number;
  readonly #breakerThreshold: number;
  readonly #breakerOpenMs: number;
  readonly #monotonicNowNs: () => bigint;
  readonly #wallNowMs: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #onWait: ((message: string) => void) | undefined;
  readonly #onDebug: ((message: string) => void) | undefined;

  constructor(options: NetworkGateOptions = {}) {
    this.#paths = options.paths ?? ensureCoordinatorPaths();
    this.#intervalMs = positiveInteger("intervalMs", options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.#breakerThreshold = positiveInteger(
      "breakerThreshold",
      options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD,
    );
    this.#breakerOpenMs = positiveInteger(
      "breakerOpenMs",
      options.breakerOpenMs ?? DEFAULT_BREAKER_OPEN_MS,
    );
    this.#monotonicNowNs = options.monotonicNowNs ?? (() => process.hrtime.bigint());
    this.#wallNowMs = options.wallNowMs ?? Date.now;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#onWait = options.onWait;
    this.#onDebug = options.onDebug;
    this.#mutex = new SqliteMutex({
      databasePath: this.#paths.networkDatabase,
      acquisitionTimeoutMs: options.acquisitionTimeoutMs ?? 30_000,
      onWait: () => this.#onWait?.("waiting on shared API gate"),
    });
  }

  async run<T>(
    operation: () => Promise<T>,
    options: GateRunOptions<T>,
  ): Promise<T> {
    let guard;
    try {
      guard = await this.#mutex.acquire(
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch (error) {
      if (error instanceof SqliteMutexTimeoutError) {
        throw rateLimitError(
          "timed out waiting for the shared arXiv API gate",
          "retry the exact command after the current request finishes",
        );
      }
      if (error instanceof SqliteMutexAbortedError) {
        throw error;
      }
      throw error;
    }

    try {
      const breaker = this.#readBreaker();
      const wallNow = this.#wallNowMs();
      if (breaker.openUntil > wallNow) {
        throw new CircuitBreakerOpenError(breaker.openUntil);
      }
      if (breaker.openUntil > 0) {
        this.#onDebug?.("circuit breaker half-open trial");
      }

      await this.#pace(options.signal);

      try {
        const value = await operation();
        this.#recordOutcome(options.classifyValue(value), breaker);
        guard.commit();
        return value;
      } catch (error) {
        this.#recordOutcome(options.classifyError(error), breaker);
        guard.commit();
        throw error;
      }
    } catch (error) {
      guard.rollback();
      throw error;
    }
  }

  peekOpenUntil(): number {
    return this.#readBreaker().openUntil;
  }

  async #pace(signal: AbortSignal | undefined): Promise<void> {
    const nowNs = this.#monotonicNowNs();
    const prior = this.#readPacing();
    let waitMs = 0;

    if (prior !== undefined) {
      try {
        const priorNs = BigInt(prior.monotonicNs);
        if (priorNs > nowNs) {
          waitMs = this.#intervalMs;
          this.#onDebug?.("saved monotonic clock is ahead; waiting a full interval");
        } else {
          const elapsedMs = Number(nowNs - priorNs) / 1_000_000;
          waitMs = Math.max(0, this.#intervalMs - elapsedMs);
        }
      } catch {
        waitMs = this.#intervalMs;
        this.#onDebug?.("malformed pacing state; waiting a full interval");
      }
    }

    if (waitMs > 0) {
      this.#onWait?.(`rate limited by export.arxiv.org, waiting ${formatSeconds(waitMs)}`);
      await this.#sleep(waitMs, signal);
    }

    const state: PacingState = {
      monotonicNs: this.#monotonicNowNs().toString(),
      wallMs: this.#wallNowMs(),
    };
    atomicWrite(this.#paths.lastRequestStart, JSON.stringify(state));
  }

  #readPacing(): PacingState | undefined {
    if (!existsSync(this.#paths.lastRequestStart)) {
      return undefined;
    }
    try {
      const value = JSON.parse(readFileSync(this.#paths.lastRequestStart, "utf8")) as unknown;
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as PacingState).monotonicNs !== "string" ||
        typeof (value as PacingState).wallMs !== "number"
      ) {
        return { monotonicNs: "invalid", wallMs: 0 };
      }
      return value as PacingState;
    } catch {
      return { monotonicNs: "invalid", wallMs: 0 };
    }
  }

  #readBreaker(): BreakerState {
    if (!existsSync(this.#paths.breaker)) {
      return { v: 1, consecutiveFailures: 0, openUntil: 0 };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.#paths.breaker, "utf8")) as Partial<BreakerState>;
      if (
        parsed.v !== 1 ||
        !Number.isSafeInteger(parsed.consecutiveFailures) ||
        (parsed.consecutiveFailures ?? -1) < 0 ||
        !Number.isFinite(parsed.openUntil) ||
        (parsed.openUntil ?? -1) < 0
      ) {
        throw new Error("invalid breaker fields");
      }
      return parsed as BreakerState;
    } catch {
      const failClosed: BreakerState = {
        v: 1,
        consecutiveFailures: this.#breakerThreshold,
        openUntil: this.#wallNowMs() + this.#breakerOpenMs,
      };
      this.#onDebug?.("malformed breaker state; opening fail-closed");
      atomicWrite(this.#paths.breaker, JSON.stringify(failClosed));
      return failClosed;
    }
  }

  #recordOutcome(outcome: GateOutcome, prior: BreakerState): void {
    if (outcome.kind === "neutral") {
      return;
    }
    if (outcome.kind === "success") {
      if (prior.consecutiveFailures > 0 || prior.openUntil > 0) {
        this.#onDebug?.("circuit breaker closed");
      }
      atomicWrite(
        this.#paths.breaker,
        JSON.stringify({ v: 1, consecutiveFailures: 0, openUntil: 0 } satisfies BreakerState),
      );
      return;
    }

    const consecutiveFailures = prior.consecutiveFailures + 1;
    const retryDeadline = this.#wallNowMs() + (outcome.retryAfterMs ?? 0);
    const shouldOpen = consecutiveFailures >= this.#breakerThreshold;
    const openUntil = shouldOpen
      ? Math.max(this.#wallNowMs() + this.#breakerOpenMs, retryDeadline)
      : 0;
    if (openUntil > 0) {
      this.#onDebug?.(`circuit breaker opened until ${new Date(openUntil).toISOString()}`);
    }
    atomicWrite(
      this.#paths.breaker,
      JSON.stringify({ v: 1, consecutiveFailures, openUntil } satisfies BreakerState),
    );
  }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let file: number | undefined;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeSync(file, content);
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (file !== undefined) {
      closeSync(file);
    }
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function formatSeconds(milliseconds: number): string {
  return `${Math.max(0.1, Math.ceil(milliseconds / 100) / 10).toFixed(1)}s`;
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal === undefined) {
      return;
    }
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}
