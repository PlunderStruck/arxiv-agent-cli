import type { ArxivClientApi } from "../arxiv/client.js";
import { QueryCache } from "../cache.js";
import type { LibraryStore } from "../library/store.js";

export interface CommandContext {
  readonly client: ArxivClientApi;
  readonly library: LibraryStore;
  readonly cache: QueryCache;
  readonly cliVersion: string;
  readonly now: () => Date;
  readonly diagnostic: (message: string) => void;
  readonly debug: (message: string) => void;
}
