# Template service

Copy-ready Node.js 24, TypeScript, and Express 5 REST API. It includes strict type checking, development reloads, tests, security headers, request IDs, health endpoints, graceful shutdown, and a production multi-stage Docker image.

## Create a service from the template

From the repository root, copy the directory and choose a kebab-case service name:

```powershell
Copy-Item -Recurse services/template-service services/players-service
```

On macOS or Linux:

```bash
cp -R services/template-service services/players-service
```

Then make these small changes:

1. Replace `template-service` in `package.json` and `.env.example` with the new service name.
2. Add the service's routes and business code under `src/`.
3. Add only the database clients and connection environment variables that the service needs.
4. Add the service to the root `docker-compose.yml`, selecting an unused host port.

Do not copy `node_modules` or `dist`; both are ignored.

## Run locally

```bash
npm install
npm run dev
```

The default endpoints are:

- `GET /` — basic service information
- `GET /health` — liveness check
- `GET /ready` — readiness check; extend this with real dependency checks

## Validate

```bash
npm run typecheck
npm test
npm run build
```

## Run with Docker

```bash
docker build -t players-service services/players-service
docker run --rm -p 3001:3000 -e SERVICE_NAME=players-service players-service
```

Example root Compose entry:

```yaml
  players-service:
    build:
      context: ./services/players-service
    environment:
      SERVICE_NAME: players-service
      PORT: 3000
    ports:
      - "3001:3000"
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))",
        ]
    restart: unless-stopped
    networks:
      - gaming-network
```

Add `depends_on` with `condition: service_healthy` only for infrastructure the service actually uses. The service must still retry failed connections at runtime.
