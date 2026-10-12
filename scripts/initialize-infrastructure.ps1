$ErrorActionPreference = "Stop"

Write-Host "Applying MongoDB bootstrap..."
docker compose exec -T mongodb sh -c 'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --file /docker-entrypoint-initdb.d/001-init.js'
if ($LASTEXITCODE -ne 0) { throw "MongoDB initialization failed." }

Write-Host "Applying Cassandra schema..."
docker compose exec -T cassandra cqlsh -f /opt/gaming/init.cql
if ($LASTEXITCODE -ne 0) { throw "Cassandra initialization failed." }

Write-Host "Applying Neo4j schema..."
docker compose exec -T neo4j sh -c 'cypher-shell -u neo4j -p "${NEO4J_AUTH#*/}" -f /opt/gaming/init.cypher'
if ($LASTEXITCODE -ne 0) { throw "Neo4j initialization failed." }

Write-Host "Infrastructure schema is initialized."
