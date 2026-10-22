import { StorageError, type StorageEngine } from "../shared/errors.js";
import { failIfRequested } from "../shared/requestContext.js";

/**
 * Base de todos los adapters. Cada operación contra la base pasa por `read` o `write`:
 * - los errores del driver se envuelven en `StorageError` (503) con el nombre de la base;
 * - `write` además aplica la falla simulada del header `x-fail-db`.
 */
export abstract class BaseAdapter {
  protected abstract readonly engine: StorageEngine;

  protected abstract isDriverError(error: unknown): boolean;

  protected read<T>(operation: () => Promise<T>): Promise<T> {
    return this.execute(operation);
  }

  protected async write<T>(operation: () => Promise<T>): Promise<T> {
    failIfRequested(this.engine);
    return this.execute(operation);
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (this.isDriverError(error)) throw new StorageError(this.engine, error);
      throw error;
    }
  }
}
