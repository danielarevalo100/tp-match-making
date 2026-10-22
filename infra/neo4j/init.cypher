CREATE CONSTRAINT player_id_unique IF NOT EXISTS
FOR (player:Player)
REQUIRE player.id IS UNIQUE;

// Problema 7: grafo de coparticipación, (:Player)-[:PLAYED {result, ratingDelta}]->(:Match).
// Match.id es el mismo matchId que usan todas las demás bases.
CREATE CONSTRAINT match_id_unique IF NOT EXISTS
FOR (match:Match)
REQUIRE match.id IS UNIQUE;

// La detección solo mira partidas dentro de una ventana de tiempo.
CREATE INDEX match_ended_at IF NOT EXISTS
FOR (match:Match)
ON (match.endedAtMs);
