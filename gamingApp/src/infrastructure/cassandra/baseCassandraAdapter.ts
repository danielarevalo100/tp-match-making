import { errors, type Client } from "cassandra-driver";

import { BaseAdapter } from "../baseAdapter.js";

export abstract class BaseCassandraAdapter extends BaseAdapter {
  protected readonly engine = "cassandra";

  constructor(protected readonly client: Client) {
    super();
  }

  protected isDriverError(error: unknown): boolean {
    return error instanceof errors.DriverError;
  }
}
