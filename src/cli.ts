#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { createProductionArxivClient } from "./arxiv/client.js";
import type { SearchQueryOptions, SearchSort } from "./arxiv/query.js";
import { QueryCache } from "./cache.js";
import type { CommandContext } from "./commands/context.js";
import { executeDownload } from "./commands/download.js";
import { executeGet } from "./commands/get.js";
import {
  executeLibraryList,
  executeLibraryRemove,
  executeLibraryRepair,
  executeLibraryRestore,
} from "./commands/library.js";
import { executeSearch } from "./commands/search.js";
import { executeText, parsePageRange } from "./commands/text.js";
import {
  asCliError,
  jsonErrorEnvelope,
  type CliError,
  usageError,
} from "./errors.js";
import { configuredLibraryRoot } from "./library/paths.js";
import { LibraryStore } from "./library/store.js";
import {
  renderDownload,
  renderGet,
  renderLibraryList,
  renderRemoved,
  renderRestored,
  renderSearch,
  renderText,
  type SearchPresentation,
} from "./render.js";

export const CLI_VERSION = "0.1.0";
export const USER_AGENT =
  `arxiv-agent-cli/${CLI_VERSION} (+https://github.com/aydansalois/arxiv-agent-cli)`;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface RunCliOptions {
  readonly context?: CommandContext;
  readonly environment?: NodeJS.ProcessEnv;
  readonly io?: CliIo;
}

const DEFAULT_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? DEFAULT_IO;
  const wantsJson = argv.includes("--json");

  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      io.stdout(`${helpText()}\n`);
      return 0;
    }
    if (argv[0] === "--version" || argv[0] === "-V") {
      io.stdout(`${CLI_VERSION}\n`);
      return 0;
    }

    const context = options.context ??
      await createDefaultContext(options.environment ?? process.env, io);
    const output = await dispatch(context, argv);
    io.stdout(output.endsWith("\n") ? output : `${output}\n`);
    return 0;
  } catch (error) {
    const cliError = normalizeError(error);
    if (wantsJson) {
      io.stdout(`${JSON.stringify(jsonErrorEnvelope(cliError, CLI_VERSION))}\n`);
    } else {
      io.stderr(`arxiv: ${cliError.message}\n  ${cliError.correction}\n`);
    }
    return cliError.exitCode;
  }
}

async function dispatch(context: CommandContext, argv: readonly string[]): Promise<string> {
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case "search":
      return await searchCommand(context, rest);
    case "get":
      return await getCommand(context, rest);
    case "download":
      return await downloadCommand(context, rest);
    case "text":
      return await textCommand(context, rest);
    case "library":
      return await libraryCommand(context, rest);
    case "help":
      return helpText();
    default:
      throw usageError(
        `unknown command ${JSON.stringify(command)}`,
        "run `arxiv --help` to see the six supported commands",
      );
  }
}

