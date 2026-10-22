export const mongoCollections = {
  administrators: "administrators",
  gameModes: "game_modes",
  matches: "matches",
  players: "players",
  regions: "regions",
  reports: "reports",
  sanctions: "sanctions",
  seasons: "seasons",
} as const;

export const cassandraTables = {
  eventsByMatch: "events_by_match",
  matchHistoryByPlayer: "match_history_by_player",
} as const;

export const redisKeys = {
  activeMatch: (playerId: string): string => `player:${playerId}:active_match`,
  formation: (matchId: string): string => `mm:formation:${matchId}`,
  formationIndex: "mm:formations",
  leaderboardGlobal: (seasonId: string, mode: string): string => `lb:${seasonId}:${mode}:global`,
  /** Los tableros regionales son `{prefijo}{región}`; el script de publicación arma la clave de la región vieja. */
  leaderboardRegionPrefix: (seasonId: string, mode: string): string =>
    `lb:${seasonId}:${mode}:region:`,
  leaderboardRegional: (seasonId: string, mode: string, region: string): string =>
    `lb:${seasonId}:${mode}:region:${region}`,
  leaderboardMembers: (seasonId: string, mode: string): string => `lb:${seasonId}:${mode}:members`,
  /** Problema 8: `{holdId}|{playerId}` por cada jugador que una reversión de sanción retiene en este tablero. */
  leaderboardHolds: (seasonId: string, mode: string): string => `lb:${seasonId}:${mode}:holds`,
  /** Problema 8: playerId -> cantidad de reversiones que lo retienen; un jugador retenido no se publica. */
  leaderboardHeld: (seasonId: string, mode: string): string => `lb:${seasonId}:${mode}:held`,
  match: (matchId: string): string => `match:${matchId}`,
  matchClosure: (matchId: string): string => `match:${matchId}:closure`,
  matchAppliedEvents: (matchId: string): string => `match:${matchId}:applied`,
  matchScoreboard: (matchId: string): string => `match:${matchId}:scoreboard`,
  ratingQueue: (mode: string, region: string): string => `mm:q:${mode}:${region}:rating`,
  ticket: (playerId: string): string => `mm:ticket:${playerId}`,
  waitQueue: (mode: string, region: string): string => `mm:q:${mode}:${region}:wait`,
};
