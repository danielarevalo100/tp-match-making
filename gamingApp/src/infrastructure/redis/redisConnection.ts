import { Redis } from "ioredis";

import { retry } from "../retry.js";

type RedisConnectionOptions = {
  attempts: number;
  delayMs: number;
  url: string;
};

export function connectToRedis(options: RedisConnectionOptions): Promise<Redis> {
  return retry(options.attempts, options.delayMs, async () => {
    // Sin reconexión automática mientras se conecta: `retry` decide cuándo volver a intentar.
    const client = new Redis(options.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    client.on("error", () => undefined);

    try {
      await client.connect();
      await client.ping();
      // Una vez conectado, se reconecta solo si se corta la conexión.
      client.options.retryStrategy = (times: number) => Math.min(times * 200, 2_000);
      return client;
    } catch (error: unknown) {
      client.disconnect();
      throw error;
    }
  });
}
