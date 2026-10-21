export type StorageEngine = "mongo" | "redis" | "cassandra" | "neo4j";

/**
 * Base of every business error. The error handler answers with `status` and the body
 * `{ error: code, message, ...details }`, so each error only declares those values.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InjectedFailureError extends Error {
  constructor(readonly step: string) {
    super(`Injected failure at step ${step}.`);
    this.name = "InjectedFailureError";
  }
}

export class StorageError extends Error {
  constructor(
    readonly engine: StorageEngine,
    readonly step: string,
    cause: unknown,
  ) {
    super(`${engine} failed at step ${step}.`, { cause });
    this.name = "StorageError";
  }
}
