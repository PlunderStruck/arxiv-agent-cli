import { createHash, randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { getDocumentProxy } from "unpdf";

import type { PaperMetadata } from "../arxiv/atom.js";
import {
  libraryMutexDatabasePath,
  SqliteMutex,
  withSqliteMutex,
} from "../coordinator.js";
import { localStateError, notFoundError, usageError } from "../errors.js";
import {
  appendLibraryEvent,
  backupIndex,
  compactLibraryIndex,
  CorruptIndexError,
  type FoldedIndex,
  type FoldedLibraryRecord,
  INDEX_COMPACT_AFTER_LINES,
  type LibraryRecord,
  readLibraryIndex,
  recordFromMetadata,
  UnsupportedIndexVersionError,
} from "./index.js";
import {
  canonicalLibraryRoot,
  decodePaperFilename,
  ensureLibraryPaths,
  exactArxivId,
  type LibraryPaths,
  paperFilename,
  parseArxivId,
  safeLibraryFile,
} from "./paths.js";

const PART_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const TRASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface LibraryEntry {
  readonly record: LibraryRecord;
  readonly exactId: string;
  readonly path: string;
  readonly state: "live" | "trash";
}

export interface LibraryList {
  readonly total: number;
  readonly entries: readonly LibraryEntry[];
}

export interface LibraryStoreOptions {
  readonly root: string;
  readonly now?: () => Date;
}

interface DiscoveredFiles {
  readonly live: ReadonlyMap<string, string>;
  readonly trash: ReadonlyMap<string, string>;
}

export class LibraryStore {
  readonly #paths: LibraryPaths;
  readonly #mutex: SqliteMutex;
  readonly #now: () => Date;

  private constructor(paths: LibraryPaths, mutex: SqliteMutex, now: () => Date) {
    this.#paths = paths;
    this.#mutex = mutex;
    this.#now = now;
  }

  static async create(options: LibraryStoreOptions): Promise<LibraryStore> {
    const paths = await ensureLibraryPaths(options.root);
    const canonicalRoot = await canonicalLibraryRoot(paths.root);
    const mutex = new SqliteMutex({
      databasePath: libraryMutexDatabasePath(canonicalRoot),
      acquisitionTimeoutMs: 30_000,
    });
    const store = new LibraryStore(paths, mutex, options.now ?? (() => new Date()));
    await store.reconcile();
    return store;
  }

  get root(): string {
    return this.#paths.root;
  }

  get cacheDirectory(): string {
    return this.#paths.cacheQueries;
  }

  async reconcile(): Promise<void> {
    await withSqliteMutex(this.#mutex, async () => {
      await this.#reconcileLocked();
    });
  }

  async list(options: { readonly limit?: number; readonly offset?: number } = {}): Promise<LibraryList> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw usageError(
        "--limit for library list must be from 1 to 50",
        "use `arxiv library list --limit 50` for the widest scan",
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw usageError("--offset must be a non-negative integer", "use `--offset 0` or greater");
    }
    await this.reconcile();
    const folded = this.#readIndex();
    const entries = [...folded.records.values()]
      .filter((item) => item.active)
      .sort((left, right) => right.record.addedAt.localeCompare(left.record.addedAt))
      .map((item) => this.#entry(item, "live"));
    return {
      total: entries.length,
      entries: entries.slice(offset, offset + limit),
    };
  }

  async cachedVersions(baseId: string): Promise<readonly number[]> {
    const parsed = parseArxivId(baseId);
    await this.reconcile();
    return [...this.#readIndex().records.values()]
      .filter((item) => item.active && item.record.id === parsed.baseId)
      .map((item) => item.record.version)
      .sort((left, right) => left - right);
  }

  async membership(): Promise<ReadonlyMap<string, readonly LibraryEntry[]>> {
    await this.reconcile();
    const byBaseId = new Map<string, LibraryEntry[]>();
    for (const item of this.#readIndex().records.values()) {
      if (!item.active) {
        continue;
      }
      const entries = byBaseId.get(item.record.id) ?? [];
      entries.push(this.#entry(item, "live"));
      byBaseId.set(item.record.id, entries);
    }
    for (const entries of byBaseId.values()) {
      entries.sort((left, right) => left.record.version - right.record.version);
    }
    return byBaseId;
  }

  async resolveLive(id: string): Promise<LibraryEntry> {
    await this.reconcile();
    return this.#resolve(this.#readIndex(), id, true);
  }

  async resolveTrashed(id: string): Promise<LibraryEntry> {
    await this.reconcile();
    const entry = this.#resolve(this.#readIndex(), id, false);
    if (!(await pathExists(entry.path))) {
      throw notFoundError(
        `${id} is no longer in trash`,
        "download the paper again if it is still needed",
      );
    }
    return entry;
  }

  async addPdf(
    metadata: PaperMetadata,
    pdf: Buffer,
    options: {
      readonly metadataState?: "complete" | "incomplete";
      readonly metadataFetchedAt?: string | null;
    } = {},
  ): Promise<LibraryEntry> {
    const filename = paperFilename(metadata.id, metadata.version, metadata.title);
    const destination = safeLibraryFile(this.#paths.papers, filename);
    const temporary = safeLibraryFile(
      this.#paths.temporary,
      `${metadata.id.replace("/", "_")}v${metadata.version}.${process.pid}.${randomBytes(6).toString("hex")}.part`,
    );
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    const pages = await countPdfPages(pdf);
    const now = this.#now().toISOString();
    const relativeFile = relative(this.#paths.root, destination);
    const completeRecord = recordFromMetadata(metadata, {
      file: relativeFile,
      bytes: pdf.byteLength,
      sha256,
      pages,
      now,
    });
    const record: LibraryRecord = {
      ...completeRecord,
      metadataState: options.metadataState ?? "complete",
      metadataFetchedAt: options.metadataFetchedAt === undefined
        ? now
        : options.metadataFetchedAt,
    };

    await writeFile(temporary, pdf, { flag: "wx", mode: 0o600 });
    try {
      return await withSqliteMutex(this.#mutex, async () => {
        await this.#sweepLocked();
        await this.#reconcileLocked();
        const existing = this.#readIndex().records.get(metadata.exactId);
        if (existing?.active === true) {
          await rm(temporary, { force: true });
          return this.#entry(existing, "live");
        }
        if (existing !== undefined) {
          const oldTrash = safeLibraryFile(
            this.#paths.trash,
            basename(existing.record.file),
          );
          await rm(oldTrash, { force: true });
        }
        if (await pathExists(destination)) {
          throw localStateError(
            `paper destination already exists for ${metadata.exactId}`,
            "run `arxiv library repair`",
          );
        }

        await rename(temporary, destination);
        appendLibraryEvent(this.#paths.index, { v: 1, op: "add", ...record });
        await this.#compactIfNeeded();
        return {
          record,
          exactId: metadata.exactId,
          path: destination,
          state: "live",
        };
      });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async refreshMetadata(
    metadata: PaperMetadata,
    metadataFetchedAt: string,
  ): Promise<void> {
    await withSqliteMutex(this.#mutex, async () => {
      await this.#reconcileLocked();
      const folded = this.#readIndex();
      const existing = folded.records.get(metadata.exactId);
      if (existing?.active !== true) {
        return;
      }
      const refreshed: LibraryRecord = {
        ...recordFromMetadata(metadata, {
          file: existing.record.file,
          bytes: existing.record.bytes,
          sha256: existing.record.sha256,
          pages: existing.record.pages,
          now: metadataFetchedAt,
        }),
        addedAt: existing.record.addedAt,
      };
      appendLibraryEvent(this.#paths.index, { v: 1, op: "add", ...refreshed });
      await this.#compactIfNeeded();
    });
  }

  async remove(id: string): Promise<LibraryEntry> {
    return await withSqliteMutex(this.#mutex, async () => {
      await this.#sweepLocked();
      await this.#reconcileLocked();
      const folded = this.#readIndex();
      const entry = this.#resolve(folded, id, true);
      const filename = basename(entry.path);
      const destination = safeLibraryFile(this.#paths.trash, filename);
      if (await pathExists(destination)) {
        throw localStateError(
          `${entry.exactId} exists in both papers and trash`,
          "run `arxiv library repair`",
        );
      }
      await rename(entry.path, destination);
      appendLibraryEvent(this.#paths.index, {
        v: 1,
        op: "rm",
        id: entry.record.id,
        version: entry.record.version,
        ts: this.#now().toISOString(),
      });
      await this.#compactIfNeeded();
      return { ...entry, path: destination, state: "trash" };
    });
  }

  async restore(id: string): Promise<LibraryEntry> {
    return await withSqliteMutex(this.#mutex, async () => {
      await this.#sweepLocked();
      await this.#reconcileLocked();
      const folded = this.#readIndex();
      const entry = this.#resolve(folded, id, false);
      if (!(await pathExists(entry.path))) {
        throw notFoundError(
          `${id} is no longer in trash`,
          "download the paper again if it is still needed",
        );
      }
      const filename = basename(entry.path);
      const destination = safeLibraryFile(this.#paths.papers, filename);
      if (await pathExists(destination)) {
        throw localStateError(
          `${entry.exactId} exists in both papers and trash`,
          "run `arxiv library repair`",
        );
      }
      await rename(entry.path, destination);
      const file = relative(this.#paths.root, destination);
      appendLibraryEvent(this.#paths.index, {
        v: 1,
        op: "restore",
        id: entry.record.id,
        version: entry.record.version,
        file,
        ts: this.#now().toISOString(),
      });
      await this.#compactIfNeeded();
      return {
        record: { ...entry.record, file },
        exactId: entry.exactId,
        path: destination,
        state: "live",
      };
    });
  }

  async repair(): Promise<{ readonly backup: string | undefined; readonly recovered: number }> {
    return await withSqliteMutex(this.#mutex, async () => {
      let prior: FoldedIndex | undefined;
      try {
        prior = readLibraryIndex(this.#paths.index);
      } catch (error) {
        if (error instanceof UnsupportedIndexVersionError) {
          throw localStateError(
            error.message,
            "upgrade arxiv-agent-cli before running repair",
            { cause: error },
          );
        }
        if (!(error instanceof CorruptIndexError)) {
          throw error;
        }
      }

      const now = this.#now().toISOString();
      const backup = backupIndex(this.#paths.index, now);
      const discovered = await this.#discoverFiles();
      const records = new Map<string, FoldedLibraryRecord>();

      for (const [key, filename] of discovered.live) {
        const old = prior?.records.get(key);
        const record = old === undefined
          ? await this.#incompleteRecord(filename, "live", now)
          : await this.#refreshLocalFacts(old.record, filename, "live");
        records.set(key, { record, active: true, removedAt: undefined });
      }
      for (const [key, filename] of discovered.trash) {
        const old = prior?.records.get(key);
        const record = old === undefined
          ? await this.#incompleteRecord(filename, "trash", now)
          : await this.#refreshLocalFacts(old.record, filename, "trash");
        records.set(key, { record, active: false, removedAt: now });
      }
      compactLibraryIndex(this.#paths.index, records);
      return { backup, recovered: records.size };
    });
  }

  async readPdf(entry: LibraryEntry): Promise<Buffer> {
    if (entry.state !== "live") {
      throw new TypeError("cannot read a trashed paper");
    }
    const data = await readFile(entry.path);
    if (data.byteLength !== entry.record.bytes) {
      throw localStateError(
        `${entry.exactId} has changed size on disk`,
        "run `arxiv library repair` or download the paper again",
      );
    }
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== entry.record.sha256) {
      throw localStateError(
        `${entry.exactId} failed its checksum`,
        "remove and download the paper again",
      );
    }
    return data;
  }

  async #reconcileLocked(): Promise<void> {
    const folded = this.#readIndex();
    const discovered = await this.#discoverFiles();
    const now = this.#now().toISOString();
    let changed = false;

    for (const [key, filename] of discovered.live) {
      const prior = folded.records.get(key);
      if (prior === undefined) {
        const record = await this.#incompleteRecord(filename, "live", now);
        appendLibraryEvent(this.#paths.index, { v: 1, op: "add", ...record });
        changed = true;
      } else if (!prior.active) {
        appendLibraryEvent(this.#paths.index, {
          v: 1,
          op: "restore",
          id: prior.record.id,
          version: prior.record.version,
          file: join("papers", filename),
          ts: now,
        });
        changed = true;
      } else {
        await this.#validateRecordedFile(prior.record, filename, "live");
      }
    }

    for (const [key, filename] of discovered.trash) {
      const prior = folded.records.get(key);
      if (prior === undefined) {
        const record = await this.#incompleteRecord(filename, "trash", now);
        appendLibraryEvent(this.#paths.index, { v: 1, op: "add", ...record });
        appendLibraryEvent(this.#paths.index, {
          v: 1,
          op: "rm",
          id: record.id,
          version: record.version,
          ts: now,
        });
        changed = true;
      } else if (prior.active) {
        appendLibraryEvent(this.#paths.index, {
          v: 1,
          op: "rm",
          id: prior.record.id,
          version: prior.record.version,
          ts: now,
        });
        changed = true;
      } else {
        await this.#validateRecordedFile(prior.record, filename, "trash");
      }
    }

    for (const [key, item] of folded.records) {
      if (item.active && !discovered.live.has(key) && !discovered.trash.has(key)) {
        appendLibraryEvent(this.#paths.index, {
          v: 1,
          op: "rm",
          id: item.record.id,
          version: item.record.version,
          ts: now,
        });
        changed = true;
      }
    }

    if (changed) {
      await this.#compactIfNeeded();
    }
  }

  #readIndex(): FoldedIndex {
    try {
      return readLibraryIndex(this.#paths.index);
    } catch (error) {
      if (error instanceof UnsupportedIndexVersionError) {
        throw localStateError(
          error.message,
          "upgrade arxiv-agent-cli before reading or repairing this library",
          { cause: error },
        );
      }
      if (error instanceof CorruptIndexError) {
        throw localStateError(error.message, "run `arxiv library repair`", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async #discoverFiles(): Promise<DiscoveredFiles> {
    const live = await this.#mapDirectory(this.#paths.papers);
    const trash = await this.#mapDirectory(this.#paths.trash);
    for (const key of live.keys()) {
      if (trash.has(key)) {
        throw localStateError(
          `${key} exists in both papers and trash`,
          "run `arxiv library repair` after moving one duplicate aside",
        );
      }
    }
    return { live, trash };
  }

  async #mapDirectory(directory: string): Promise<ReadonlyMap<string, string>> {
    const map = new Map<string, string>();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".tmp") {
        continue;
      }
      if (!entry.isFile()) {
        throw localStateError(
          `unexpected library entry ${join(directory, entry.name)}`,
          "move it outside the library or run `arxiv library repair`",
        );
      }
      const decoded = decodePaperFilename(entry.name);
      const key = exactArxivId(decoded.baseId, decoded.version);
      if (map.has(key)) {
        throw localStateError(
          `multiple files claim ${key}`,
          "move the duplicate aside and run `arxiv library repair`",
        );
      }
      map.set(key, entry.name);
    }
    return map;
  }

  #resolve(index: FoldedIndex, id: string, live: boolean): LibraryEntry {
    const parsed = parseArxivId(id);
    const candidates = [...index.records.values()].filter(
      (item) =>
        item.active === live &&
        item.record.id === parsed.baseId &&
        (parsed.version === undefined || item.record.version === parsed.version),
    );
    if (candidates.length === 0) {
      throw notFoundError(
        `${id} is not ${live ? "in the library" : "in trash"}`,
        live
          ? `run \`arxiv download ${id}\``
          : "check `arxiv library list` or download the paper again",
      );
    }
    if (candidates.length > 1) {
      const commands = candidates
        .map((candidate) =>
          `arxiv library ${live ? "remove" : "restore"} ${exactArxivId(candidate.record.id, candidate.record.version)}`)
        .join("; ");
      throw usageError(
        `${id} matches multiple local versions`,
        `choose an exact version: ${commands}`,
      );
    }
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new Error("candidate disappeared");
    }
    return this.#entry(candidate, live ? "live" : "trash");
  }

  #entry(item: FoldedLibraryRecord, state: "live" | "trash"): LibraryEntry {
    const filename = basename(item.record.file);
    const directory = state === "live" ? this.#paths.papers : this.#paths.trash;
    return {
      record: item.record,
      exactId: exactArxivId(item.record.id, item.record.version),
      path: safeLibraryFile(directory, filename),
      state,
    };
  }

  async #incompleteRecord(
    filename: string,
    state: "live" | "trash",
    now: string,
  ): Promise<LibraryRecord> {
    const decoded = decodePaperFilename(filename);
    const directory = state === "live" ? this.#paths.papers : this.#paths.trash;
    const path = safeLibraryFile(directory, filename);
    const data = await readFile(path);
    const pages = await countPdfPages(data);
    const title = filename
      .replace(/^.*v[1-9]\d*-/, "")
      .replace(/\.pdf$/, "")
      .replace(/-/g, " ");
    return {
      id: decoded.baseId,
      version: decoded.version,
      file: join("papers", filename),
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      pages,
      title,
      authors: [],
      primaryCategory: "",
      categories: [],
      publishedAt: null,
      updatedAt: null,
      summary: "",
      doi: null,
      journalRef: null,
      comment: null,
      metadataFetchedAt: null,
      metadataState: "incomplete",
      addedAt: now,
    };
  }

  async #refreshLocalFacts(
    prior: LibraryRecord,
    filename: string,
    state: "live" | "trash",
  ): Promise<LibraryRecord> {
    const directory = state === "live" ? this.#paths.papers : this.#paths.trash;
    const data = await readFile(safeLibraryFile(directory, filename));
    return {
      ...prior,
      file: join("papers", filename),
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      pages: await countPdfPages(data),
    };
  }

  async #validateRecordedFile(
    record: LibraryRecord,
    filename: string,
    state: "live" | "trash",
  ): Promise<void> {
    const directory = state === "live" ? this.#paths.papers : this.#paths.trash;
    const info = await stat(safeLibraryFile(directory, filename));
    if (info.size !== record.bytes) {
      throw localStateError(
        `${exactArxivId(record.id, record.version)} has changed size on disk`,
        "run `arxiv library repair`",
      );
    }
  }

  async #sweepLocked(): Promise<void> {
    const now = this.#now().valueOf();
    await sweepOlderThan(this.#paths.temporary, PART_MAX_AGE_MS, now, () => true);
    await sweepOlderThan(
      this.#paths.trash,
      TRASH_MAX_AGE_MS,
      now,
      (name) => name.endsWith(".pdf"),
    );
  }

  async #compactIfNeeded(): Promise<void> {
    const folded = this.#readIndex();
    if (folded.lineCount > INDEX_COMPACT_AFTER_LINES) {
      compactLibraryIndex(this.#paths.index, folded.records);
    }
  }
}

async function countPdfPages(data: Uint8Array): Promise<number> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
    try {
      return pdf.numPages;
    } finally {
      await pdf.cleanup();
    }
  } catch (error) {
    throw localStateError(
      "PDF could not be opened to determine its page count",
      "download the paper again or move the invalid file aside",
      { cause: error },
    );
  }
}

async function sweepOlderThan(
  directory: string,
  maximumAgeMs: number,
  now: number,
  include: (name: string) => boolean,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !include(entry.name)) {
      continue;
    }
    const path = safeLibraryFile(directory, entry.name);
    const info = await stat(path);
    if (now - info.mtimeMs > maximumAgeMs) {
      await rm(path, { force: true });
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export function assertPathInsideLibrary(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (!resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw localStateError(
      `path escaped the library root: ${path}`,
      "run `arxiv library repair`",
    );
  }
}
