import { Redis } from "ioredis";

type RetryOptions = {
  attempts: number;
  delayMs: number;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function connectToRedis(url: string, retry: RetryOptions): Promise<Redis> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    // No automatic reconnection while starting up: a failed attempt must
    // reject so the loop below can retry with its own delay.
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    client.on("error", () => undefined);

    try {
      await client.connect();
      await client.ping();
      // Once connected, reconnect on its own if Redis restarts; commands issued
      // meanwhile fail fast (maxRetriesPerRequest) instead of hanging.
      client.options.retryStrategy = (times: number) => Math.min(times * 200, 2_000);
      return client;
    } catch (error: unknown) {
      lastError = error;
      client.disconnect();
      if (attempt < retry.attempts) await delay(retry.delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Redis connection failed for an unspecified reason.");
}
