-- El keyspace y las tablas se aplican de forma idempotente con scripts/initialize-infrastructure.*.
-- Agregar una tabla solo junto con la consulta que resuelve (ver docs/problema3.md).
CREATE KEYSPACE IF NOT EXISTS gaming
WITH replication = {
  'class': 'SimpleStrategy',
  'replication_factor': 1
};

-- Problemas 3 y 4: log que solo crece con todo lo que pasa durante una partida, incluido el
-- evento de ciclo de vida `match_finished` (que no tiene player_id).
-- Consultas que resuelve:
--   * todos los eventos de una partida, en orden   (WHERE match_id = ?)
--   * eventos de una partida en un rango de tiempo (WHERE match_id = ? AND ts >= ? AND ts <= ?)
-- Una partición por partida: una partida tiene una cantidad acotada de eventos, no crece para siempre.
-- event_id es la clave de idempotencia: insertar otra vez el mismo (match_id, ts, event_id) pisa
-- la misma fila, y además distingue eventos que pasan en el mismo milisegundo.
CREATE TABLE IF NOT EXISTS gaming.events_by_match (
  match_id         uuid,
  ts               timestamp,
  event_id         uuid,
  event_type       text,
  player_id        uuid,
  target_player_id uuid,
  detail           text,
  points           int,
  PRIMARY KEY ((match_id), ts, event_id)
) WITH CLUSTERING ORDER BY (ts ASC, event_id ASC);

-- Problema 6: historial de partidas de cada jugador, se escribe una vez al cerrar la partida y no se actualiza.
-- Consultas que resuelve:
--   * las últimas N partidas de un jugador      (WHERE player_id = ? LIMIT N)
--   * las partidas de un jugador en un período  (WHERE player_id = ? AND ended_at >= ? [AND ended_at < ?])
-- Una partición por jugador, la más nueva primero: las dos consultas leen una porción contigua.
-- Un jugador juega una cantidad acotada de partidas, así la partición no crece sin límite.
-- (player_id, ended_at, match_id) es la clave de idempotencia: proyectar otra vez la misma
-- partida pisa la misma fila.
CREATE TABLE IF NOT EXISTS gaming.match_history_by_player (
  player_id    uuid,
  ended_at     timestamp,
  match_id     uuid,
  mode         text,
  region       text,
  result       text,
  kills        int,
  deaths       int,
  objectives   int,
  score        int,
  mmr_before   int,
  mmr_after    int,
  rating_delta int,
  PRIMARY KEY ((player_id), ended_at, match_id)
) WITH CLUSTERING ORDER BY (ended_at DESC, match_id ASC);
