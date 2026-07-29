import type { AtomFeed, PaperMetadata } from "../arxiv/atom.js";
import type { SearchQueryOptions } from "../arxiv/query.js";
import type { LibraryEntry } from "../library/store.js";
import type { CommandContext } from "./context.js";

export type MetadataSource = "fresh" | "cached" | "stale";

export interface SearchCommandOptions extends SearchQueryOptions {
  readonly noCache?: boolean;
  readonly noStale?: boolean;
}

export interface SearchResultEntry {
  readonly metadata: PaperMetadata;
  readonly cached: readonly LibraryEntry[];
}

export interface SearchCommandResult {
  readonly feed: AtomFeed;
  readonly entries: readonly SearchResultEntry[];
  readonly source: MetadataSource;
  readonly cacheAgeMs: number | undefined;
  readonly requestUrl: string;
}

export async function executeSearch(
  context: CommandContext,
  options: SearchCommandOptions,
): Promise<SearchCommandResult> {
  const requestUrl = context.client.searchUrl(options).href;
  const cached = options.noCache === true
    ? undefined
    : await context.cache.get<AtomFeed>(requestUrl, true);

  let feed: AtomFeed;
  let source: MetadataSource;
  let cacheAgeMs: number | undefined;

  if (cached !== undefined && !cached.stale) {
    context.debug(`cache hit ${requestUrl}`);
    feed = cached.value;
    source = "cached";
    cacheAgeMs = cached.ageMs;
  } else {
    context.debug(`cache miss ${requestUrl}`);
    try {
      feed = await context.client.search(options);
      source = "fresh";
      if (options.noCache !== true) {
        await context.cache.putMany([
          { key: requestUrl, value: feed },
          ...feed.entries.flatMap((entry) => [
            { key: context.client.idUrl(entry.exactId).href, value: entry },
            { key: context.client.idUrl(entry.id).href, value: entry },
          ]),
        ]);
      }
    } catch (error) {
      if (cached === undefined || options.noStale === true) {
        throw error;
      }
      context.diagnostic("upstream unavailable; serving visibly stale cached metadata");
      feed = cached.value;
      source = "stale";
      cacheAgeMs = cached.ageMs;
    }
  }

  const membership = await context.library.membership();
  return {
    feed,
    entries: feed.entries.map((metadata) => ({
      metadata,
      cached: membership.get(metadata.id) ?? [],
    })),
    source,
    cacheAgeMs,
    requestUrl,
  };
}
