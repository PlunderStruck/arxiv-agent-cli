import type { PaperMetadata } from "./arxiv/atom.js";
import type { GetCommandResult } from "./commands/get.js";
import type { SearchCommandResult, SearchResultEntry } from "./commands/search.js";
import type { TextCommandResult } from "./commands/text.js";
import type { LibraryEntry, LibraryList } from "./library/store.js";

export const SEARCH_ABSTRACT_CHARS = 180;
export const GET_OUTPUT_CHARS = 20_000;
export const TEXT_OUTPUT_CHARS = 30_000;

export type SearchPresentation = "compact" | "titles" | "full";

export interface RenderOptions {
  readonly json: boolean;
  readonly cliVersion: string;
}

interface TruncatedField {
  readonly field: string;
  readonly totalChars: number;
  readonly shownChars: number;
}

export function renderSearch(
  result: SearchCommandResult,
  presentation: SearchPresentation,
  query: string,
  offset: number,
  sort: string,
  options: RenderOptions,
): string {
  if (options.json) {
    const truncatedFields: TruncatedField[] = [];
    const results = result.entries.map((entry, index) => {
      const metadata = entry.metadata;
      const summaryLimit = presentation === "titles"
        ? 0
        : presentation === "full"
          ? metadata.summary.length
          : SEARCH_ABSTRACT_CHARS;
      const summary = truncateText(metadata.summary, summaryLimit);
      if (summary.shown.length < metadata.summary.length) {
        truncatedFields.push({
          field: `results[${index}].summary`,
          totalChars: metadata.summary.length,
          shownChars: summary.shown.length,
        });
      }
      return {
        id: metadata.id,
        latestVersion: metadata.version,
        exactId: metadata.exactId,
        title: metadata.title,
        ...(presentation === "titles" ? {} : { summary: summary.shown }),
        authors: metadata.authors,
        primaryCategory: metadata.primaryCategory,
        categories: metadata.categories,
        publishedAt: metadata.publishedAt,
        updatedAt: metadata.updatedAt,
        cachedVersions: entry.cached.map((item) => item.record.version),
        cacheState: libraryState(entry),
        paths: entry.cached.map((item) => item.path),
        metadataSource: result.source,
      };
    });
    return json({
      schemaVersion: 1,
      cliVersion: options.cliVersion,
      results,
      total: result.feed.total,
      shown: results.length,
      offset,
      sort,
      metadataSource: result.source,
      stale: result.source === "stale",
      cacheAgeMs: result.cacheAgeMs ?? null,
      outputTruncated: truncatedFields.length > 0,
      truncatedFields,
    });
  }

  if (result.entries.length === 0) {
    return [
      "0 results.",
      "  arXiv matches literal technical terms; rephrase or broaden the query.",
      `  try: arxiv search ${JSON.stringify(query)} --titles-only --limit 20`,
    ].join("\n");
  }

  const blocks = result.entries.map((entry) =>
    renderSearchEntry(entry, presentation));
  const shown = result.entries.length;
  const footer = [
    `${shown} of ${result.feed.total} · ${sort} · ${sourceLabel(result.source, result.cacheAgeMs)}`,
  ];
  if (result.feed.total > 10_000) {
    footer.push("  query is under-constrained; add --category, --author, --title, or --since");
  }
  if (offset + shown < result.feed.total) {
    footer.push(
      `  more:       arxiv search ${JSON.stringify(query)} --offset ${offset + shown}`,
    );
  }
  if (presentation !== "titles") {
    footer.push(
      `  cheap scan: arxiv search ${JSON.stringify(query)} --limit 40 --titles-only`,
    );
  }
  const first = result.entries[0];
  if (first !== undefined) {
    footer.push(`  abstract:   arxiv get ${first.metadata.id}`);
  }
  return `${blocks.join("\n\n")}\n\n${footer.join("\n")}`;
}

export function renderGet(result: GetCommandResult, options: RenderOptions): string {
  const bounded = boundedMetadata(result.metadata);
  const cachedVersions = result.cached.map((item) => item.record.version);
  if (options.json) {
    return fitJson(
      {
        schemaVersion: 1,
        cliVersion: options.cliVersion,
        result: {
          ...bounded.value,
          cachedVersions,
          cacheState: cachedVersions.length === 0
            ? "absent"
            : cachedVersions.includes(result.metadata.version)
              ? "current"
              : "stale",
          paths: result.cached.map((item) => item.path),
          metadataSource: result.source,
        },
        stale: result.source === "stale",
        cacheAgeMs: result.cacheAgeMs ?? null,
        outputTruncated: bounded.truncated.length > 0,
        truncatedFields: bounded.truncated,
      },
      GET_OUTPUT_CHARS,
    );
  }

  const metadata = bounded.value;
  const authors = metadata.authors.map((author) => author.name).join(", ");
  const lines = [
    `${metadata.exactId} · ${metadata.publishedAt.slice(0, 7)} · ${metadata.primaryCategory}${librarySuffix(result.cached, result.metadata.version)}`,
    metadata.title,
    authors,
    "",
    metadata.summary,
  ];
  if (metadata.comment !== null) {
    lines.push("", `comment: ${metadata.comment}`);
  }
  lines.push(
    "",
    `metadata: ${result.source}`,
    `download: arxiv download ${metadata.exactId}`,
  );
  if (bounded.truncated.length > 0) {
    for (const field of bounded.truncated) {
      lines.push(
        `[${field.field}: ${field.totalChars} chars, ${field.shownChars} shown]`,
      );
    }
  }
  return truncateText(lines.join("\n"), GET_OUTPUT_CHARS).shown;
}