async function searchCommand(
  context: CommandContext,
  argv: readonly string[],
): Promise<string> {
  const parsed = parse(
    argv,
    {
      limit: { type: "string" },
      offset: { type: "string" },
      "titles-only": { type: "boolean" },
      full: { type: "boolean" },
      json: { type: "boolean" },
      category: { type: "string" },
      author: { type: "string" },
      title: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      sort: { type: "string" },
      "no-cache": { type: "boolean" },
      "no-stale": { type: "boolean" },
    },
  );
  const query = parsed.positionals.join(" ").trim();
  if (query.length === 0) {
    throw usageError("search requires a query", "run `arxiv search \"technical terms\"`");
  }
  if (parsed.values["titles-only"] === true && parsed.values["full"] === true) {
    throw usageError(
      "--titles-only and --full cannot be combined",
      "choose breadth with --titles-only or depth with --full",
    );
  }

  const presentation: SearchPresentation = parsed.values["titles-only"] === true
    ? "titles"
    : parsed.values["full"] === true
      ? "full"
      : "compact";
  const maximum = presentation === "full" ? 5 : 50;
  const limit = integerOption(parsed.values["limit"], presentation === "full" ? 5 : 10, "limit");
  const offset = integerOption(parsed.values["offset"], 0, "offset");
  if (limit < 1 || limit > maximum) {
    throw usageError(
      `${limit} results ${presentation === "full" ? "with full abstracts " : ""}exceeds the cap of ${maximum}`,
      presentation === "full"
        ? "use `--full --limit 5`, or switch to `--titles-only --limit 50` for breadth"
        : "use `--limit 50 --titles-only` for the widest bounded scan",
    );
  }
  if (offset < 0) {
    throw usageError("--offset must be non-negative", "use `--offset 0` or greater");
  }
  const sort = searchSort(parsed.values["sort"]);
  const searchOptions: SearchQueryOptions & {
    readonly noCache?: boolean;
    readonly noStale?: boolean;
  } = {
    query,
    limit,
    offset,
    sort,
    ...stringProperty("category", parsed.values["category"]),
    ...stringProperty("author", parsed.values["author"]),
    ...stringProperty("title", parsed.values["title"]),
    ...stringProperty("since", parsed.values["since"]),
    ...stringProperty("until", parsed.values["until"]),
    ...(parsed.values["no-cache"] === true ? { noCache: true } : {}),
    ...(parsed.values["no-stale"] === true ? { noStale: true } : {}),
  };
  const result = await executeSearch(context, searchOptions);
  return renderSearch(result, presentation, query, offset, sort, {
    json: parsed.values["json"] === true,
    cliVersion: context.cliVersion,
  });
}

async function getCommand(context: CommandContext, argv: readonly string[]): Promise<string> {
  const parsed = parse(argv, {
    json: { type: "boolean" },
    "no-stale": { type: "boolean" },
  });
  const id = exactlyOne(parsed.positionals, "get requires exactly one arXiv ID", "arxiv get <id>");
  const result = await executeGet(context, {
    id,
    ...(parsed.values["no-stale"] === true ? { noStale: true } : {}),
  });
  return renderGet(result, {
    json: parsed.values["json"] === true,
    cliVersion: context.cliVersion,
  });
}

async function downloadCommand(
  context: CommandContext,
  argv: readonly string[],
): Promise<string> {
  const parsed = parse(argv, {});
  return renderDownload(await executeDownload(context, parsed.positionals));
}

async function textCommand(context: CommandContext, argv: readonly string[]): Promise<string> {
  const parsed = parse(argv, {
    pages: { type: "string" },
    json: { type: "boolean" },
  });
  const id = exactlyOne(parsed.positionals, "text requires exactly one arXiv ID", "arxiv text <id> --pages 1-3");
  const pages = parsed.values["pages"];
  if (typeof pages !== "string") {
    throw usageError(
      "text requires --pages and has no whole-document form",
      `run \`arxiv text ${id} --pages 1-3\``,
    );
  }
  const result = await executeText(context, id, parsePageRange(pages));
  return renderText(result, {
    json: parsed.values["json"] === true,
    cliVersion: context.cliVersion,
  });
}

async function libraryCommand(
  context: CommandContext,
  argv: readonly string[],
): Promise<string> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  switch (subcommand) {
    case "list": {
      const parsed = parse(rest, {
        limit: { type: "string" },
        offset: { type: "string" },
        "titles-only": { type: "boolean" },
        json: { type: "boolean" },
      });
      if (parsed.positionals.length > 0) {
        throw usageError("library list does not accept IDs", "run `arxiv library list`");
      }
      const limit = integerOption(parsed.values["limit"], 20, "limit");
      const offset = integerOption(parsed.values["offset"], 0, "offset");
      const result = await executeLibraryList(context.library, { limit, offset });
      return renderLibraryList(result, offset, {
        json: parsed.values["json"] === true,
        cliVersion: context.cliVersion,
      });
    }
    case "remove": {
      const parsed = parse(rest, {});
      const id = exactlyOne(parsed.positionals, "library remove requires one ID", "arxiv library remove <id>");
      return renderRemoved(await executeLibraryRemove(context.library, id));
    }
    case "restore": {
      const parsed = parse(rest, {});
      const id = exactlyOne(parsed.positionals, "library restore requires one ID", "arxiv library restore <id>");
      return renderRestored(await executeLibraryRestore(context.library, id));
    }
    case "repair": {
      const parsed = parse(rest, {});
      if (parsed.positionals.length > 0) {
        throw usageError("library repair accepts no arguments", "run `arxiv library repair`");
      }
      const result = await executeLibraryRepair(context.library);
      return [
        `repaired library: ${result.recovered} record${result.recovered === 1 ? "" : "s"} recovered`,
        result.backup === undefined ? "  no prior index required backup" : `  backup: ${result.backup}`,
      ].join("\n");
    }
    default:
      throw usageError(
        `unknown library command ${JSON.stringify(subcommand)}`,
        "use `arxiv library list`, `remove`, `restore`, or `repair`",
      );
  }
}

