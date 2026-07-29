import type { PaperMetadata } from "../arxiv/atom.js";
import { notFoundError } from "../errors.js";
import { parseArxivId } from "../library/paths.js";
import type { LibraryEntry } from "../library/store.js";
import type { CommandContext } from "./context.js";
import type { MetadataSource } from "./search.js";

export interface GetCommandOptions {
  readonly id: string;
  readonly noStale?: boolean;
  readonly noCache?: boolean;
}

export interface GetCommandResult {
  readonly metadata: PaperMetadata;
  readonly cached: readonly LibraryEntry[];
  readonly source: MetadataSource;
  readonly cacheAgeMs: number | undefined;
}

export async function executeGet(
  context: CommandContext,
  options: GetCommandOptions,
): Promise<GetCommandResult> {
  try {
    parseArxivId(options.id);
  } catch {
    const suggestions = await context.cache.suggestPapers(options.id, 1);
    const suggestion = suggestions[0];
    throw notFoundError(
      `no such paper ${options.id} (malformed arXiv ID)`,
      suggestion === undefined
        ? "search by title or technical terms to recover the exact ID"
        : `did you mean: arxiv get ${suggestion.id}  (${JSON.stringify(suggestion.title)})`,
    );
  }
  const key = context.client.idUrl(options.id).href;
  const cached = options.noCache === true
    ? undefined
    : await context.cache.get<PaperMetadata>(key, true);
  let metadata: PaperMetadata;
  let source: MetadataSource;
  let cacheAgeMs: number | undefined;
  let metadataFetchedAt: number;

  if (cached !== undefined && !cached.stale) {
    context.debug(`cache hit ${key}`);
    metadata = cached.value;
    source = "cached";
    cacheAgeMs = cached.ageMs;
    metadataFetchedAt = cached.fetchedAt;
  } else {
    try {
      metadata = await context.client.get(options.id);
      source = "fresh";
      metadataFetchedAt = context.now().valueOf();
      if (options.noCache !== true) {
        await context.cache.putMany([
          { key, value: metadata },
          { key: context.client.idUrl(metadata.exactId).href, value: metadata },
          { key: context.client.idUrl(metadata.id).href, value: metadata },
        ]);
      }
    } catch (error) {
      if (cached === undefined || options.noStale === true) {
        throw error;
      }
      context.diagnostic("upstream unavailable; serving visibly stale cached metadata");
      metadata = cached.value;
      source = "stale";
      cacheAgeMs = cached.ageMs;
      metadataFetchedAt = cached.fetchedAt;
    }
  }

  if (source !== "stale") {
    await context.library.refreshMetadata(
      metadata,
      new Date(metadataFetchedAt).toISOString(),
    );
  }
  const membership = await context.library.membership();
  return {
    metadata,
    cached: membership.get(metadata.id) ?? [],
    source,
    cacheAgeMs,
  };
}