export function renderDownload(entries: readonly LibraryEntry[]): string {
  return entries
    .map((entry) =>
      [
        `downloaded: ${entry.exactId} "${entry.record.title}"`,
        `  ${entry.path} · ${formatBytes(entry.record.bytes)} · ${entry.record.pages} pages`,
        `  read: arxiv text ${entry.exactId} --pages 1-3`,
      ].join("\n"))
    .join("\n");
}

export function renderText(result: TextCommandResult, options: RenderOptions): string {
  const budget = options.json ? TEXT_OUTPUT_CHARS - 1_500 : TEXT_OUTPUT_CHARS - 300;
  const bounded = truncateText(result.text, budget);
  const truncated = bounded.shown.length < result.text.length;
  if (options.json) {
    return fitJson(
      {
        schemaVersion: 1,
        cliVersion: options.cliVersion,
        id: result.entry.record.id,
        exactId: result.entry.exactId,
        pages: { start: result.range.start, end: result.range.end },
        totalPages: result.totalPages,
        text: bounded.shown,
        outputTruncated: truncated,
        truncatedFields: truncated
          ? [{
              field: "text",
              totalChars: result.text.length,
              shownChars: bounded.shown.length,
            }]
          : [],
      },
      TEXT_OUTPUT_CHARS,
    );
  }
  const header = `${result.entry.exactId} · pages ${result.range.start}-${result.range.end} of ${result.totalPages}`;
  const suffix = truncated
    ? `\n\n[${result.text.length} chars, ${bounded.shown.length} shown]\n  narrower: arxiv text ${result.entry.exactId} --pages ${result.range.start}-${result.range.start}`
    : "";
  return `${header}\n\n${bounded.shown}${suffix}`;
}

export function renderLibraryList(
  result: LibraryList,
  offset: number,
  options: RenderOptions,
): string {
  if (options.json) {
    return json({
      schemaVersion: 1,
      cliVersion: options.cliVersion,
      results: result.entries.map((entry) => libraryJson(entry)),
      total: result.total,
      shown: result.entries.length,
      offset,
      nextOffset: offset + result.entries.length < result.total
        ? offset + result.entries.length
        : null,
      outputTruncated: false,
      truncatedFields: [],
    });
  }
  if (result.entries.length === 0) {
    return "Library is empty.\n  add: arxiv download <id>";
  }
  const lines = result.entries.map((entry) =>
    `${entry.exactId} · ${entry.record.primaryCategory || "metadata incomplete"}\n  ${entry.record.title}\n  ${entry.path}`);
  lines.push(`${result.entries.length} of ${result.total}`);
  if (offset + result.entries.length < result.total) {
    lines.push(`  more: arxiv library list --offset ${offset + result.entries.length}`);
  }
  return lines.join("\n\n");
}

export function renderRemoved(entry: LibraryEntry): string {
  return [
    `removed: ${entry.exactId} "${entry.record.title}"`,
    `  trashed (7d): ${entry.path}`,
    `  undo: arxiv library restore ${entry.exactId}`,
  ].join("\n");
}

export function renderRestored(entry: LibraryEntry): string {
  return [
    `restored: ${entry.exactId} "${entry.record.title}"`,
    `  ${entry.path}`,
  ].join("\n");
}

function renderSearchEntry(
  entry: SearchResultEntry,
  presentation: SearchPresentation,
): string {
  const metadata = entry.metadata;
  const authors = authorSummary(metadata);
  const lines = [
    `${metadata.exactId} · ${metadata.publishedAt.slice(0, 7)} · ${metadata.primaryCategory}${librarySuffix(entry.cached, metadata.version)}`,
    `  ${metadata.title}`,
    `  ${authors}`,
  ];
  if (presentation !== "titles") {
    const limit = presentation === "full" ? metadata.summary.length : SEARCH_ABSTRACT_CHARS;
    const summary = truncateText(metadata.summary, limit);
    lines.push(`  ${summary.shown}`);
    if (summary.shown.length < metadata.summary.length) {
      lines[lines.length - 1] +=
        ` [${metadata.summary.length} chars, ${summary.shown.length} shown]`;
    }
  }
  for (const cached of entry.cached) {
    lines.push(`  ${cached.path} · ${cached.record.pages} pages`);
  }
  return lines.join("\n");
}

