export const mongoCollections = {
  gameModes: "game_modes",
  matches: "matches",
  players: "players",
  regions: "regions",
  sanctions: "sanctions",
} as const;

export const cassandraTables = {
  eventsByMatch: "events_by_match",
} as const;

export const redisKeys = {
  activeMatch: (playerId: string): string => `player:${playerId}:active_match`,
  formation: (matchId: string): string => `mm:formation:${matchId}`,
  formationIndex: "mm:formations",
  match: (matchId: string): string => `match:${matchId}`,
  matchAppliedEvents: (matchId: string): string => `match:${matchId}:applied`,
  matchScoreboard: (matchId: string): string => `match:${matchId}:scoreboard`,
  ratingQueue: (mode: string, region: string): string => `mm:q:${mode}:${region}:rating`,
  ticket: (playerId: string): string => `mm:ticket:${playerId}`,
  waitQueue: (mode: string, region: string): string => `mm:q:${mode}:${region}:wait`,
};
