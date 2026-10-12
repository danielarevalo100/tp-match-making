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

On macOS or Linux, use `cp .env.example .env` instead. Change the local passwords in `.env`, then start the four persistence engines:

```bash
docker compose up -d
docker compose ps
```

Once all four containers report `healthy`, apply the idempotent base schema:

```powershell
.\scripts\initialize-infrastructure.ps1
```

On macOS or Linux, use `./scripts/initialize-infrastructure.sh` instead.

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

Ports are configurable in `.env`. Applications running in Compose must use the internal service names, while tools running directly on the host use `localhost`.

## Repository layout

```text
.
|-- docker-compose.yml
|-- docs/
|   `-- infrastructure.md
|-- infra/
|   |-- cassandra/init.cql
|   |-- mongo/init.js
|   `-- neo4j/init.cypher
|-- scripts/
|   |-- initialize-infrastructure.ps1
|   `-- initialize-infrastructure.sh
`-- services/
    |-- README.md
    `-- template-service/
```

The schema files are intentionally minimal until access patterns and ownership are agreed. MongoDB runs its bootstrap script when its data volume is first created; the explicit initialization script safely reapplies it and applies the Cassandra and Neo4j base schemas.

See [the infrastructure guide](docs/infrastructure.md) for health checks, connection strings, troubleshooting, and pending architecture decisions.

## Create an application service

Use [`services/template-service`](services/template-service/) as the starting point for Node.js and TypeScript REST APIs. Its README covers copying, renaming, local development, validation, Docker builds, and Compose integration.
