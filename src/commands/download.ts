import type { PaperMetadata } from "../arxiv/atom.js";
import { usageError } from "../errors.js";
import { parseArxivId } from "../library/paths.js";
import type { LibraryEntry } from "../library/store.js";
import type { CommandContext } from "./context.js";
import { executeGet } from "./get.js";

export async function executeDownload(
  context: CommandContext,
  ids: readonly string[],
): Promise<readonly LibraryEntry[]> {
  if (ids.length < 1) {
    throw usageError("download requires at least one arXiv ID", "run `arxiv download <id>`");
  }
  if (ids.length > 3) {
    throw usageError(
      `download accepts at most 3 IDs per invocation, received ${ids.length}`,
      "triage with `arxiv search --titles-only`, then download one relevant paper at a time",
    );
  }

  const downloaded: LibraryEntry[] = [];
  for (const id of ids) {
    const parsed = parseArxivId(id);
    let metadata: PaperMetadata;
    let metadataState: "complete" | "incomplete" = "complete";
    let metadataFetchedAt: string | null | undefined;

    if (parsed.exactId === undefined || parsed.version === undefined) {
      const resolution = await executeGet(context, {
        id,
        noStale: true,
      });
      metadata = resolution.metadata;
    } else {
      const cached = await context.cache.get<PaperMetadata>(
        context.client.idUrl(parsed.exactId).href,
        true,
      );
      if (cached === undefined) {
        metadata = incompleteMetadata(parsed.baseId, parsed.version, parsed.exactId);
        metadataState = "incomplete";
        metadataFetchedAt = null;
      } else {
        metadata = cached.value;
        metadataFetchedAt = new Date(cached.fetchedAt).toISOString();
      }
    }

    context.diagnostic(`downloading ${metadata.exactId}`);
    const pdf = await context.client.downloadPdf(metadata.exactId);
    downloaded.push(
      await context.library.addPdf(metadata, pdf, {
        metadataState,
        ...(metadataFetchedAt === undefined ? {} : { metadataFetchedAt }),
      }),
    );
  }
  return downloaded;
}

function incompleteMetadata(
  baseId: string,
  version: number,
  exactId: string,
): PaperMetadata {
  return {
    id: baseId,
    version,
    exactId,
    title: exactId,
    summary: "",
    authors: [],
    primaryCategory: "",
    categories: [],
    publishedAt: "",
    updatedAt: "",
    doi: null,
    journalRef: null,
    comment: null,
    abstractUrl: `https://arxiv.org/abs/${exactId}`,
    pdfUrl: `https://arxiv.org/pdf/${exactId}`,
  };
}
