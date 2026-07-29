import { getDocumentProxy } from "unpdf";

import { CliError, localStateError, usageError } from "../errors.js";
import type { LibraryEntry } from "../library/store.js";
import type { CommandContext } from "./context.js";

export interface PageRange {
  readonly start: number;
  readonly end: number;
}

export interface TextCommandResult {
  readonly entry: LibraryEntry;
  readonly range: PageRange;
  readonly totalPages: number;
  readonly text: string;
}

export function parsePageRange(value: string): PageRange {
  const match = /^([1-9]\d*)-([1-9]\d*)$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw usageError(
      "--pages must be an inclusive range such as 1-3",
      "use `arxiv text <id> --pages 1-3`",
    );
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw usageError("--pages must increase from start to end", "use a range such as --pages 2-5");
  }
  if (end - start + 1 > 5) {
    throw usageError(
      "--pages may span at most 5 pages",
      `use \`--pages ${start}-${start + 4}\`, then request another bounded range if needed`,
    );
  }
  return { start, end };
}

export async function executeText(
  context: CommandContext,
  id: string,
  range: PageRange,
): Promise<TextCommandResult> {
  const entry = await context.library.resolveLive(id);
  const pdfBytes = await context.library.readPdf(entry);
  let totalPages: number;
  const pages: string[] = [];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(pdfBytes), { verbosity: 0 });
    try {
      totalPages = pdf.numPages;
      if (range.end > totalPages) {
        throw usageError(
          `requested page ${range.end}, but ${entry.exactId} has ${totalPages} pages`,
          `choose an end page no greater than ${totalPages}`,
        );
      }
      for (let pageNumber = range.start; pageNumber <= range.end; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(
          content.items
            .filter((item) => "str" in item)
            .map((item) => `${item.str}${item.hasEOL ? "\n" : ""}`)
            .join(""),
        );
      }
    } finally {
      await pdf.cleanup();
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw localStateError(
      `${entry.exactId} could not be decoded as a PDF`,
      `run \`arxiv library remove ${entry.exactId}\` and download it again`,
      { cause: error },
    );
  }
  return {
    entry,
    range,
    totalPages,
    text: pages
      .map((text, index) => `--- page ${range.start + index} ---\n${text.trim()}`)
      .join("\n\n"),
  };
}
