# Redis infrastructure

Redis does not require a schema initialization script. Its local-development configuration currently lives directly in the root `docker-compose.yml`:

- append-only persistence is enabled with `--appendonly yes`;
- data is stored in the named `redis_data` volume;
- readiness is checked with `redis-cli ping`;
- containers on `gaming-network` connect to `redis:6379`;
- host tools connect to `localhost` and `REDIS_PORT` from the root `.env`.

## Verify the connection

With the Compose stack running:

```bash
docker compose exec redis redis-cli ping
```

The expected response is `PONG`.

To inspect persistence information:

```bash
docker compose exec redis redis-cli INFO persistence
```

## Future additions

Add Redis configuration or repeatable seed scripts in this directory only when the application's access patterns require them. Keys used for caches, queues, locks, or temporary state should be documented with their naming convention and expiration policy.

Do not treat Redis seed data as durable source-of-truth data.
