export type StorageEngine = "mongo" | "redis" | "cassandra" | "neo4j";

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
