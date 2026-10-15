# Gaming app

Application layer REST API for the gaming platform. Every business process lives in a module under `src/api/modules`, and dependencies are wired by hand in `src/composition`.

## Layout

```text
src/
|-- server.ts
|-- config.ts
|-- composition/
|   |-- createContainer.ts
|   `-- <module>Composition.ts
|-- shared/
|   |-- errors.ts
|   |-- password.ts
|   |-- requestContext.ts
|   `-- storageKeys.ts
|-- infrastructure/
|   |-- baseAdapter.ts
|   `-- mongo/
|       |-- mongoConnection.ts
|       `-- baseMongoAdapter.ts
`-- api/
    |-- app.ts
    |-- errorHandler.ts
    |-- middlewares/
    `-- modules/
        `-- <module>/
            |-- business/
            |   |-- models/
            |   |-- ports/
            |   `-- services/
            |-- infrastructure/
            |   |-- adapters/
            |   `-- mappers/
            `-- presentation/
                |-- controllers/
                |-- routers/
                `-- schemas/
test/
|-- support/
|   `-- inMemory/
`-- unit/
```

- **Service**: business logic of the module. It depends only on the interfaces declared in `ports/`.
- **Adapter**: implements a port against one database. Database adapters extend the base adapter for their engine (`BaseMongoAdapter`), which extends `BaseAdapter`.
- **Mapper**: converts between database documents and models, and maps driver errors to business errors.
- **Controller**: validates the request with the module schemas, calls the service and writes the response.
- **Composition**: each `<module>Composition.ts` builds the adapters, service, controller and router of one module and returns the path where it is mounted.

Files and folders use camelCase.

## Base adapter

Every adapter method runs through `BaseAdapter.run(step, operation)`:

- if the request asked to fail at `step`, it throws `InjectedFailureError` before touching the database;
- driver errors are wrapped in `StorageError` with the engine and step;
- business errors are rethrown unchanged.

## Fault injection

Send the `x-fail-at` header with the step name to force a failure at that step:

```bash
curl -X POST http://localhost:3001/players \
  -H "content-type: application/json" \
  -H "x-fail-at: players.create" \
  -d '{"username":"player_one","email":"player@example.com","password":"a-secure-password","country":"AR"}'
```

The response is `500` with `{"error":"INJECTED_FAILURE","step":"players.create"}`.

## Modules

### players

| Method  | Path                              | Purpose                               |
| ------- | --------------------------------- | ------------------------------------- |
| `POST`  | `/players`                        | Register a player                     |
| `GET`   | `/players/:playerId`              | Get a player                          |
| `GET`   | `/players?limit=20&cursor=<uuid>` | List players with cursor pagination   |
| `PATCH` | `/players/:playerId`              | Update profile fields                 |
| `PATCH` | `/players/:playerId/status`       | Set `active`, `inactive`, or `closed` |

Usernames and emails are trimmed and converted to lowercase before use. Countries are stored as uppercase ISO alpha-2 codes. Passwords are hashed with Node.js `scrypt` and never returned by the API.

The API does not implement authentication or authorization. Before exposing it outside the local development network, protect profile updates and restrict account-status changes to the appropriate player or administrator roles.

## Shared endpoints

| Method | Path      | Purpose           |
| ------ | --------- | ----------------- |
| `GET`  | `/health` | Process liveness  |
| `GET`  | `/ready`  | MongoDB readiness |

## Local development

From the repository root, copy `.env.example` to `.env` and ensure the MongoDB container and schema are running:

```bash
docker compose up -d mongodb
./scripts/initialize-infrastructure.sh
```

On PowerShell, run `.\scripts\initialize-infrastructure.ps1` instead.

The project uses pnpm, pinned in the `packageManager` field of `package.json`. Enable it once with Corepack:

```bash
corepack enable
```

Then, from `gamingApp`:

```bash
pnpm install
pnpm dev
```

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

`pnpm lint:fix` and `pnpm format` apply automatic fixes. ESLint uses `typescript-eslint` with type-checked rules and `eslint-config-prettier`, so formatting is left to Prettier.

## Example registration

```bash
curl -X POST http://localhost:3001/players \
  -H "content-type: application/json" \
  -d '{"username":"player_one","email":"player@example.com","password":"a-secure-password","country":"AR","birthDate":"1995-04-12"}'
```
