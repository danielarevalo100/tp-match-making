import { MongoError, type Db } from "mongodb";

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
