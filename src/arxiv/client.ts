import type { IncomingHttpHeaders } from "node:http";

import { notFoundError, upstreamError } from "../errors.js";
import { parseArxivId } from "../library/paths.js";
import {
  CircuitBreakerOpenError,
  type GateOutcome,
  NetworkGate,
} from "../throttle.js";
import {
  createHttpsTransport,
  type NodeHttpTransport,
  type WireResponse,
} from "../http/transport.js";
import { type AtomFeed, parseAtomFeed, type PaperMetadata } from "./atom.js";
import { buildIdUrl, buildSearchUrl, type SearchQueryOptions } from "./query.js";

export const ATOM_MAX_BYTES = 5 * 1024 * 1024;
export const PDF_MAX_BYTES = 100 * 1024 * 1024;

const CONNECT_HEADERS_TIMEOUT_MS = 10_000;
const BODY_STALL_TIMEOUT_MS = 20_000;
const QUERY_ATTEMPT_TIMEOUT_MS = 30_000;
const QUERY_OPERATION_TIMEOUT_MS = 90_000;
const PDF_ATTEMPT_TIMEOUT_MS = 10 * 60_000;
const PDF_OPERATION_TIMEOUT_MS = 20 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;

export interface ArxivClientApi {
  search(options: SearchQueryOptions, signal?: AbortSignal): Promise<AtomFeed>;
  get(id: string, signal?: AbortSignal): Promise<PaperMetadata>;
  downloadPdf(exactId: string, signal?: AbortSignal): Promise<Buffer>;
  searchUrl(options: SearchQueryOptions): URL;
  idUrl(id: string): URL;
}

export interface ArxivClientOptions {
  readonly transport: NodeHttpTransport;
  readonly gate: NetworkGate;
  readonly queryOrigin?: URL;
  readonly pdfOrigin?: URL;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly onWait?: (message: string) => void;
  readonly onDebug?: (message: string) => void;
  readonly maxAttempts?: number;
  readonly connectHeadersTimeoutMs?: number;
  readonly bodyStallTimeoutMs?: number;
  readonly queryAttemptTimeoutMs?: number;
  readonly queryOperationTimeoutMs?: number;
  readonly pdfAttemptTimeoutMs?: number;
  readonly pdfOperationTimeoutMs?: number;
}

