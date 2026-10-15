import { InjectedFailureError, StorageError, type StorageEngine } from "../shared/errors.js";
import { requestContext } from "../shared/requestContext.js";

export abstract class BaseAdapter {
  protected abstract readonly engine: StorageEngine;

  protected abstract isDriverError(error: unknown): boolean;

  protected async run<T>(step: string, operation: () => Promise<T>): Promise<T> {
    if (requestContext.getStore()?.failAt === step) {
      throw new InjectedFailureError(step);
    }

    try {
      return await operation();
    } catch (error: unknown) {
      if (this.isDriverError(error)) throw new StorageError(this.engine, step, error);
      throw error;
    }
  }
}
