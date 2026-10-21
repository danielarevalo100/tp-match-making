#!/usr/bin/env sh
set -eu

echo "Applying MongoDB bootstrap..."
docker compose exec -T mongodb sh -c 'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --file /docker-entrypoint-initdb.d/001-init.js'

echo "Applying Cassandra schema..."
docker compose exec -T cassandra cqlsh -f /opt/gaming/init.cql

echo "Applying Neo4j schema..."
docker compose exec -T neo4j sh -c 'cypher-shell -u neo4j -p "${NEO4J_AUTH#*/}" -f /opt/gaming/init.cypher'

echo "Infrastructure schema is initialized."
