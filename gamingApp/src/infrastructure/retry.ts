/**
 * Runs `connect` until it succeeds, waiting `delayMs` between attempts. The databases may still
 * be starting when the app starts (docker compose), so the first attempts are expected to fail.
 */
export async function retry<T>(
  attempts: number,
  delayMs: number,
  connect: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connect();
    } catch (error: unknown) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
