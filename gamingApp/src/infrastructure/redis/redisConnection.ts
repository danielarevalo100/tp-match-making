import { Redis } from "ioredis";

type RedisConnectionOptions = {
  attempts: number;
  delayMs: number;
  url: string;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function connectToRedis(options: RedisConnectionOptions): Promise<Redis> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const client = new Redis(options.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    client.on("error", () => undefined);

    try {
      await client.connect();
      await client.ping();
      client.options.retryStrategy = (times: number) => Math.min(times * 200, 2_000);
      return client;
    } catch (error: unknown) {
      lastError = error;
      client.disconnect();
      if (attempt < options.attempts) await delay(options.delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Redis connection failed for an unspecified reason.");
}
