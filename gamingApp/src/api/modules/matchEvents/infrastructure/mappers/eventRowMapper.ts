import type { types } from "cassandra-driver";

import { matchEventTypes, type MatchEvent } from "../../business/models/matchEvent.js";

export function toMatchEvent(row: types.Row): MatchEvent {
  const type = row["event_type"] as string;
  if (!(matchEventTypes as readonly string[]).includes(type)) {
    throw new Error(`Unknown event type in the log: ${type}`);
  }
  const target = row["target_player_id"] as types.Uuid | null;
  const detail = row["detail"] as string | null;

  return {
    detail: detail ? (JSON.parse(detail) as Record<string, unknown>) : null,
    eventId: (row["event_id"] as types.Uuid).toString(),
    matchId: (row["match_id"] as types.Uuid).toString(),
    playerId: (row["player_id"] as types.Uuid).toString(),
    points: (row["points"] as number | null) ?? 0,
    targetPlayerId: target ? target.toString() : null,
    tsMs: (row["ts"] as Date).getTime(),
    type: type as MatchEvent["type"],
  };
}