interface ResponseBuffer {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface RequestPolicy {
  readonly kind: "atom" | "pdf";
  readonly maxBytes: number;
  readonly attemptTimeoutMs: number;
  readonly operationTimeoutMs: number;
}

export class RequestTimeoutError extends Error {
  constructor(readonly phase: "headers" | "body" | "attempt" | "operation") {
    super(`arXiv request exceeded its ${phase} deadline`);
    this.name = "RequestTimeoutError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(
    readonly maximumBytes: number,
    readonly receivedBytes: number,
  ) {
    super(`arXiv response exceeded ${maximumBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export class InvalidRedirectError extends Error {
  constructor(readonly destination: string) {
    super(`refused unsafe arXiv redirect to ${destination}`);
    this.name = "InvalidRedirectError";
  }
}

export class InvalidPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPdfError";
  }
}

export class ArxivClient implements ArxivClientApi {
  readonly #transport: NodeHttpTransport;
  readonly #gate: NetworkGate;
  readonly #queryOrigin: URL;
  readonly #pdfOrigin: URL;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #onWait: ((message: string) => void) | undefined;
  readonly #onDebug: ((message: string) => void) | undefined;
  readonly #maxAttempts: number;
  readonly #connectHeadersTimeoutMs: number;
  readonly #bodyStallTimeoutMs: number;
  readonly #queryAttemptTimeoutMs: number;
  readonly #queryOperationTimeoutMs: number;
  readonly #pdfAttemptTimeoutMs: number;
  readonly #pdfOperationTimeoutMs: number;

  constructor(options: ArxivClientOptions) {
    this.#transport = options.transport;
    this.#gate = options.gate;
    this.#queryOrigin = options.queryOrigin ?? new URL("https://export.arxiv.org/api/query");
    this.#pdfOrigin = options.pdfOrigin ?? new URL("https://arxiv.org/pdf/");
    this.#now = options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? abortableSleep;
    this.#random = options.random ?? Math.random;
    this.#onWait = options.onWait;
    this.#onDebug = options.onDebug;
    this.#maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.#connectHeadersTimeoutMs =
      options.connectHeadersTimeoutMs ?? CONNECT_HEADERS_TIMEOUT_MS;
    this.#bodyStallTimeoutMs = options.bodyStallTimeoutMs ?? BODY_STALL_TIMEOUT_MS;
    this.#queryAttemptTimeoutMs = options.queryAttemptTimeoutMs ?? QUERY_ATTEMPT_TIMEOUT_MS;
    this.#queryOperationTimeoutMs =
      options.queryOperationTimeoutMs ?? QUERY_OPERATION_TIMEOUT_MS;
    this.#pdfAttemptTimeoutMs = options.pdfAttemptTimeoutMs ?? PDF_ATTEMPT_TIMEOUT_MS;
    this.#pdfOperationTimeoutMs = options.pdfOperationTimeoutMs ?? PDF_OPERATION_TIMEOUT_MS;
  }

  searchUrl(options: SearchQueryOptions): URL {
    return buildSearchUrl(options, this.#queryOrigin);
  }

  idUrl(id: string): URL {
    return buildIdUrl(id, this.#queryOrigin);
  }

  async search(options: SearchQueryOptions, signal?: AbortSignal): Promise<AtomFeed> {
    const response = await this.#requestWithRetries(
      this.searchUrl(options),
      this.#policy("atom"),
      signal,
    );
    return parseAtomFeed(response.body.toString("utf8"));
  }

  async get(id: string, signal?: AbortSignal): Promise<PaperMetadata> {
    const parsed = parseArxivId(id);
    const response = await this.#requestWithRetries(
      this.idUrl(parsed.exactId ?? parsed.baseId),
      this.#policy("atom"),
      signal,
    );
    const feed = parseAtomFeed(response.body.toString("utf8"));
    const entry = feed.entries[0];
    if (entry === undefined) {
      throw notFoundError(
        `no such paper ${id}`,
        `check the ID, then run \`arxiv search ${JSON.stringify(parsed.baseId)} --titles-only\``,
      );
    }
    if (parsed.version !== undefined && entry.version !== parsed.version) {
      throw notFoundError(
        `arXiv did not return exact version ${parsed.exactId}`,
        `check the version at https://arxiv.org/abs/${parsed.baseId}`,
      );
    }
    return entry;
  }

