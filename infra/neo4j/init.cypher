CREATE CONSTRAINT player_id_unique IF NOT EXISTS
FOR (player:Player)
REQUIRE player.id IS UNIQUE;

// Problem 7: co-participation graph, (:Player)-[:PLAYED {result, ratingDelta}]->(:Match).
// Match.id is the same matchId used by every other engine.
CREATE CONSTRAINT match_id_unique IF NOT EXISTS
FOR (match:Match)
REQUIRE match.id IS UNIQUE;

// Detection only looks at matches inside a time window.
CREATE INDEX match_ended_at IF NOT EXISTS
FOR (match:Match)
ON (match.endedAtMs);