function boundedMetadata(metadata: PaperMetadata): {
  readonly value: PaperMetadata;
  readonly truncated: readonly TruncatedField[];
} {
  const truncated: TruncatedField[] = [];
  const cut = (field: string, value: string, limit: number): string => {
    const bounded = truncateText(value, limit);
    if (bounded.shown.length < value.length) {
      truncated.push({
        field,
        totalChars: value.length,
        shownChars: bounded.shown.length,
      });
    }
    return bounded.shown;
  };
  const authors = metadata.authors.slice(0, 20).map((author, index) => ({
    name: cut(`authors[${index}].name`, author.name, 150),
    affiliation: author.affiliation === null
      ? null
      : cut(`authors[${index}].affiliation`, author.affiliation, 150),
  }));
  if (authors.length < metadata.authors.length) {
    truncated.push({
      field: "authors",
      totalChars: metadata.authors.length,
      shownChars: authors.length,
    });
  }
  return {
    value: {
      ...metadata,
      title: cut("title", metadata.title, 500),
      summary: cut("summary", metadata.summary, 10_000),
      authors,
      primaryCategory: cut("primaryCategory", metadata.primaryCategory, 100),
      categories: metadata.categories
        .slice(0, 20)
        .map((category, index) => cut(`categories[${index}]`, category, 100)),
      comment: metadata.comment === null ? null : cut("comment", metadata.comment, 1_000),
      journalRef: metadata.journalRef === null
        ? null
        : cut("journalRef", metadata.journalRef, 1_000),
      abstractUrl: cut("abstractUrl", metadata.abstractUrl, 500),
      pdfUrl: cut("pdfUrl", metadata.pdfUrl, 500),
    },
    truncated,
  };
}

function truncateText(text: string, maximum: number): { readonly shown: string } {
  if (maximum <= 0) {
    return { shown: "" };
  }
  if (text.length <= maximum) {
    return { shown: text };
  }
  const candidate = text.slice(0, maximum);
  const boundary = candidate.search(/\s+\S*$/);
  const shown = boundary > Math.floor(maximum * 0.65)
    ? candidate.slice(0, boundary).trimEnd()
    : candidate.trimEnd();
  return { shown: `${shown}…` };
}

function authorSummary(metadata: PaperMetadata): string {
  const shown = metadata.authors.slice(0, 3).map((author) => author.name);
  const remaining = metadata.authors.length - shown.length;
  return `${shown.join(", ")}${remaining > 0 ? ` +${remaining}` : ""}`;
}

function librarySuffix(entries: readonly LibraryEntry[], latestVersion: number): string {
  if (entries.length === 0) {
    return "";
  }
  const versions = entries.map((entry) => entry.record.version);
  if (versions.includes(latestVersion)) {
    return " · in library";
  }
  return ` · in library ${versions.map((version) => `v${version}`).join(", ")} — v${latestVersion} available`;
}

function libraryState(entry: SearchResultEntry): "absent" | "current" | "stale" {
  const versions = entry.cached.map((item) => item.record.version);
  if (versions.length === 0) {
    return "absent";
  }
  return versions.includes(entry.metadata.version) ? "current" : "stale";
}

function sourceLabel(source: string, ageMs: number | undefined): string {
  if (source === "fresh") {
    return "live";
  }
  const age = ageMs === undefined ? "" : ` ${formatAge(ageMs)} ago`;
  return source === "stale" ? `⚠ stale${age}` : `↻ cached${age}`;
}

function formatAge(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function libraryJson(entry: LibraryEntry): object {
  return {
    id: entry.record.id,
    version: entry.record.version,
    exactId: entry.exactId,
    title: entry.record.title,
    authors: entry.record.authors,
    primaryCategory: entry.record.primaryCategory,
    categories: entry.record.categories,
    path: entry.path,
    bytes: entry.record.bytes,
    pages: entry.record.pages,
    metadataState: entry.record.metadataState,
    addedAt: entry.record.addedAt,
  };
}

function fitJson(value: Record<string, unknown>, maximum: number): string {
  const clone = structuredClone(value) as Record<string, unknown>;
  let encoded = json(clone);
  if (encoded.length <= maximum) {
    return encoded;
  }
  if (typeof clone["result"] === "object" && clone["result"] !== null) {
    const result = clone["result"] as Record<string, unknown>;
    if (typeof result["summary"] === "string") {
      const total = result["summary"].length;
      result["summary"] = truncateText(
        result["summary"],
        Math.max(100, total - (encoded.length - maximum) - 500),
      ).shown;
      clone["outputTruncated"] = true;
      const fields = Array.isArray(clone["truncatedFields"])
        ? clone["truncatedFields"] as TruncatedField[]
        : [];
      fields.push({
        field: "summary",
        totalChars: total,
        shownChars: (result["summary"] as string).length,
      });
      clone["truncatedFields"] = fields;
    }
    encoded = json(clone);
    if (encoded.length > maximum && Array.isArray(result["authors"])) {
      result["authors"] = result["authors"].slice(0, 5);
      clone["outputTruncated"] = true;
    }
    encoded = json(clone);
    if (encoded.length > maximum && typeof result["summary"] === "string") {
      result["summary"] = truncateText(
        result["summary"],
        Math.max(0, result["summary"].length - (encoded.length - maximum) - 500),
      ).shown;
    }
  }
  encoded = json(clone);
  if (encoded.length > maximum) {
    throw new Error(`bounded JSON renderer exceeded ${maximum} characters`);
  }
  return encoded;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
