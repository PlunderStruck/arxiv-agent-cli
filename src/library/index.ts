import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type { ArxivAuthor, PaperMetadata } from "../arxiv/atom.js";
import { localStateError } from "../errors.js";
import { exactArxivId, parseArxivId } from "./paths.js";

export const INDEX_EVENT_MAX_BYTES = 256 * 1024;
export const INDEX_COMPACT_AFTER_LINES = 5_000;

export type MetadataState = "complete" | "incomplete";

export interface LibraryRecord {
  readonly id: string;
  readonly version: number;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly pages: number;
  readonly title: string;
  readonly authors: readonly ArxivAuthor[];
  readonly primaryCategory: string;
  readonly categories: readonly string[];
  readonly publishedAt: string | null;
  readonly updatedAt: string | null;
  readonly summary: string;
  readonly doi: string | null;
  readonly journalRef: string | null;
  readonly comment: string | null;
  readonly metadataFetchedAt: string | null;
  readonly metadataState: MetadataState;
  readonly addedAt: string;
}

export interface AddEvent extends LibraryRecord {
  readonly v: 1;
  readonly op: "add";
}

export interface RemoveEvent {
  readonly v: 1;
  readonly op: "rm";
  readonly id: string;
  readonly version: number;
  readonly ts: string;
}

export interface RestoreEvent {
  readonly v: 1;
  readonly op: "restore";
  readonly id: string;
  readonly version: number;
  readonly file: string;
  readonly ts: string;
}

export type LibraryEvent = AddEvent | RemoveEvent | RestoreEvent;

export interface FoldedLibraryRecord {
  readonly record: LibraryRecord;
  readonly active: boolean;
  readonly removedAt: string | undefined;
}

export interface FoldedIndex {
  readonly records: ReadonlyMap<string, FoldedLibraryRecord>;
  readonly lineCount: number;
  readonly ignoredTornTail: boolean;
}

