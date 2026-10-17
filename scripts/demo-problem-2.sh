#!/usr/bin/env bash
# Problem 2 demo: forming a match (saga Redis reserve -> Mongo create -> Redis commit).
#
# Needs the Compose stack running (mongodb, redis and gaming-app). Uses throwaway
# players in the NA queue of ranked_1v1 and cleans up after itself. Shows:
#   1. happy path
#   2. rating range that widens with the wait
#   3. failure creating the match in Mongo      -> everyone back in the queue, same seniority
#   4. failure committing the match in Redis    -> same
#   5. a player leaves during the formation     -> the others go back, seniority kept
#   6. a formation left half-done is recovered, and recovering twice changes nothing
#
#   ./scripts/demo-problem-2.sh
#
# Overrides: APP_URL, MODE, REGION, MONGO_ROOT_USERNAME, MONGO_ROOT_PASSWORD

set -euo pipefail

cd "$(dirname "$0")/.."

APP_URL="${APP_URL:-http://127.0.0.1:3001}"
MODE="${MODE:-ranked_1v1}"
REGION="${REGION:-NA}"
MONGO_USER="${MONGO_ROOT_USERNAME:-gaming_admin}"
MONGO_PASSWORD="${MONGO_ROOT_PASSWORD:-change_me_local_only}"

BODY="$(mktemp)"
PLAYERS=()

redis_cli() { docker compose exec -T redis redis-cli "$@" | tr -d '\r'; }
mongo_eval() {
  docker compose exec -T mongodb mongosh --quiet -u "$MONGO_USER" -p "$MONGO_PASSWORD" \
    --authenticationDatabase admin gaming --eval "$1" | tr -d '\r'
}

FAILURES=0
STATUS=""
# call METHOD URL [JSON] [extra curl args...] -> sets STATUS, prints the body
call() {
  local method="$1" url="$2" data="${3:-}"
  shift 3 || shift $#
  if [ -n "$data" ]; then
    STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -X "$method" -H 'content-type: application/json' "$@" -d "$data" "$url")
  else
    STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -X "$method" "$@" "$url")
  fi
  sed 's/^/    /' "$BODY"; echo
}
expect() { # expect STATUS DESCRIPTION
  if [ "$STATUS" = "$1" ]; then echo "  OK   $2 (HTTP $STATUS)"; else echo "  FAIL $2: expected HTTP $1, got $STATUS"; FAILURES=$((FAILURES + 1)); fi
  echo
}
check() { # check ACTUAL EXPECTED DESCRIPTION
  if [ "$1" = "$2" ]; then echo "  OK   $3 ($1)"; else echo "  FAIL $3: expected '$2', got '$1'"; FAILURES=$((FAILURES + 1)); fi
}
json_field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$BODY" | head -1; }

new_player() { # new_player MMR -> prints playerId
  local suffix="$(date +%s)$RANDOM" id
  curl -s -o "$BODY" -X POST -H 'content-type: application/json' \
    -d "{\"username\":\"p2_$suffix\",\"email\":\"p2_$suffix@example.com\",\"password\":\"a-secure-password\",\"country\":\"US\"}" "$APP_URL/players"
  id="$(json_field id)"
  mongo_eval "db.players.updateOne({_id:'$id'},{\$set:{'ratings.$MODE':{mmr:$1,gamesPlayed:0,updatedAt:new Date()}}})" >/dev/null
  PLAYERS+=("$id")
  echo "$id"
}
enqueue() { curl -s -o /dev/null -X POST -H 'content-type: application/json' -d "{\"mode\":\"$MODE\",\"playerId\":\"$1\",\"region\":\"$REGION\"}" "$APP_URL/matchmaking/queue"; }
set_seniority() { # set_seniority PLAYER ENQUEUED_AT_MS
  redis_cli HSET "mm:ticket:$1" enqueuedAt "$2" >/dev/null
  redis_cli ZADD "mm:q:$MODE:$REGION:wait" "$2" "$1" >/dev/null
}
form() { call POST "$APP_URL/matchmaking/matches/form" "{\"mode\":\"$MODE\",\"region\":\"$REGION\"}" "$@"; }
queue_state() { # prints: wait ZSET with scores
  redis_cli ZRANGE "mm:q:$MODE:$REGION:wait" 0 -1 WITHSCORES | paste -sd' ' -
}

reset_queue() {
  for id in "${PLAYERS[@]:-}"; do
    [ -n "$id" ] || continue
    curl -s -o /dev/null -X DELETE "$APP_URL/matchmaking/queue/$id" || true
    redis_cli DEL "mm:ticket:$id" "player:$id:active_match" >/dev/null || true
  done
  redis_cli DEL "mm:q:$MODE:$REGION:rating" "mm:q:$MODE:$REGION:wait" >/dev/null
  PLAYERS=()
}
cleanup() {
  reset_queue || true
  mongo_eval "db.matches.deleteMany({'players.playerId': {\$in: []}})" >/dev/null 2>&1 || true
  rm -f "$BODY"
}
trap cleanup EXIT

