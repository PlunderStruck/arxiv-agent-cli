import {
  Agent as HttpAgent,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import {
  Agent as HttpsAgent,
  request as httpsRequest,
  type RequestOptions,
} from "node:https";
import type { Duplex } from "node:stream";

export type RequestFunction = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export interface NodeHttpTransportOptions {
  readonly protocol: "http:" | "https:";
  readonly request: RequestFunction;
  readonly agent: HttpAgent;
  readonly userAgent: string;
  readonly onSocket?: (socket: Duplex) => void;
}

export interface HttpsTransportOptions {
  readonly userAgent: string;
  readonly onSocket?: (socket: Duplex) => void;
}

export interface WireRequestOptions {
  readonly method?: "GET" | "HEAD";
  readonly headers?: OutgoingHttpHeaders;
  readonly signal?: AbortSignal;
}

export interface WireResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: IncomingMessage;
}

export interface WireResult<T> {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly value: T;
}

export class UnsupportedProtocolError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`expected ${expected} URL, received ${actual}`);
    this.name = "UnsupportedProtocolError";
  }
}

export class IncompleteResponseError extends Error {
  constructor() {
    super("response consumer returned before the complete body was read");
    this.name = "IncompleteResponseError";
  }
}

export class NodeHttpTransport {
  readonly #protocol: "http:" | "https:";
  readonly #request: RequestFunction;
  readonly #agent: HttpAgent;
  readonly #userAgent: string;
  readonly #onSocket: ((socket: Duplex) => void) | undefined;

  constructor(options: NodeHttpTransportOptions) {
    if (options.userAgent.trim().length === 0) {
      throw new TypeError("userAgent must not be empty");
    }

    this.#protocol = options.protocol;
    this.#request = options.request;
    this.#agent = options.agent;
    this.#userAgent = options.userAgent;
    this.#onSocket = options.onSocket;
  }

  async request<T>(
    url: URL,
    options: WireRequestOptions,
    consume: (response: WireResponse) => Promise<T>,
  ): Promise<WireResult<T>> {
    if (url.protocol !== this.#protocol) {
      throw new UnsupportedProtocolError(this.#protocol, url.protocol);
    }

    return await new Promise<WireResult<T>>((resolve, reject) => {
      let assignedSocket: Duplex | undefined;
      let waitForSocketClose: Promise<void> | undefined;
      let response: IncomingMessage | undefined;
      let finishing = false;

      const requestOptions: RequestOptions = {
        method: options.method ?? "GET",
        headers: {
          ...options.headers,
          connection: "close",
          "user-agent": this.#userAgent,
        },
        agent: this.#agent,
      };
      if (options.signal !== undefined) {
        requestOptions.signal = options.signal;
      }

      const request = this.#request(url, requestOptions, (incoming) => {
        response = incoming;
        incoming.once("error", fail);
        incoming.once("aborted", () => {
          fail(new IncompleteResponseError());
        });

        void consume({
          statusCode: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: incoming,
        }).then(
          (value) => {
            if (!incoming.complete || !incoming.readableEnded) {
              fail(new IncompleteResponseError());
              return;
            }
            void finish({ value });
          },
          fail,
        );
      });

      request.once("socket", (socket) => {
        assignedSocket = socket;
        waitForSocketClose = socket.destroyed
          ? Promise.resolve()
          : new Promise<void>((closed) => socket.once("close", closed));
        this.#onSocket?.(socket);
      });
      request.once("error", fail);
      request.end();

      function fail(error: unknown): void {
        if (finishing) {
          return;
        }
        // Claim the outcome before teardown emits nested error/aborted events.
        // finish() sets `finishing` synchronously before its first await.
        const settlement = finish({ error });
        if (response !== undefined && !response.destroyed) {
          response.destroy(asError(error));
        }
        if (!request.destroyed) {
          request.destroy(asError(error));
        }
        void settlement;
      }

      async function finish(outcome: { readonly value: T } | { readonly error: unknown }): Promise<void> {
        if (finishing) {
          return;
        }
        finishing = true;

        try {
          await waitForSocketClose;
        } catch (closeError) {
          reject(closeError);
          return;
        }

        if ("error" in outcome) {
          reject(outcome.error);
          return;
        }

        resolve({
          statusCode: response?.statusCode ?? 0,
          headers: response?.headers ?? {},
          value: outcome.value,
        });
      }

      // Preserve the reference until finish() has observed its close event.
      void assignedSocket;
    });
  }
}

export function createHttpsTransport(options: HttpsTransportOptions): NodeHttpTransport {
  const agent = new HttpsAgent({
    keepAlive: false,
    maxSockets: 1,
    maxTotalSockets: 1,
  });

  return new NodeHttpTransport({
    protocol: "https:",
    request: httpsRequest,
    agent,
    userAgent: options.userAgent,
    ...(options.onSocket === undefined ? {} : { onSocket: options.onSocket }),
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