export class CorruptIndexError extends Error {
  constructor(
    readonly indexPath: string,
    readonly line: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${message} at ${indexPath}:${line}`, options);
    this.name = "CorruptIndexError";
  }
}

export class UnsupportedIndexVersionError extends CorruptIndexError {
  constructor(indexPath: string, line: number, readonly foundVersion: unknown) {
    super(
      indexPath,
      line,
      `index record version ${String(foundVersion)} is newer than this CLI understands`,
    );
    this.name = "UnsupportedIndexVersionError";
  }
}

export function recordFromMetadata(
  metadata: PaperMetadata,
  local: {
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly pages: number;
    readonly now: string;
  },
): LibraryRecord {
  return {
    id: metadata.id,
    version: metadata.version,
    file: local.file,
    bytes: local.bytes,
    sha256: local.sha256,
    pages: local.pages,
    title: metadata.title,
    authors: metadata.authors,
    primaryCategory: metadata.primaryCategory,
    categories: metadata.categories,
    publishedAt: metadata.publishedAt,
    updatedAt: metadata.updatedAt,
    summary: metadata.summary,
    doi: metadata.doi,
    journalRef: metadata.journalRef,
    comment: metadata.comment,
    metadataFetchedAt: local.now,
    metadataState: "complete",
    addedAt: local.now,
  };
}

export function readLibraryIndex(indexPath: string): FoldedIndex {
  if (!existsSync(indexPath)) {
    return { records: new Map(), lineCount: 0, ignoredTornTail: false };
  }
  const contents = readFileSync(indexPath);
  const endsWithNewline = contents.byteLength === 0 || contents.at(-1) === 0x0a;
  const rawLines = contents.toString("utf8").split("\n");
  if (endsWithNewline) {
    rawLines.pop();
  }

  const records = new Map<string, FoldedLibraryRecord>();
  let ignoredTornTail = false;

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? "";
    const lineNumber = index + 1;
    const isTornCandidate = !endsWithNewline && index === rawLines.length - 1;
    const bytes = Buffer.byteLength(rawLine);
    if (bytes > INDEX_EVENT_MAX_BYTES) {
      throw new CorruptIndexError(indexPath, lineNumber, "index event exceeds 256 KiB");
    }
    if (rawLine.length === 0) {
      if (isTornCandidate) {
        ignoredTornTail = true;
        continue;
      }
      throw new CorruptIndexError(indexPath, lineNumber, "empty index event");
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(rawLine);
    } catch (error) {
      if (isTornCandidate) {
        ignoredTornTail = true;
        continue;
      }
      throw new CorruptIndexError(indexPath, lineNumber, "malformed JSON event", {
        cause: error,
      });
    }

    try {
      const event = validateEvent(candidate, indexPath, lineNumber);
      foldEvent(records, event, indexPath, lineNumber);
    } catch (error) {
      if (
        isTornCandidate &&
        error instanceof CorruptIndexError &&
        !(error instanceof UnsupportedIndexVersionError)
      ) {
        ignoredTornTail = true;
        continue;
      }
      throw error;
    }
  }

  return {
    records,
    lineCount: rawLines.length - (ignoredTornTail ? 1 : 0),
    ignoredTornTail,
  };
}

export function appendLibraryEvent(indexPath: string, event: LibraryEvent): void {
  validateEvent(event, indexPath, 1);
  const encoded = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(encoded) > INDEX_EVENT_MAX_BYTES) {
    throw localStateError(
      "library index event exceeds 256 KiB",
      "shorten the paper metadata or run `arxiv library repair`",
    );
  }
  const handle = openSync(indexPath, "a", 0o600);
  try {
    const bytes = Buffer.from(encoded);
    const written = writeSync(handle, bytes, 0, bytes.byteLength);
    if (written !== bytes.byteLength) {
      throw new Error(`short index append: wrote ${written} of ${bytes.byteLength} bytes`);
    }
  } finally {
    closeSync(handle);
  }
}

export function compactLibraryIndex(
  indexPath: string,
  records: ReadonlyMap<string, FoldedLibraryRecord>,
): void {
  const events: LibraryEvent[] = [];
  for (const folded of [...records.values()].sort(compareFoldedRecords)) {
    events.push({ v: 1, op: "add", ...folded.record });
    if (!folded.active) {
      events.push({
        v: 1,
        op: "rm",
        id: folded.record.id,
        version: folded.record.version,
        ts: folded.removedAt ?? new Date(0).toISOString(),
      });
    }
  }
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  atomicReplace(indexPath, body.length === 0 ? "" : `${body}\n`);
}

export function backupIndex(indexPath: string, timestamp: string): string | undefined {
  if (!existsSync(indexPath)) {
    return undefined;
  }
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const backup = `${indexPath}.corrupt-${safeTimestamp}.bak`;
  copyFileSync(indexPath, backup);
  return backup;
}

function validateEvent(value: unknown, indexPath: string, line: number): LibraryEvent {
  if (typeof value !== "object" || value === null) {
    throw new CorruptIndexError(indexPath, line, "index event is not an object");
  }
  const event = value as Partial<LibraryEvent> & Record<string, unknown>;
  if (event["v"] !== 1) {
    throw new UnsupportedIndexVersionError(indexPath, line, event["v"]);
  }
  if (event["op"] !== "add" && event["op"] !== "rm" && event["op"] !== "restore") {
    throw new CorruptIndexError(indexPath, line, "unknown index operation");
  }
  const id = requiredString(event["id"], indexPath, line, "id");
  const parsed = parseArxivId(id);
  if (parsed.version !== undefined || parsed.baseId !== id) {
    throw new CorruptIndexError(indexPath, line, "index ID must be unversioned");
  }
  const version = requiredPositiveInteger(event["version"], indexPath, line, "version");
  exactArxivId(id, version);

  if (event["op"] === "add") {
    validateAddEvent(event, indexPath, line);
  } else if (event["op"] === "restore") {
    requiredString(event["file"], indexPath, line, "file");
    requiredString(event["ts"], indexPath, line, "ts");
  } else {
    requiredString(event["ts"], indexPath, line, "ts");
  }
  return event as unknown as LibraryEvent;
}

function validateAddEvent(
  event: Record<string, unknown>,
  indexPath: string,
  line: number,
): void {
  for (const field of ["file", "sha256", "title", "addedAt"]) {
    requiredString(event[field], indexPath, line, field);
  }
  if (typeof event["summary"] !== "string") {
    throw new CorruptIndexError(indexPath, line, "summary must be a string");
  }
  for (const field of ["bytes", "pages"]) {
    requiredNonNegativeInteger(event[field], indexPath, line, field);
  }
  if (!Array.isArray(event["authors"]) || !Array.isArray(event["categories"])) {
    throw new CorruptIndexError(indexPath, line, "authors and categories must be arrays");
  }
  if (event["metadataState"] !== "complete" && event["metadataState"] !== "incomplete") {
    throw new CorruptIndexError(indexPath, line, "unknown metadataState");
  }
}

function foldEvent(
  records: Map<string, FoldedLibraryRecord>,
  event: LibraryEvent,
  indexPath: string,
  line: number,
): void {
  const key = exactArxivId(event.id, event.version);
  if (event.op === "add") {
    const { v: _version, op: _operation, ...record } = event;
    records.set(key, { record, active: true, removedAt: undefined });
    return;
  }
  const prior = records.get(key);
  if (prior === undefined) {
    throw new CorruptIndexError(
      indexPath,
      line,
      `${event.op} event has no prior add for ${key}`,
    );
  }
  if (event.op === "rm") {
    records.set(key, { record: prior.record, active: false, removedAt: event.ts });
    return;
  }
  records.set(key, {
    record: { ...prior.record, file: event.file },
    active: true,
    removedAt: undefined,
  });
}

function atomicReplace(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeSync(handle, contents);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function requiredString(
  value: unknown,
  indexPath: string,
  line: number,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CorruptIndexError(indexPath, line, `${field} must be a nonempty string`);
  }
  return value;
}

function requiredPositiveInteger(
  value: unknown,
  indexPath: string,
  line: number,
  field: string,
): number {
  const number = requiredNonNegativeInteger(value, indexPath, line, field);
  if (number < 1) {
    throw new CorruptIndexError(indexPath, line, `${field} must be positive`);
  }
  return number;
}

function requiredNonNegativeInteger(
  value: unknown,
  indexPath: string,
  line: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CorruptIndexError(indexPath, line, `${field} must be a non-negative integer`);
  }
  return value as number;
}

function compareFoldedRecords(
  left: FoldedLibraryRecord,
  right: FoldedLibraryRecord,
): number {
  return (
    left.record.id.localeCompare(right.record.id) ||
    left.record.version - right.record.version
  );
}
