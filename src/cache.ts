import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const CACHE_MAX_ENTRIES = 2_000;
export const CACHE_MAX_BYTES = 256 * 1024 * 1024;

interface StoredCacheEntry<T> {
  readonly v: 1;
  readonly key: string;
  readonly fetchedAt: number;
  readonly accessedAt: number;
  readonly value: T;
}

export interface CacheHit<T> {
  readonly value: T;
  readonly fetchedAt: number;
  readonly ageMs: number;
  readonly stale: boolean;
}

export interface CachedPaperSuggestion {
  readonly id: string;
  readonly exactId: string;
  readonly title: string;
  readonly distance: number;
}

export interface QueryCacheOptions {
  readonly directory: string;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

export class QueryCache {
  readonly #directory: string;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #now: () => number;

  constructor(options: QueryCacheOptions) {
    this.#directory = options.directory;
    this.#ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.#maxEntries = options.maxEntries ?? CACHE_MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? CACHE_MAX_BYTES;
    this.#now = options.now ?? Date.now;
  }

  async get<T>(key: string, includeStale = false): Promise<CacheHit<T> | undefined> {
    const path = this.#path(key);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as StoredCacheEntry<T>;
      if (
        parsed.v !== 1 ||
        parsed.key !== key ||
        !Number.isFinite(parsed.fetchedAt) ||
        !("value" in parsed)
      ) {
        throw new Error("invalid cache entry");
      }
      const ageMs = Math.max(0, this.#now() - parsed.fetchedAt);
      const stale = ageMs > this.#ttlMs;
      if (stale && !includeStale) {
        return undefined;
      }
      await this.#write(path, {
        ...parsed,
        accessedAt: this.#now(),
      });
      return { value: parsed.value, fetchedAt: parsed.fetchedAt, ageMs, stale };
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      await rm(path, { force: true });
      return undefined;
    }
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.putMany([{ key, value }]);
  }

  async putMany(
    entries: readonly { readonly key: string; readonly value: unknown }[],
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const now = this.#now();
    for (const entry of entries) {
      await this.#write(this.#path(entry.key), {
        v: 1,
        key: entry.key,
        fetchedAt: now,
        accessedAt: now,
        value: entry.value,
      } satisfies StoredCacheEntry<unknown>);
    }
    await this.#sweep();
  }

  async suggestPapers(input: string, limit = 3): Promise<readonly CachedPaperSuggestion[]> {
    let names: string[];
    try {
      names = (await readdir(this.#directory)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      return isMissing(error) ? [] : Promise.reject(error);
    }
    const papers = new Map<string, CachedPaperSuggestion>();
    for (const name of names) {
      try {
        const stored = JSON.parse(
          await readFile(join(this.#directory, name), "utf8"),
        ) as Partial<StoredCacheEntry<unknown>>;
        for (const paper of paperLikeValues(stored.value)) {
          const distance = Math.min(
            levenshtein(input, paper.id),
            levenshtein(input, paper.exactId),
          );
          const prior = papers.get(paper.exactId);
          if (prior === undefined || distance < prior.distance) {
            papers.set(paper.exactId, { ...paper, distance });
          }
        }
      } catch {
        // Suggestions are best-effort; normal cache reads delete corrupt entries.
      }
    }
    return [...papers.values()]
      .filter((paper) =>
        paper.distance <= 3 ||
        paper.id.startsWith(input) ||
        input.startsWith(paper.id.slice(0, Math.max(1, input.length - 2))))
      .sort((left, right) =>
        left.distance - right.distance || left.exactId.localeCompare(right.exactId))
      .slice(0, Math.max(0, limit));
  }

  #path(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(this.#directory, `${digest}.json`);
  }

  async #write(path: string, value: unknown): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async #sweep(): Promise<void> {
    const names = (await readdir(this.#directory)).filter((name) => name.endsWith(".json"));
    const candidates = await Promise.all(
      names.map(async (name) => {
        const path = join(this.#directory, name);
        let info;
        try {
          info = await stat(path);
        } catch (error) {
          if (isMissing(error)) {
            return undefined;
          }
          throw error;
        }
        let accessedAt = info.mtimeMs;
        try {
          const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoredCacheEntry<unknown>>;
          if (Number.isFinite(parsed.accessedAt)) {
            accessedAt = parsed.accessedAt as number;
          }
        } catch {
          // Corrupt entries are oldest and are removed first.
          accessedAt = 0;
        }
        return { path, bytes: info.size, accessedAt };
      }),
    );
    const entries = candidates.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== undefined,
    );
    entries.sort((left, right) => left.accessedAt - right.accessedAt);
    let count = entries.length;
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries) {
      if (count <= this.#maxEntries && bytes <= this.#maxBytes) {
        break;
      }
      await rm(entry.path, { force: true });
      count -= 1;
      bytes -= entry.bytes;
    }
  }
}

function paperLikeValues(value: unknown): Array<{
  readonly id: string;
  readonly exactId: string;
  readonly title: string;
}> {
  const candidates: unknown[] = [];
  if (typeof value === "object" && value !== null) {
    candidates.push(value);
    const entries = (value as { readonly entries?: unknown }).entries;
    if (Array.isArray(entries)) {
      candidates.push(...entries);
    }
  }
  return candidates.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      return [];
    }
    const paper = candidate as {
      readonly id?: unknown;
      readonly exactId?: unknown;
      readonly title?: unknown;
    };
    return typeof paper.id === "string" &&
      typeof paper.exactId === "string" &&
      typeof paper.title === "string"
      ? [{ id: paper.id, exactId: paper.exactId, title: paper.title }]
      : [];
  });
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = (previous[rightIndex - 1] ?? 0) +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        substitution,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? left.length;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
