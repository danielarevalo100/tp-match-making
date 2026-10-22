import { InjectedFailureError, type StorageEngine } from "../../src/shared/errors.js";

type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

/**
 * Hace fallar la próxima llamada a `method` de un doble en memoria. Sirve para probar un paso
 * puntual que `x-fail-db` no alcanza (ese header solo hace fallar la primera escritura de cada
 * base). Con `afterRunning` la operación se ejecuta y recién después falla, como una respuesta
 * que se pierde.
 */
export function failOnce<T extends object>(
  target: T,
  method: keyof T & string,
  engine: StorageEngine,
  options: { afterRunning?: boolean } = {},
): void {
  const methods = target as unknown as Record<string, AsyncMethod>;
  const original = methods[method] as AsyncMethod;
  const wasOwn = Object.hasOwn(target, method);

  methods[method] = async (...args: unknown[]) => {
    if (wasOwn) methods[method] = original;
    else delete methods[method];
    if (options.afterRunning) await original.apply(target, args);
    throw new InjectedFailureError(engine);
  };
}
