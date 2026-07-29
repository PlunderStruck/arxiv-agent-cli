import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { localStateError } from "./errors.js";

const DEFAULT_BUSY_TIMEOUT_MS = 250;
const DEFAULT_ACQUISITION_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MIN_MS = 10;
const DEFAULT_RETRY_DELAY_MAX_MS = 40;

export interface SqliteMutexOptions {
  readonly databasePath: string;
  readonly busyTimeoutMs?: number;
  readonly acquisitionTimeoutMs?: number;
  readonly retryDelayMinMs?: number;
  readonly retryDelayMaxMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly onWait?: (elapsedMs: number) => void;
}

export interface AcquireOptions {
  readonly signal?: AbortSignal;
}

export class SqliteMutexTimeoutError extends Error {
  readonly code = "SQLITE_MUTEX_TIMEOUT";

  constructor(
    readonly databasePath: string,
    readonly timeoutMs: number,
  ) {
    super(`timed out acquiring SQLite mutex after ${timeoutMs} ms: ${databasePath}`);
    this.name = "SqliteMutexTimeoutError";
  }
}

export class SqliteMutexAbortedError extends Error {
  readonly code = "SQLITE_MUTEX_ABORTED";

  constructor(readonly databasePath: string, options?: ErrorOptions) {
    super(`aborted while acquiring SQLite mutex: ${databasePath}`, options);
    this.name = "SqliteMutexAbortedError";
  }
}

export class SqliteMutexGuard {
  #database: DatabaseSync | undefined;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  get released(): boolean {
    return this.#database === undefined;
  }

  commit(): void {
    this.#release("COMMIT");
  }

  rollback(): void {
    this.#release("ROLLBACK");
  }

  [Symbol.dispose](): void {
    this.rollback();
  }

  #release(statement: "COMMIT" | "ROLLBACK"): void {
    const database = this.#database;
    if (database === undefined) {
      return;
    }

    this.#database = undefined;
    try {
      database.exec(statement);
    } finally {
      database.close();
    }
  }
}

export class SqliteMutex {
  readonly #databasePath: string;
  readonly #busyTimeoutMs: number;
  readonly #acquisitionTimeoutMs: number;
  readonly #retryDelayMinMs: number;
  readonly #retryDelayMaxMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #onWait: ((elapsedMs: number) => void) | undefined;

