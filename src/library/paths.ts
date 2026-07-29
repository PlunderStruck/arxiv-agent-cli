import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { localStateError, usageError } from "../errors.js";

const MODERN_ID = /^(\d{2})(\d{2})\.(\d{4,5})(?:v([1-9]\d*))?$/;
const LEGACY_ID = /^([A-Za-z][A-Za-z.-]*\/\d{7})(?:v([1-9]\d*))?$/;

export interface ParsedArxivId {
  readonly input: string;
  readonly baseId: string;
  readonly version: number | undefined;
  readonly exactId: string | undefined;
  readonly legacy: boolean;
}

export interface LibraryPaths {
  readonly root: string;
  readonly papers: string;
  readonly temporary: string;
  readonly trash: string;
  readonly cacheQueries: string;
  readonly index: string;
}

export function parseArxivId(input: string): ParsedArxivId {
  const trimmed = input.trim();
  const modernCandidate = MODERN_ID.exec(trimmed);
  const modern = modernCandidate !== null && validModernIdDateAndSerial(modernCandidate)
    ? modernCandidate
    : null;
  const legacy = LEGACY_ID.exec(trimmed);
  const match = modern ?? legacy;

  if (match === null) {
    throw usageError(
      `invalid arXiv ID ${JSON.stringify(input)}`,
      "use a modern ID such as 2211.17192v2 or a legacy ID such as math.GT/0309136",
    );
  }

  const baseId = modern === null
    ? match[1]
    : `${match[1] ?? ""}${match[2] ?? ""}.${match[3] ?? ""}`;
  if (baseId === undefined) {
    throw new Error("validated arXiv ID did not contain a base ID");
  }
  const rawVersion = modern === null ? match[2] : match[4];
  const version = rawVersion === undefined ? undefined : Number(rawVersion);

  return {
    input: trimmed,
    baseId,
    version,
    exactId: version === undefined ? undefined : `${baseId}v${version}`,
    legacy: legacy !== null,
  };
}

function validModernIdDateAndSerial(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const serial = match[3] ?? "";
  if (!Number.isSafeInteger(year) || month < 1 || month > 12) {
    return false;
  }
  const date = year * 100 + month;
  if (date < 704) {
    return false;
  }
  return date >= 1501 ? serial.length === 5 : serial.length === 4;
}

export function exactArxivId(baseId: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError("version must be a positive safe integer");
  }
  const parsed = parseArxivId(baseId);
  if (parsed.version !== undefined) {
    throw new TypeError("baseId must not include a version");
  }
  return `${parsed.baseId}v${version}`;
}

export function idSlug(baseId: string): string {
  const parsed = parseArxivId(baseId);
  if (parsed.version !== undefined) {
    throw new TypeError("idSlug expects an unversioned ID");
  }
  return parsed.baseId.replace("/", "_");
}

export function titleSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug.length === 0 ? "paper" : slug;
}

export function paperFilename(baseId: string, version: number, title: string): string {
  return `${idSlug(baseId)}v${version}-${titleSlug(title)}.pdf`;
}

export function safeLibraryFile(directory: string, filename: string): string {
  if (filename !== basename(filename) || filename.includes("\0")) {
    throw localStateError(
      `unsafe library filename ${JSON.stringify(filename)}`,
      "run `arxiv library repair`",
    );
  }
  const parent = resolve(directory);
  const candidate = resolve(parent, filename);
  if (!candidate.startsWith(`${parent}${sep}`)) {
    throw localStateError(
      `library path escaped its directory: ${filename}`,
      "run `arxiv library repair`",
    );
  }
  return candidate;
}

export function decodePaperFilename(filename: string): {
  readonly baseId: string;
  readonly version: number;
} {
  const match = /^(.*)v([1-9]\d*)-[a-z0-9][a-z0-9-]*\.pdf$/.exec(filename);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw localStateError(
      `unrecognized paper filename ${JSON.stringify(filename)}`,
      "move the file out of the library or run `arxiv library repair`",
    );
  }
  const encodedId = match[1];
  const candidate = encodedId.includes("_")
    ? encodedId.replace("_", "/")
    : encodedId;
  const parsed = parseArxivId(candidate);
  if (parsed.version !== undefined || idSlug(parsed.baseId) !== encodedId) {
    throw localStateError(
      `paper filename contains an invalid arXiv ID: ${filename}`,
      "move the file out of the library or run `arxiv library repair`",
    );
  }
  return { baseId: parsed.baseId, version: Number(match[2]) };
}

export function configuredLibraryRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["ARXIV_LIBRARY"];
  return resolve(configured === undefined || configured.length === 0
    ? join(homedir(), ".arxiv")
    : configured);
}

export async function ensureLibraryPaths(root: string): Promise<LibraryPaths> {
  const absolute = resolve(root);
  const papers = join(absolute, "papers");
  const temporary = join(papers, ".tmp");
  const trash = join(absolute, "trash");
  const cacheQueries = join(absolute, "cache", "queries");

  try {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(absolute);
    await ensureNestedDirectory(papers, canonicalRoot);
    await ensureNestedDirectory(temporary, canonicalRoot);
    await ensureNestedDirectory(trash, canonicalRoot);
    const cache = join(absolute, "cache");
    await ensureNestedDirectory(cache, canonicalRoot);
    await ensureNestedDirectory(cacheQueries, canonicalRoot);
  } catch (error) {
    throw localStateError(
      `cannot create library at ${absolute}`,
      "set ARXIV_LIBRARY to a writable local directory",
      { cause: error },
    );
  }

  return {
    root: absolute,
    papers,
    temporary,
    trash,
    cacheQueries,
    index: join(absolute, "index.jsonl"),
  };
}

async function ensureNestedDirectory(path: string, canonicalRoot: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const canonical = await realpath(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !canonical.startsWith(`${canonicalRoot}${sep}`)
  ) {
    throw new Error(`library component is not a real directory inside its root: ${path}`);
  }
}

export async function canonicalLibraryRoot(root: string): Promise<string> {
  const paths = await ensureLibraryPaths(root);
  return await realpath(paths.root);
}
