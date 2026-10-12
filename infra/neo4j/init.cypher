// Base constraint only. Extend this file after defining graph access patterns.
CREATE CONSTRAINT player_id_unique IF NOT EXISTS
FOR (player:Player)
REQUIRE player.id IS UNIQUE;
