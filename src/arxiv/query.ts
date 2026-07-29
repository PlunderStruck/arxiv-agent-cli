import { usageError } from "../errors.js";

export type SearchSort = "relevance" | "submitted" | "updated";

export interface SearchQueryOptions {
  readonly query: string;
  readonly category?: string;
  readonly author?: string;
  readonly title?: string;
  readonly since?: string;
  readonly until?: string;
  readonly sort?: SearchSort;
  readonly limit?: number;
  readonly offset?: number;
}

const SORT_BY: Record<SearchSort, string> = {
  relevance: "relevance",
  submitted: "submittedDate",
  updated: "lastUpdatedDate",
};

export function buildSearchUrl(
  options: SearchQueryOptions,
  origin = new URL("https://export.arxiv.org/api/query"),
): URL {
  const limit = options.limit ?? 10;
  const offset = options.offset ?? 0;
  validateInteger("limit", limit, 1, 50);
  validateInteger("offset", offset, 0, 100_000);

  const expressions = [
    ...tokenize(options.query).map((term) => fieldExpression("all", term)),
    ...(options.title === undefined
      ? []
      : tokenize(options.title).map((term) => fieldExpression("ti", term))),
    ...(options.author === undefined
      ? []
      : tokenize(options.author).map((term) => fieldExpression("au", term))),
  ];

  if (options.category !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)?$/.test(options.category)) {
      throw usageError(
        `invalid arXiv category ${JSON.stringify(options.category)}`,
        "use a category such as cs.CL, cs.LG, stat.ML, or physics.optics",
      );
    }
    expressions.push(`cat:${options.category}`);
  }

  const dateExpression = buildDateExpression(options.since, options.until);
  if (dateExpression !== undefined) {
    expressions.push(dateExpression);
  }
  if (expressions.length === 0) {
    throw usageError("search query must not be empty", "provide one or more technical search terms");
  }

  const url = new URL(origin);
  url.search = new URLSearchParams({
    search_query: expressions.join(" AND "),
    start: String(offset),
    max_results: String(limit),
    sortBy: SORT_BY[options.sort ?? "relevance"],
    sortOrder: "descending",
  }).toString();
  return url;
}

export function buildIdUrl(
  id: string,
  origin = new URL("https://export.arxiv.org/api/query"),
): URL {
  const url = new URL(origin);
  url.search = new URLSearchParams({
    id_list: id,
    start: "0",
    max_results: "1",
  }).toString();
  return url;
}

export function tokenize(input: string): string[] {
  const terms: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  for (const match of input.trim().matchAll(pattern)) {
    const value = (match[1] ?? match[2])?.trim();
    if (value !== undefined && value.length > 0) {
      terms.push(value);
    }
  }
  return terms;
}

function fieldExpression(field: "all" | "ti" | "au", value: string): string {
  const normalized = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return /^[A-Za-z0-9._-]+$/.test(normalized)
    ? `${field}:${normalized}`
    : `${field}:"${normalized}"`;
}

function buildDateExpression(since: string | undefined, until: string | undefined): string | undefined {
  if (since === undefined && until === undefined) {
    return undefined;
  }
  const start = since === undefined ? "000001010000" : parseDate("since", since, false);
  const end = until === undefined ? "999912312359" : parseDate("until", until, true);
  if (start > end) {
    throw usageError("--since must not be after --until", "swap or correct the date bounds");
  }
  return `submittedDate:[${start} TO ${end}]`;
}

function parseDate(name: string, value: string, endOfDay: boolean): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw usageError(`--${name} must be YYYY-MM-DD`, `use --${name} 2025-01-31`);
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.valueOf()) || instant.toISOString().slice(0, 10) !== value) {
    throw usageError(`--${name} is not a valid calendar date`, `correct --${name} ${value}`);
  }
  return `${match[1]}${match[2]}${match[3]}${endOfDay ? "2359" : "0000"}`;
}

function validateInteger(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw usageError(
      `--${name} must be an integer from ${minimum} to ${maximum}`,
      `choose --${name} within the supported output bound`,
    );
  }
}
