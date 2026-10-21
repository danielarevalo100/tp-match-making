export const mongoCollections = {
  gameModes: "game_modes",
  matches: "matches",
  players: "players",
  regions: "regions",
  sanctions: "sanctions",
  seasons: "seasons",
} as const;

export const cassandraTables = {
  eventsByMatch: "events_by_match",
} as const;

export const redisKeys = {
  activeMatch: (playerId: string): string => `player:${playerId}:active_match`,
  formation: (matchId: string): string => `mm:formation:${matchId}`,
  formationIndex: "mm:formations",
  leaderboardGlobal: (seasonId: string, mode: string): string => `lb:${seasonId}:${mode}:global`,
  /** Region-scoped boards are `{prefix}{region}`; the publish script builds the old region's key. */
  leaderboardRegionPrefix: (seasonId: string, mode: string): string =>
    `lb:${seasonId}:${mode}:region:`,
  leaderboardRegional: (seasonId: string, mode: string, region: string): string =>
    `lb:${seasonId}:${mode}:region:${region}`,
  leaderboardMembers: (seasonId: string, mode: string): string => `lb:${seasonId}:${mode}:members`,
  match: (matchId: string): string => `match:${matchId}`,
  matchClosure: (matchId: string): string => `match:${matchId}:closure`,
  matchAppliedEvents: (matchId: string): string => `match:${matchId}:applied`,
  matchScoreboard: (matchId: string): string => `match:${matchId}:scoreboard`,
  ratingQueue: (mode: string, region: string): string => `mm:q:${mode}:${region}:rating`,
  ticket: (playerId: string): string => `mm:ticket:${playerId}`,
  waitQueue: (mode: string, region: string): string => `mm:q:${mode}:${region}:wait`,
};
