#!/usr/bin/env bash
# Demo del problema 1: entrar a una cola de matchmaking.
#
# Necesita el stack de Compose corriendo (mongodb, redis y gaming-app). Registra un jugador
# descartable y recorre todas las reglas: éxito, reintento idempotente, segunda cola, partida
# activa, sanción en vigor y una ráfaga concurrente. Limpia lo que crea al terminar.
#
#   ./scripts/demo-problem-1.sh
#
# Se puede cambiar: PLAYERS_URL, MATCHMAKING_URL, MODE, MONGO_ROOT_USERNAME, MONGO_ROOT_PASSWORD

set -euo pipefail

cd "$(dirname "$0")/.."

PLAYERS_URL="${PLAYERS_URL:-http://localhost:3001}"
MATCHMAKING_URL="${MATCHMAKING_URL:-http://localhost:3001}"
MODE="${MODE:-ranked_1v1}"
MONGO_USER="${MONGO_ROOT_USERNAME:-gaming_admin}"
MONGO_PASSWORD="${MONGO_ROOT_PASSWORD:-change_me_local_only}"

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

redis_cli() { docker compose exec -T redis redis-cli "$@"; }
mongo_eval() {
  docker compose exec -T mongodb mongosh --quiet -u "$MONGO_USER" -p "$MONGO_PASSWORD" \
    --authenticationDatabase admin gaming --eval "$1"
}

FAILURES=0
# call MÉTODO URL [JSON] -> deja STATUS, imprime el cuerpo de la respuesta
call() {
  local method="$1" url="$2" data="${3:-}"
  if [ -n "$data" ]; then
    STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -X "$method" -H 'content-type: application/json' -d "$data" "$url")
  else
    STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -X "$method" "$url")
  fi
  cat "$BODY"; echo
}
expect() { # expect STATUS DESCRIPTION
  if [ "$STATUS" = "$1" ]; then echo "  OK   $2 (HTTP $STATUS)"; else echo "  FAIL $2: expected HTTP $1, got $STATUS"; FAILURES=$((FAILURES + 1)); fi
  echo
}

SUFFIX="$(date +%s)$RANDOM"
echo "== 1. Register a throwaway player (gaming-app)"
call POST "$PLAYERS_URL/players" "{\"username\":\"demo_$SUFFIX\",\"email\":\"demo_$SUFFIX@example.com\",\"password\":\"a-secure-password\",\"country\":\"AR\"}"
expect 201 "player registered"
PLAYER_ID="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$BODY")"
echo "playerId = $PLAYER_ID"
echo

cleanup() {
  call DELETE "$MATCHMAKING_URL/matchmaking/queue/$PLAYER_ID" >/dev/null 2>&1 || true
  redis_cli DEL "player:$PLAYER_ID:active_match" >/dev/null 2>&1 || true
  mongo_eval "db.sanctions.deleteMany({ playerId: '$PLAYER_ID' })" >/dev/null 2>&1 || true
  rm -f "$BODY"
}
trap cleanup EXIT

TICKET_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || node -e 'console.log(crypto.randomUUID())')"
JOIN="{\"playerId\":\"$PLAYER_ID\",\"mode\":\"$MODE\",\"ticketId\":\"$TICKET_ID\"}"

echo "== 2. Join the queue"
call POST "$MATCHMAKING_URL/matchmaking/queue" "$JOIN"
expect 201 "joined $MODE"

echo "== 3. Retry with the same ticketId (idempotent, no duplicate)"
call POST "$MATCHMAKING_URL/matchmaking/queue" "$JOIN"
expect 200 "replay returns the existing ticket"

echo "== 4. Join again with another ticketId (one queue at a time)"
call POST "$MATCHMAKING_URL/matchmaking/queue" "{\"playerId\":\"$PLAYER_ID\",\"mode\":\"$MODE\"}"
expect 409 "second queue rejected"

echo "== 5. Redis state"
REGION="$(call GET "$MATCHMAKING_URL/matchmaking/queue/$PLAYER_ID" | sed -n 's/.*"region":"\([^"]*\)".*/\1/p')"
echo "-- HGETALL mm:ticket:$PLAYER_ID"; redis_cli HGETALL "mm:ticket:$PLAYER_ID"
echo "-- ZRANGE mm:q:$MODE:$REGION:rating"; redis_cli ZRANGE "mm:q:$MODE:$REGION:rating" 0 -1 WITHSCORES
echo "-- ZRANGE mm:q:$MODE:$REGION:wait";   redis_cli ZRANGE "mm:q:$MODE:$REGION:wait" 0 -1 WITHSCORES
echo

echo "== 6. Leave the queue"
call DELETE "$MATCHMAKING_URL/matchmaking/queue/$PLAYER_ID"
expect 204 "left the queue"

echo "== 7. Active match blocks joining (player:<id>:active_match set by hand; problem 2 will set it)"
redis_cli SET "player:$PLAYER_ID:active_match" demo-match >/dev/null
call POST "$MATCHMAKING_URL/matchmaking/queue" "{\"playerId\":\"$PLAYER_ID\",\"mode\":\"$MODE\"}"
expect 409 "player with an active match rejected"
redis_cli DEL "player:$PLAYER_ID:active_match" >/dev/null

echo "== 8. Sanction in force blocks joining (inserted directly in MongoDB; problem 8 will create them)"
mongo_eval "db.sanctions.insertOne({ _id: crypto.randomUUID(), playerId: '$PLAYER_ID', adminId: crypto.randomUUID(), type: 'temporary_suspension', reason: 'demo', startsAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 3600000), status: 'active', createdAt: new Date() })" >/dev/null
call POST "$MATCHMAKING_URL/matchmaking/queue" "{\"playerId\":\"$PLAYER_ID\",\"mode\":\"$MODE\"}"
expect 403 "sanctioned player rejected"
mongo_eval "db.sanctions.deleteMany({ playerId: '$PLAYER_ID' })" >/dev/null

echo "== 9. 20 concurrent requests for the same player: exactly one must win"
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' \
    -d "{\"playerId\":\"$PLAYER_ID\",\"mode\":\"$MODE\"}" "$MATCHMAKING_URL/matchmaking/queue" &
done | sort | uniq -c
wait
IN_QUEUE="$(redis_cli ZSCORE "mm:q:$MODE:$REGION:rating" "$PLAYER_ID" | grep -c . || true)"
echo "  entries for the player in the rating ZSET: $IN_QUEUE (expected 1)"
[ "$IN_QUEUE" = "1" ] || FAILURES=$((FAILURES + 1))
echo

if [ "$FAILURES" -eq 0 ]; then echo "Problem 1 demo: all checks passed"; else echo "Problem 1 demo: $FAILURES check(s) failed"; exit 1; fi