  async downloadPdf(exactId: string, signal?: AbortSignal): Promise<Buffer> {
    const parsed = parseArxivId(exactId);
    if (parsed.exactId === undefined) {
      throw new TypeError("downloadPdf requires an exact versioned ID");
    }
    const url = new URL(this.#pdfOrigin);
    const encodedId = parsed.exactId.split("/").map(encodeURIComponent).join("/");
    url.pathname = `${this.#pdfOrigin.pathname.replace(/\/?$/, "/")}${encodedId}`;
    const response = await this.#requestWithRetries(url, this.#policy("pdf"), signal);
    validatePdfResponse(response);
    return response.body;
  }

  async #requestWithRetries(
    initialUrl: URL,
    policy: RequestPolicy,
    callerSignal: AbortSignal | undefined,
  ): Promise<ResponseBuffer> {
    const startedAt = this.#now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      throwIfAborted(callerSignal);
      const operationRemaining = policy.operationTimeoutMs - (this.#now() - startedAt);
      if (operationRemaining <= 0) {
        throw upstreamError(
          "arXiv operation exceeded its overall deadline",
          "retry the command later",
          { cause: new RequestTimeoutError("operation") },
        );
      }

      const attemptController = linkedAbortController(callerSignal);
      const attemptTimer = setTimeout(
        () => attemptController.abort(new RequestTimeoutError("attempt")),
        Math.min(policy.attemptTimeoutMs, operationRemaining),
      );

      try {
        const response = await this.#followRedirects(
          initialUrl,
          policy,
          attemptController,
        );
        if (response.statusCode >= 200 && response.statusCode < 300) {
          return response;
        }
        if (response.statusCode === 404) {
          throw notFoundError(
            `arXiv returned 404 for ${initialUrl.pathname}`,
            "check the paper ID",
          );
        }
        if (!isRetryableStatus(response.statusCode)) {
          throw upstreamError(
            `arXiv returned HTTP ${response.statusCode}`,
            "correct the request before retrying",
          );
        }
        const retryAfterMs = parseRetryAfter(response.headers["retry-after"], Date.now());
        lastError = upstreamError(
          `arXiv returned retryable HTTP ${response.statusCode}`,
          "retry the command later",
        );
        if (attempt < this.#maxAttempts) {
          await this.#backoff(attempt, retryAfterMs, startedAt, policy, callerSignal);
        }
      } catch (error) {
        if (error instanceof CircuitBreakerOpenError) {
          throw upstreamError(error.message, "retry after the stated breaker deadline", {
            cause: error,
          });
        }
        if (!isRetryableError(error) || attempt >= this.#maxAttempts) {
          if (
            error instanceof RequestTimeoutError ||
            isRetryableError(error)
          ) {
            throw upstreamError(
              `arXiv request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
              "retry the command later",
              { cause: error },
            );
          }
          throw error;
        }
        lastError = error;
        await this.#backoff(attempt, undefined, startedAt, policy, callerSignal);
      } finally {
        clearTimeout(attemptTimer);
      }
    }

    throw upstreamError("arXiv request failed after retries", "retry the command later", {
      cause: lastError,
    });
  }

  async #followRedirects(
    initialUrl: URL,
    policy: RequestPolicy,
    attemptController: AbortController,
  ): Promise<ResponseBuffer> {
    let url = initialUrl;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await this.#wire(url, policy, attemptController);
      if (!isRedirect(response.statusCode)) {
        return response;
      }
      if (redirects === MAX_REDIRECTS) {
        throw upstreamError("arXiv returned too many redirects", "retry the command later");
      }
      const location = headerValue(response.headers.location);
      if (location === undefined) {
        throw upstreamError(
          `arXiv returned HTTP ${response.statusCode} without a Location header`,
          "retry the command later",
        );
      }
      const destination = new URL(location, url);
      validateRedirect(destination);
      this.#onDebug?.(`redirect ${url.href} -> ${destination.href}`);
      url = destination;
    }
    throw new Error("unreachable redirect loop");
  }

  async #wire(
    url: URL,
    policy: RequestPolicy,
    attemptController: AbortController,
  ): Promise<ResponseBuffer> {
    let headersTimer: NodeJS.Timeout | undefined;
    const operation = async (): Promise<ResponseBuffer> => {
      headersTimer = setTimeout(
        () => attemptController.abort(new RequestTimeoutError("headers")),
        this.#connectHeadersTimeoutMs,
      );
      try {
        const result = await this.#transport.request(
          url,
          { signal: attemptController.signal },
          async (response) => {
            if (headersTimer !== undefined) {
              clearTimeout(headersTimer);
              headersTimer = undefined;
            }
            return await readBoundedBody(
              response,
              policy.maxBytes,
              this.#bodyStallTimeoutMs,
              attemptController,
            );
          },
        );
        return {
          statusCode: result.statusCode,
          headers: result.headers,
          body: result.value,
        };
      } finally {
        if (headersTimer !== undefined) {
          clearTimeout(headersTimer);
        }
      }
    };

    return await this.#gate.run(operation, {
      signal: attemptController.signal,
      classifyValue: classifyResponse,
      classifyError: classifyWireError,
    });
  }

  async #backoff(
    attempt: number,
    retryAfterMs: number | undefined,
    operationStartedAt: number,
    policy: RequestPolicy,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const exponential = Math.max(3_000, 2 ** (attempt - 1) * 1_000);
    const waitMs = Math.max(exponential + Math.floor(this.#random() * 500), retryAfterMs ?? 0);
    const remaining = policy.operationTimeoutMs - (this.#now() - operationStartedAt);
    if (waitMs >= remaining) {
      throw new RequestTimeoutError("operation");
    }
    this.#onWait?.(
      `rate limited by export.arxiv.org, waiting ${Math.ceil(waitMs / 1_000)}s (attempt ${attempt + 1} of ${this.#maxAttempts})`,
    );
    await this.#sleep(waitMs, signal);
  }

  #policy(kind: "atom" | "pdf"): RequestPolicy {
    return kind === "atom"
      ? {
          kind,
          maxBytes: ATOM_MAX_BYTES,
          attemptTimeoutMs: this.#queryAttemptTimeoutMs,
          operationTimeoutMs: this.#queryOperationTimeoutMs,
        }
      : {
          kind,
          maxBytes: PDF_MAX_BYTES,
          attemptTimeoutMs: this.#pdfAttemptTimeoutMs,
          operationTimeoutMs: this.#pdfOperationTimeoutMs,
        };
  }
}

export function createProductionArxivClient(options: {
  readonly userAgent: string;
  readonly onWait?: (message: string) => void;
  readonly onDebug?: (message: string) => void;
}): ArxivClient {
  const gate = new NetworkGate({
    ...(options.onWait === undefined ? {} : { onWait: options.onWait }),
    ...(options.onDebug === undefined ? {} : { onDebug: options.onDebug }),
  });
  return new ArxivClient({
    transport: createHttpsTransport({ userAgent: options.userAgent }),
    gate,
    ...(options.onWait === undefined ? {} : { onWait: options.onWait }),
    ...(options.onDebug === undefined ? {} : { onDebug: options.onDebug }),
  });
}

async function readBoundedBody(
  response: WireResponse,
  maximumBytes: number,
  stallTimeoutMs: number,
  controller: AbortController,
): Promise<Buffer> {
  const contentLength = numericContentLength(response.headers["content-length"]);
  if (contentLength !== undefined && contentLength > maximumBytes) {
    throw new ResponseTooLargeError(maximumBytes, contentLength);
  }
  const chunks: Buffer[] = [];
  let received = 0;
  let stallTimer = setTimeout(
    () => controller.abort(new RequestTimeoutError("body")),
    stallTimeoutMs,
  );
  try {
    for await (const chunk of response.body) {
      clearTimeout(stallTimer);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > maximumBytes) {
        throw new ResponseTooLargeError(maximumBytes, received);
      }
      chunks.push(buffer);
      stallTimer = setTimeout(
        () => controller.abort(new RequestTimeoutError("body")),
        stallTimeoutMs,
      );
    }
  } finally {
    clearTimeout(stallTimer);
  }
  return Buffer.concat(chunks, received);
}

function validatePdfResponse(response: ResponseBuffer): void {
  const mediaType = headerValue(response.headers["content-type"])
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/pdf") {
    throw new InvalidPdfError(
      `arXiv PDF endpoint returned ${mediaType ?? "no content type"} instead of application/pdf`,
    );
  }
  if (!response.body.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new InvalidPdfError("arXiv PDF response did not begin with %PDF-");
  }
  const expected = numericContentLength(response.headers["content-length"]);
  if (expected !== undefined && expected !== response.body.byteLength) {
    throw new InvalidPdfError(
      `arXiv PDF response declared ${expected} bytes but delivered ${response.body.byteLength}`,
    );
  }
}

function validateRedirect(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    !(hostname === "arxiv.org" || hostname.endsWith(".arxiv.org"))
  ) {
    throw new InvalidRedirectError(url.href);
  }
}

function classifyResponse(response: ResponseBuffer): GateOutcome {
  if (isRedirect(response.statusCode)) {
    return { kind: "neutral" };
  }
  if (isRetryableStatus(response.statusCode)) {
    const retryAfterMs = parseRetryAfter(response.headers["retry-after"], Date.now());
    return retryAfterMs === undefined
      ? { kind: "retryable" }
      : { kind: "retryable", retryAfterMs };
  }
  return { kind: "success" };
}

function classifyWireError(error: unknown): GateOutcome {
  return isRetryableError(error) ? { kind: "retryable" } : { kind: "neutral" };
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof RequestTimeoutError || error instanceof ResponseTooLargeError) {
    return error instanceof RequestTimeoutError;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "EPIPE" ||
    error.name === "AbortError"
  );
}

function parseRetryAfter(
  value: string | readonly string[] | undefined,
  now: number,
): number | undefined {
  const text = headerValue(value);
  if (text === undefined) {
    return undefined;
  }
  if (/^\d+$/.test(text)) {
    return Number(text) * 1_000;
  }
  const deadline = Date.parse(text);
  return Number.isNaN(deadline) ? undefined : Math.max(0, deadline - now);
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" || value === undefined) {
    return value;
  }
  return value[0];
}

function numericContentLength(
  value: string | readonly string[] | undefined,
): number | undefined {
  const text = headerValue(value);
  if (text === undefined || !/^\d+$/.test(text)) {
    return undefined;
  }
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : undefined;
}

function linkedAbortController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (signal === undefined) {
    return controller;
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
  }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal === undefined) {
      return;
    }
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}
