# Players service

REST API for player registration, profile lookup and account lifecycle management. It is based on `template-service` and uses clean boundaries with manual constructor injection:

```text
HTTP controller -> use case -> repository interface <- MongoDB repository
```

Domain and application code do not import Express or MongoDB.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/players` | Register a player |
| `GET` | `/players/:playerId` | Get a player |
| `GET` | `/players?limit=20&cursor=<uuid>` | List players with cursor pagination |
| `PATCH` | `/players/:playerId` | Update profile fields |
| `PATCH` | `/players/:playerId/status` | Set `active`, `inactive`, or `closed` |
| `GET` | `/health` | Process liveness |
| `GET` | `/ready` | MongoDB readiness |

Usernames and emails are trimmed and converted to lowercase before use. Countries are stored as uppercase ISO alpha-2 codes. Passwords are hashed with Node.js `scrypt` and never returned by the API.

This initial service does not implement authentication or authorization. Before exposing it outside the local development network, protect profile updates and restrict account-status changes to the appropriate player or administrator roles.

## Local development

Copy `.env.example` to `.env`, then ensure the root MongoDB container and schema are running:

```bash
docker compose up -d mongodb
./scripts/initialize-infrastructure.sh
```

On PowerShell, run `.\scripts\initialize-infrastructure.ps1` instead.

Then:

```bash
npm install
npm run dev
```

## Validation

```bash
npm run typecheck
npm test
npm run build
```

## Example registration

```bash
curl -X POST http://localhost:3001/players \
  -H "content-type: application/json" \
  -d '{"username":"player_one","email":"player@example.com","password":"a-secure-password","country":"AR","birthDate":"1995-04-12"}'
```