  constructor(options: SqliteMutexOptions) {
    this.#databasePath = validateDatabasePath(options.databasePath);
    this.#busyTimeoutMs = validateNonNegativeInteger(
      "busyTimeoutMs",
      options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    );
    this.#acquisitionTimeoutMs = validatePositiveInteger(
      "acquisitionTimeoutMs",
      options.acquisitionTimeoutMs ?? DEFAULT_ACQUISITION_TIMEOUT_MS,
    );
    this.#retryDelayMinMs = validateNonNegativeInteger(
      "retryDelayMinMs",
      options.retryDelayMinMs ?? DEFAULT_RETRY_DELAY_MIN_MS,
    );
    this.#retryDelayMaxMs = validateNonNegativeInteger(
      "retryDelayMaxMs",
      options.retryDelayMaxMs ?? DEFAULT_RETRY_DELAY_MAX_MS,
    );
    if (this.#retryDelayMaxMs < this.#retryDelayMinMs) {
      throw new RangeError("retryDelayMaxMs must be greater than or equal to retryDelayMinMs");
    }

    this.#now = options.now ?? (() => performance.now());
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? sleep;
    this.#onWait = options.onWait;

    mkdirSync(dirname(this.#databasePath), { recursive: true, mode: 0o700 });
  }

  get databasePath(): string {
    return this.#databasePath;
  }

  async acquire(options: AcquireOptions = {}): Promise<SqliteMutexGuard> {
    const signal = options.signal;
    throwIfAborted(signal, this.#databasePath);

    const startedAt = this.#now();
    const database = new DatabaseSync(this.#databasePath, {
      timeout: Math.min(this.#busyTimeoutMs, this.#acquisitionTimeoutMs),
    });

    try {
      let announcedWait = false;
      for (;;) {
        throwIfAborted(signal, this.#databasePath);

        try {
          database.exec("BEGIN IMMEDIATE");
          return new SqliteMutexGuard(database);
        } catch (error) {
          if (!isSqliteBusy(error)) {
            throw error;
          }
          if (!announcedWait) {
            announcedWait = true;
            this.#onWait?.(Math.max(0, this.#now() - startedAt));
          }
        }

        const elapsedMs = Math.max(0, this.#now() - startedAt);
        const remainingMs = this.#acquisitionTimeoutMs - elapsedMs;
        if (remainingMs <= 0) {
          throw new SqliteMutexTimeoutError(
            this.#databasePath,
            this.#acquisitionTimeoutMs,
          );
        }

        const retryDelayMs = Math.min(this.#nextRetryDelay(), remainingMs);
        await this.#sleep(retryDelayMs, signal);
      }
    } catch (error) {
      database.close();
      if (signal?.aborted && !(error instanceof SqliteMutexAbortedError)) {
        throw new SqliteMutexAbortedError(this.#databasePath, { cause: signal.reason });
      }
      throw error;
    }
  }

  #nextRetryDelay(): number {
    const width = this.#retryDelayMaxMs - this.#retryDelayMinMs;
    if (width === 0) {
      return this.#retryDelayMinMs;
    }
    return this.#retryDelayMinMs + Math.floor(this.#random() * (width + 1));
  }
}

export interface CoordinatorPaths {
  readonly root: string;
  readonly networkDatabase: string;
  readonly lastRequestStart: string;
  readonly breaker: string;
}

export function ensureCoordinatorPaths(
  uid: number | undefined = typeof process.getuid === "function"
    ? process.getuid()
    : undefined,
): CoordinatorPaths {
  if (uid === undefined) {
    throw localStateError(
      "cannot identify the current OS user",
      "run arxiv-agent-cli on macOS or Linux",
    );
  }
  const root = join(tmpdir(), `arxiv-agent-cli-${uid}`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw localStateError(
      `cannot create the shared coordinator directory ${root}`,
      "check the local temporary directory permissions",
      { cause: error },
    );
  }
  return {
    root,
    networkDatabase: join(root, "network.sqlite"),
    lastRequestStart: join(root, "last-request-start"),
    breaker: join(root, "breaker.json"),
  };
}

export function libraryMutexDatabasePath(
  canonicalLibraryRoot: string,
  coordinator = ensureCoordinatorPaths(),
): string {
  const digest = createHash("sha256").update(canonicalLibraryRoot).digest("hex");
  return join(coordinator.root, `library-${digest}.sqlite`);
}

export async function withSqliteMutex<T>(
  mutex: SqliteMutex,
  work: () => Promise<T>,
  options: AcquireOptions = {},
): Promise<T> {
  const guard = await mutex.acquire(options);

  try {
    const result = await work();
    guard.commit();
    return result;
  } catch (workError) {
    try {
      guard.rollback();
    } catch (releaseError) {
      throw new AggregateError(
        [workError, releaseError],
        "work failed and the SQLite mutex could not roll back",
      );
    }
    throw workError;
  }
}

function validateDatabasePath(databasePath: string): string {
  if (databasePath.length === 0 || databasePath === ":memory:") {
    throw new TypeError("databasePath must name a file-backed SQLite database");
  }
  return databasePath;
}

function validatePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateNonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined, databasePath: string): void {
  if (signal?.aborted) {
    throw new SqliteMutexAbortedError(databasePath, { cause: signal.reason });
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const sqliteError = error as Error & {
    readonly code?: unknown;
    readonly errcode?: unknown;
  };

  return (
    sqliteError.errcode === 5 ||
    sqliteError.errcode === 6 ||
    (sqliteError.code === "ERR_SQLITE_ERROR" &&
      /(?:database|table) is locked/i.test(sqliteError.message))
  );
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);

    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }

    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    }

    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
