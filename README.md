# Gaming Platform

Local infrastructure and application workspace for the Data Engineering II project.

## Requirements

- Docker Desktop, or Docker Engine with the Compose plugin
- Git

## First run

Create the local environment file:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env` instead. Change the local passwords in `.env`, then start the persistence engines and application services:

```bash
docker compose up -d
docker compose ps
```

Once all four containers report `healthy`, apply the idempotent base schema:

```powershell
.\scripts\initialize-infrastructure.ps1
```

On macOS or Linux, use `./scripts/initialize-infrastructure.sh` instead.

Load the test data (option 13 of the demo console, or `pnpm seed:reset` inside `gamingApp`). It empties the four engines and leaves the system ready for the eight problems; see [the gamingApp README](gamingApp/README.md#test-data-for-the-eight-problems).

Stop the environment without deleting persisted data:

```bash
docker compose down
```

Do not add `-v` unless you intentionally want to delete all local database data.

## Services

| Engine | Host port | Internal Compose address | Purpose |
|---|---:|---|---|
| Redis | `6379` | `redis:6379` | Low-latency state, queues, temporary data |
| MongoDB | `27017` | `mongodb:27017` | Operational domain documents |
| Cassandra | `9042` | `cassandra:9042` | High-volume events and history |
| Neo4j HTTP | `7474` | `neo4j:7474` | Browser UI |
| Neo4j Bolt | `7687` | `neo4j:7687` | Player relationship queries |
| Gaming API | `3001` | `gaming-app:3000` | Application layer REST API |

Ports are configurable in `.env`. Applications running in Compose must use the internal service names, while tools running directly on the host use `localhost`.

## Repository layout

```text
.
|-- docker-compose.yml
|-- docs/
|   `-- infrastructure.md
|-- gamingApp/
|-- infra/
|   |-- cassandra/init.cql
|   |-- mongo/init.js
|   |-- neo4j/init.cypher
|   `-- redis/README.md
`-- scripts/
    |-- initialize-infrastructure.ps1
    `-- initialize-infrastructure.sh
```

The schema files are intentionally minimal until access patterns and ownership are agreed. MongoDB runs its bootstrap script when its data volume is first created; the explicit initialization script safely reapplies it and applies the Cassandra and Neo4j base schemas.

See [the infrastructure guide](docs/infrastructure.md) for health checks, connection strings, troubleshooting, and pending architecture decisions.

## Application layer

The application layer lives in [`gamingApp`](gamingApp/), a single Node.js and TypeScript REST API organized in feature modules under `src/api/modules`. It is available at `http://localhost:3001` when the full Compose stack is running. Its README covers the folder layout, local development, validation and fault injection.

## Demo console

`consola.cmd` (or `node scripts/consola.mjs`) opens an interactive menu for presenting the project. It asks for data (username, country, game mode, event type, match results), sends it to the API, and then reads each engine directly to show where every piece ended up: for example, one match event written to Cassandra and to the Redis scoreboard at the same time, with an optional injected failure between both writes and its repair. Option 9 sanctions a player and voids the chosen matches (problem 8), optionally with a failure half way, and shows the reversal journal, the ratings against the leaderboard, the history and the graph; option 10 resumes an incomplete reversal. Option 11 runs the whole flow step by step, from registering two players to sanctioning the winner. Option 13 empties every engine and reloads the test data, so a presentation always starts from the same state.

It needs the full Compose stack running with the schema applied, and the `gamingApp` dependencies installed (`pnpm install` inside `gamingApp`), because it borrows the app's database drivers.
