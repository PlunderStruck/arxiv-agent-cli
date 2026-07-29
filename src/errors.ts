export type ExitCode = 2 | 3 | 4 | 5 | 6;

export type ErrorKind =
  | "usage"
  | "not_found"
  | "upstream"
  | "rate_limit"
  | "local_state";

export class CliError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly exitCode: ExitCode,
    message: string,
    readonly correction: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
  }
}

export function usageError(message: string, correction: string): CliError {
  return new CliError("usage", 2, message, correction);
}

export function notFoundError(message: string, correction: string): CliError {
  return new CliError("not_found", 3, message, correction);
}

export function upstreamError(
  message: string,
  correction = "retry the command later",
  options?: ErrorOptions,
): CliError {
  return new CliError("upstream", 4, message, correction, options);
}

export function rateLimitError(message: string, correction: string): CliError {
  return new CliError("rate_limit", 5, message, correction);
}

export function localStateError(
  message: string,
  correction: string,
  options?: ErrorOptions,
): CliError {
  return new CliError("local_state", 6, message, correction, options);
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  return upstreamError(
    error instanceof Error ? error.message : String(error),
    "retry the command; use ARXIV_DEBUG=1 for diagnostic events",
    { cause: error },
  );
}

export interface JsonErrorEnvelope {
  readonly schemaVersion: 1;
  readonly cliVersion: string;
  readonly error: {
    readonly kind: ErrorKind;
    readonly message: string;
    readonly correction: string;
    readonly exitCode: ExitCode;
  };
}

export function jsonErrorEnvelope(error: CliError, cliVersion: string): JsonErrorEnvelope {
  return {
    schemaVersion: 1,
    cliVersion,
    error: {
      kind: error.kind,
      message: error.message,
      correction: error.correction,
      exitCode: error.exitCode,
    },
  };
}
