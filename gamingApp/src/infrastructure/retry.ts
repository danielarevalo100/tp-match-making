/**
 * Ejecuta `connect` hasta que funcione, esperando `delayMs` entre intentos. Las bases pueden
 * estar arrancando cuando arranca la app (docker compose), así que es normal que fallen los
 * primeros intentos.
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
