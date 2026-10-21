import type { types } from "cassandra-driver";

import {
  matchEventTypes,
  type MatchEvent,
  type MatchLogEvent,
} from "../../business/models/matchEvent.js";

export function toMatchEvent(row: types.Row): MatchLogEvent {
  const type = row["event_type"] as string;
  const detail = row["detail"] as string | null;
  const common = {
    detail: detail ? (JSON.parse(detail) as Record<string, unknown>) : null,
    eventId: (row["event_id"] as types.Uuid).toString(),
    matchId: (row["match_id"] as types.Uuid).toString(),
    tsMs: (row["ts"] as Date).getTime(),
  };
  if (type === "match_finished") {
    return {
      ...common,
      playerId: null,
      points: 0,
      targetPlayerId: null,
      type,
    };
  }
  if (!(matchEventTypes as readonly string[]).includes(type)) {
    throw new Error(`Unknown event type in the log: ${type}`);
  }
  const player = row["player_id"] as types.Uuid | null;
  if (!player) throw new Error(`Gameplay event ${type} has no player_id.`);
  const target = row["target_player_id"] as types.Uuid | null;

  return {
    ...common,
    playerId: player.toString(),
    points: (row["points"] as number | null) ?? 0,
    targetPlayerId: target ? target.toString() : null,
    type: type as MatchEvent["type"],
  };
}
