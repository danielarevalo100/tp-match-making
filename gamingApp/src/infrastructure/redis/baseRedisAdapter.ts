import type { Redis } from "ioredis";

import { BaseAdapter } from "../baseAdapter.js";

export abstract class BaseRedisAdapter extends BaseAdapter {
  protected readonly engine = "redis";

  constructor(protected readonly redis: Redis) {
    super();
  }

  protected isDriverError(error: unknown): boolean {
    return error instanceof Error;
  }
}
