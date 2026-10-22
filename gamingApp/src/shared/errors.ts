export const storageEngines = ["mongo", "redis", "cassandra", "neo4j"] as const;
export type StorageEngine = (typeof storageEngines)[number];

/**
 * Base de todos los errores de negocio. El error handler responde con `status` y el cuerpo
 * `{ error: code, message, ...details }`, así cada error solo declara esos valores.
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

/** Falla simulada con el header `x-fail-db`: la escritura no llegó a la base. */
export class InjectedFailureError extends Error {
  constructor(readonly engine: StorageEngine) {
    super(`Injected ${engine} failure.`);
    this.name = "InjectedFailureError";
  }
}

/** Error real del driver de una base (caída, timeout...). */
export class StorageError extends Error {
  constructor(
    readonly engine: StorageEngine,
    cause: unknown,
  ) {
    super(`${engine} failed.`, { cause });
    this.name = "StorageError";
  }
}