match_docs() { mongo_eval "db.matches.countDocuments({'players.playerId':'$1'})" | tail -1; }

reset_queue
OLD=$(( $(date +%s) * 1000 - 60000 ))
OLDER=$(( OLD - 10000 ))

echo "== 1. Happy path: two players with close rating"
A=$(new_player 1000); B=$(new_player 1030); enqueue "$A"; enqueue "$B"
form
expect 201 "match formed"
MATCH_ID="$(json_field matchId)"
check "$(redis_cli ZCARD "mm:q:$MODE:$REGION:wait")" "0" "queue is empty"
check "$(redis_cli GET "player:$A:active_match")" "$MATCH_ID" "A has the active match"
check "$(redis_cli HGET "match:$MATCH_ID" status)" "in_progress" "live match in Redis"
check "$(match_docs "$A")" "1" "match document in Mongo"
mongo_eval "db.matches.deleteOne({_id:'$MATCH_ID'})" >/dev/null; reset_queue
echo

echo "== 2. Range widens with the wait (A=1000, B=1120; initial range 50, +50 every 15s)"
A=$(new_player 1000); B=$(new_player 1120); enqueue "$A"; enqueue "$B"
form
check "$(json_field status)" "not_enough_players" "no match yet: 120 apart > range 50"
set_seniority "$A" "$OLD"   # waited ~60s -> range 250
form
expect 201 "match formed once the range widened"
MATCH_ID="$(json_field matchId)"
mongo_eval "db.matches.deleteOne({_id:'$MATCH_ID'})" >/dev/null; reset_queue
echo

echo "== 3. Failure creating the match in Mongo (x-fail-at: matchmaking.createMatch)"
A=$(new_player 1000); B=$(new_player 1010); enqueue "$A"; enqueue "$B"
set_seniority "$A" "$OLDER"; set_seniority "$B" "$OLD"
echo "  queue before: $(queue_state)"
form -H 'x-fail-at: matchmaking.createMatch'
expect 500 "formation fails"
echo "  queue after:  $(queue_state)"
check "$(queue_state)" "$A $OLDER $B $OLD" "both back in the queue with the original enqueuedAt"
check "$(redis_cli EXISTS "player:$A:active_match" "player:$B:active_match")" "0" "no active_match left"
check "$(match_docs "$A")" "0" "no match document in Mongo"
echo

echo "== 4. Failure committing in Redis, after Mongo already has the match (x-fail-at: matchmaking.commit)"
form -H 'x-fail-at: matchmaking.commit'
expect 500 "formation fails"
check "$(queue_state)" "$A $OLDER $B $OLD" "both back in the queue with the original enqueuedAt"
check "$(match_docs "$A")" "0" "Mongo match document was compensated (deleted)"
echo

echo "== 5. A reserved player leaves during the formation (x-pause-after-reserve-ms: 3000)"
form -H 'x-pause-after-reserve-ms: 3000' > /tmp/p2_form.out &
FORM_PID=$!
sleep 1
call DELETE "$APP_URL/matchmaking/queue/$A"
expect 204 "A leaves while the match is being formed"
wait "$FORM_PID" || true
cat /tmp/p2_form.out; rm -f /tmp/p2_form.out
check "$(queue_state)" "$B $OLD" "B is back in the queue with the original enqueuedAt; A is gone"
check "$(redis_cli EXISTS "player:$A:active_match" "player:$B:active_match")" "0" "no active_match left"
check "$(match_docs "$B")" "0" "no match document in Mongo"
echo

echo "== 6. Formation interrupted after the reservation is recovered, idempotently"
reset_queue
A=$(new_player 1000); B=$(new_player 1010); enqueue "$A"; enqueue "$B"
set_seniority "$A" "$OLDER"; set_seniority "$B" "$OLD"
# Simulate a request that stalls right after the reservation (client gives up after 1s).
curl -s -m 1 -o /dev/null -X POST -H 'content-type: application/json' -H 'x-pause-after-reserve-ms: 5000' \
  -d "{\"mode\":\"$MODE\",\"region\":\"$REGION\"}" "$APP_URL/matchmaking/matches/form" || true
echo "  queue while reserved: '$(queue_state)' (players are held by the formation)"
check "$(redis_cli ZCARD mm:formations)" "1" "one pending formation indexed"
call POST "$APP_URL/matchmaking/matches/recover" '{"olderThanMs":0}'
expect 200 "recover endpoint"
check "$(queue_state)" "$A $OLDER $B $OLD" "players restored with the original enqueuedAt"
call POST "$APP_URL/matchmaking/matches/recover" '{"olderThanMs":0}'
check "$(queue_state)" "$A $OLDER $B $OLD" "second recover changes nothing"
sleep 5   # the stalled request wakes up, finds its formation rolled back and compensates again
check "$(queue_state)" "$A $OLDER $B $OLD" "late request did not break the restored queue"
check "$(match_docs "$A")" "0" "no orphan match document in Mongo"
echo

if [ "$FAILURES" -eq 0 ]; then echo "All checks passed."; else echo "$FAILURES check(s) FAILED."; exit 1; fi
