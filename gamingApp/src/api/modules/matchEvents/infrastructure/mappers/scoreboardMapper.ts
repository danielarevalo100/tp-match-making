import type { LiveMatch, PlayerScore, Scoreboard } from "../../business/models/matchEvent.js";

export function toLiveMatch(fields: Record<string, string>): LiveMatch | null {
  const { matchId, mode, players, region, startedAt, status } = fields;
  if (!matchId || !mode || !region || !status) return null;
  return {
    matchId,
    mode,
    players: players ? players.split(",").filter((playerId) => playerId.length > 0) : [],
    region,
    startedAt: Number(startedAt ?? 0),
    status,
  };
}

/**
 * Builds the scoreboard from the two Redis hashes. Every player of the match is listed, also
 * those without events yet, so the consumer does not have to know who is playing.
 */
export function toScoreboard(match: LiveMatch, board: Record<string, string>): Scoreboard {
  const number = (field: string): number => Number(board[field] ?? 0);
  const players: PlayerScore[] = match.players.map((playerId) => ({
    connected: board[`${playerId}:connected`] !== "0",
    deaths: number(`${playerId}:deaths`),
    kills: number(`${playerId}:kills`),
    objectives: number(`${playerId}:objectives`),
    playerId,
    score: number(`${playerId}:score`),
  }));
  players.sort(
    (a, b) =>
      b.score - a.score ||
      b.kills - a.kills ||
      a.deaths - b.deaths ||
      a.playerId.localeCompare(b.playerId),
  );

  return {
    eventCount: number("events"),
    lastEventTsMs: board["lastEventTs"] ? Number(board["lastEventTs"]) : null,
    matchId: match.matchId,
    mode: match.mode,
    players,
    region: match.region,
    startedAt: match.startedAt,
    status: match.status,
  };
}
