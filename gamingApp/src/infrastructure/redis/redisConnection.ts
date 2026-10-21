import { Redis } from "ioredis";

import { retry } from "../retry.js";

type RedisConnectionOptions = {
  attempts: number;
  delayMs: number;
  url: string;
};

export function connectToRedis(options: RedisConnectionOptions): Promise<Redis> {
  return retry(options.attempts, options.delayMs, async () => {
    // No automatic reconnection while connecting: `retry` decides when to try again.
    const client = new Redis(options.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    client.on("error", () => undefined);

    try {
      await client.connect();
      await client.ping();
      // Once connected, reconnect by itself if the connection drops.
      client.options.retryStrategy = (times: number) => Math.min(times * 200, 2_000);
      return client;
    } catch (error: unknown) {
      client.disconnect();
      throw error;
    }
  });
}
