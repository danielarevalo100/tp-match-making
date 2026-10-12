# Local infrastructure

## Scope

The initial environment uses Docker Compose to run Redis, MongoDB, Cassandra, and Neo4j. This is an architecture hypothesis: the final ownership of data must follow the access patterns required by the project assignment.

## Start and stop

From the repository root:

```bash
docker compose config
docker compose up -d
docker compose ps
```

After the services are healthy, apply or reapply the idempotent base schema:

```powershell
.\scripts\initialize-infrastructure.ps1
```

On macOS or Linux:

```bash
./scripts/initialize-infrastructure.sh
```

Follow startup logs with:

```bash
docker compose logs -f redis mongodb cassandra neo4j
```

Stop containers while retaining named volumes:

```bash
docker compose down
```

`docker compose down -v` deletes all database volumes and should only be used for an intentional full reset.

## Connections

Services running on the Compose network use these values:

```dotenv
REDIS_URL=redis://redis:6379
MONGODB_URI=mongodb://gaming_admin:change_me_local_only@mongodb:27017/gaming?authSource=admin
CASSANDRA_CONTACT_POINTS=cassandra
CASSANDRA_PORT=9042
NEO4J_URI=bolt://neo4j:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=change_me_local_only
```

Use values from the local `.env`, rather than copying the example passwords into application configuration. Tools running outside Compose connect to `localhost` and the published ports.

## Initialization behavior

- Redis has no schema initialization.
- MongoDB executes `infra/mongo/init.js` only when a fresh database volume is initialized.
- Cassandra mounts `infra/cassandra/init.cql` at `/opt/gaming/init.cql` for explicit execution after Cassandra is healthy.
- Neo4j mounts `infra/neo4j/init.cypher` at `/opt/gaming/init.cypher` for explicit execution after Neo4j is healthy.

The cross-platform scripts under `scripts/` apply all three definitions. They currently contain safe, idempotent base schema only. As domain queries become concrete, add tables, constraints, and indexes deliberately rather than modeling every entity in every database.

## Application services

Application code belongs under `services/`. Each service should have a defined business responsibility, a Dockerfile, environment-based configuration, retry logic for its dependencies, tests, and an API health endpoint where applicable.

Do not create one microservice per entity. Service boundaries and implementation language remain open decisions.

## Acceptance checks

- `docker compose config` succeeds.
- All four containers reach `healthy`.
- Published ports are free or overridden in `.env`.
- Data survives `docker compose down` followed by `docker compose up -d`.
- Containers connect through service names, not `localhost`.
- A new team member can start the stack from this documentation alone.

## Pending decisions

- Pin exact image patch versions after testing on the team's machines.
- Select the language and framework for application services.
- Define access patterns, schema ownership, and final service boundaries.
- Add idempotent schema and test-data commands for the required minimum dataset.
