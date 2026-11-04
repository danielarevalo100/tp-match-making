export function allowedOrigins(port) {
  return new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}

export function isOriginAllowed(origin, allowed) {
  return allowed.has(origin);
}
