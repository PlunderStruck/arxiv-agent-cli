import { parseXml } from "@rgrove/parse-xml";

import { upstreamError } from "../errors.js";
import { parseArxivId } from "../library/paths.js";

interface XmlNodeLike {
  readonly type?: string;
  readonly name?: string;
  readonly text?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children?: readonly XmlNodeLike[];
}

export interface ArxivAuthor {
  readonly name: string;
  readonly affiliation: string | null;
}

export interface PaperMetadata {
  readonly id: string;
  readonly version: number;
  readonly exactId: string;
  readonly title: string;
  readonly summary: string;
  readonly authors: readonly ArxivAuthor[];
  readonly primaryCategory: string;
  readonly categories: readonly string[];
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly doi: string | null;
  readonly journalRef: string | null;
  readonly comment: string | null;
  readonly abstractUrl: string;
  readonly pdfUrl: string;
}

export interface AtomFeed {
  readonly total: number;
  readonly start: number;
  readonly itemsPerPage: number;
  readonly entries: readonly PaperMetadata[];
}

export class AtomFeedError extends Error {
  constructor(readonly detail: string) {
    super(`arXiv API error: ${detail}`);
    this.name = "AtomFeedError";
  }
}

export function parseAtomFeed(xml: string): AtomFeed {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw upstreamError(
      "arXiv returned XML containing a prohibited DTD or entity declaration",
      "retry the command later",
    );
  }
  if (!/<\/(?:[A-Za-z0-9_-]+:)?feed>\s*$/.test(xml)) {
    throw upstreamError("arXiv returned a truncated Atom feed", "retry the command later");
  }

  let document: XmlNodeLike;
  try {
    document = parseXml(xml) as XmlNodeLike;
  } catch (error) {
    throw upstreamError("arXiv returned malformed XML", "retry the command later", {
      cause: error,
    });
  }

  const feed = descendants(document, "feed")[0];
  if (feed === undefined) {
    throw upstreamError("arXiv response did not contain an Atom feed", "retry the command later");
  }

  const feedTitle = childText(feed, "title");
  const feedId = childText(feed, "id");
  if (feedTitle.toLowerCase() === "error" || feedId.includes("/api/errors")) {
    throw new AtomFeedError(feedId.length > 0 ? feedId : feedTitle);
  }

  return {
    total: nonNegativeInteger(childText(feed, "totalResults"), "totalResults"),
    start: nonNegativeInteger(childText(feed, "startIndex"), "startIndex"),
    itemsPerPage: nonNegativeInteger(childText(feed, "itemsPerPage"), "itemsPerPage"),
    entries: children(feed, "entry").map(parseEntry),
  };
}

function parseEntry(entry: XmlNodeLike): PaperMetadata {
  const abstractUrl = requiredText(entry, "id");
  const rawId = decodeURIComponent(new URL(abstractUrl).pathname.replace(/^\/abs\//, ""));
  const parsed = parseArxivId(rawId);
  if (parsed.version === undefined || parsed.exactId === undefined) {
    throw upstreamError(
      `arXiv entry omitted a versioned ID: ${rawId}`,
      "retry the command later",
    );
  }

  const links = children(entry, "link");
  const pdfLink = links.find((link) => {
    const attributes = link.attributes ?? {};
    return attributes["title"] === "pdf" || attributes["type"] === "application/pdf";
  });
  const pdfUrl = pdfLink?.attributes?.["href"] ??
    `https://arxiv.org/pdf/${encodeURIComponent(parsed.exactId)}`;

  const categoryElements = children(entry, "category");
  const categories = categoryElements
    .map((category) => category.attributes?.["term"])
    .filter((value): value is string => value !== undefined)
    .map(normalizedText);
  const primary = normalizedText(children(entry, "primary_category")[0]?.attributes?.["term"] ??
    categories[0] ??
    "");

  return {
    id: parsed.baseId,
    version: parsed.version,
    exactId: parsed.exactId,
    title: normalizedText(requiredText(entry, "title")),
    summary: normalizedText(requiredText(entry, "summary")),
    authors: children(entry, "author").map((author) => ({
      name: normalizedText(requiredText(author, "name")),
      affiliation: nullableText(childText(author, "affiliation")),
    })),
    primaryCategory: primary,
    categories,
    publishedAt: requiredText(entry, "published"),
    updatedAt: requiredText(entry, "updated"),
    doi: nullableText(childText(entry, "doi")),
    journalRef: nullableText(childText(entry, "journal_ref")),
    comment: nullableText(childText(entry, "comment")),
    abstractUrl,
    pdfUrl,
  };
}

function children(node: XmlNodeLike, localName: string): XmlNodeLike[] {
  return (node.children ?? []).filter(
    (child) => child.type === "element" && nodeLocalName(child) === localName,
  );
}

function descendants(node: XmlNodeLike, localName: string): XmlNodeLike[] {
  const found: XmlNodeLike[] = [];
  if (node.type === "element" && nodeLocalName(node) === localName) {
    found.push(node);
  }
  for (const child of node.children ?? []) {
    found.push(...descendants(child, localName));
  }
  return found;
}

function nodeLocalName(node: XmlNodeLike): string {
  return (node.name ?? "").split(":").at(-1) ?? "";
}

function childText(node: XmlNodeLike, localName: string): string {
  const child = children(node, localName)[0];
  return child === undefined ? "" : collectText(child).trim();
}

function requiredText(node: XmlNodeLike, localName: string): string {
  const value = childText(node, localName);
  if (value.length === 0) {
    throw upstreamError(
      `arXiv Atom entry omitted ${localName}`,
      "retry the command later",
    );
  }
  return value;
}

function collectText(node: XmlNodeLike): string {
  if (node.type === "text" || node.type === "cdata") {
    return node.text ?? "";
  }
  return (node.children ?? []).map(collectText).join("");
}

function normalizedText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function nullableText(value: string): string | null {
  const normalized = normalizedText(value);
  return normalized.length === 0 ? null : normalized;
}

function nonNegativeInteger(value: string, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw upstreamError(
      `arXiv Atom feed contained an invalid ${field}`,
      "retry the command later",
    );
  }
  return number;
}