async function createDefaultContext(
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<CommandContext> {
  const library = await LibraryStore.create({
    root: configuredLibraryRoot(environment),
  });
  const debugEnabled = environment["ARXIV_DEBUG"] === "1";
  const diagnostic = (message: string): void => io.stderr(`arxiv: ${message}\n`);
  const debug = (message: string): void => {
    if (debugEnabled) {
      diagnostic(`[debug] ${message}`);
    }
  };
  const client = createProductionArxivClient({
    userAgent: USER_AGENT,
    onWait: diagnostic,
    onDebug: debug,
  });
  return {
    client,
    library,
    cache: new QueryCache({ directory: library.cacheDirectory }),
    cliVersion: CLI_VERSION,
    now: () => new Date(),
    diagnostic,
    debug,
  };
}

type ParseConfig = NonNullable<Parameters<typeof parseArgs>[0]>;
type ParseOptions = NonNullable<ParseConfig["options"]>;

function parse(
  argv: readonly string[],
  options: NonNullable<ParseOptions>,
): ReturnType<typeof parseArgs> {
  try {
    return parseArgs({
      args: [...argv],
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw usageError(
      error instanceof Error ? error.message : String(error),
      "run `arxiv --help` and correct the command",
    );
  }
}

function exactlyOne(
  positionals: readonly string[],
  message: string,
  example: string,
): string {
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw usageError(message, `run \`${example}\``);
  }
  return positionals[0];
}

function integerOption(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw usageError(`--${name} must be an integer`, `provide --${name} followed by a number`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw usageError(`--${name} is outside the safe integer range`, `choose a smaller --${name}`);
  }
  return number;
}

function searchSort(value: unknown): SearchSort {
  if (value === undefined) {
    return "relevance";
  }
  if (value === "relevance" || value === "submitted" || value === "updated") {
    return value;
  }
  throw usageError(
    `unknown sort ${JSON.stringify(value)}`,
    "use --sort relevance, --sort submitted, or --sort updated",
  );
}

function stringProperty<K extends string>(
  key: K,
  value: unknown,
): { readonly [P in K]?: string } {
  return typeof value === "string" ? { [key]: value } as { [P in K]: string } : {};
}

function normalizeError(error: unknown): CliError {
  if (error instanceof TypeError && error.message.startsWith("Invalid option")) {
    return usageError(error.message, "run `arxiv --help` and correct the option");
  }
  return asCliError(error);
}

function helpText(): string {
  return `arxiv-agent-cli ${CLI_VERSION}

Usage:
  arxiv search <query> [--limit N --offset N --titles-only --full --json]
                       [--category CAT --author NAME --title WORDS]
                       [--since YYYY-MM-DD --until YYYY-MM-DD]
                       [--sort relevance|submitted|updated --no-cache --no-stale]
  arxiv get <id> [--json --no-stale]
  arxiv download <id>...                 at most 3 IDs
  arxiv text <id> --pages A-B [--json]   at most 5 pages
  arxiv library list [--limit N --offset N --json]
  arxiv library remove <id>
  arxiv library restore <id>
  arxiv library repair

Environment:
  ARXIV_LIBRARY   local library root (default: ~/.arxiv)
  ARXIV_DEBUG=1   print cache, gate, redirect, and breaker events`;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
