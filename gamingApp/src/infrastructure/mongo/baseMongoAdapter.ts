import { MongoError, MongoServerError, type Db } from "mongodb";

import { BaseAdapter } from "../baseAdapter.js";

export abstract class BaseMongoAdapter extends BaseAdapter {
  protected readonly engine = "mongo";

  constructor(protected readonly database: Db) {
    super();
  }

  protected isDriverError(error: unknown): boolean {
    return error instanceof MongoError;
  }
}

/** Un índice único (por ejemplo `_id`) rechazó la escritura. */
export function isDuplicateKeyError(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11_000;
}
