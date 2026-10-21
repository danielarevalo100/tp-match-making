import type { types } from "cassandra-driver";

import type { HistoryEntry } from "../../business/models/playerHistory.js";

export const historyColumns =
  "ended_at, match_id, mode, region, result, kills, deaths, objectives, score, mmr_before, mmr_after, rating_delta";

export function toHistoryEntry(row: types.Row): HistoryEntry {
  const count = (column: string): number => (row[column] as number | null) ?? 0;
  return {
    deaths: count("deaths"),
    endedAt: row["ended_at"] as Date,
    kills: count("kills"),
    matchId: (row["match_id"] as types.Uuid).toString(),
    mmrAfter: count("mmr_after"),
    mmrBefore: count("mmr_before"),
    mode: row["mode"] as string,
    objectives: count("objectives"),
    ratingDelta: count("rating_delta"),
    region: row["region"] as string,
    result: row["result"] as HistoryEntry["result"],
    score: count("score"),
  };
}
