export const mongoCollections = {
  gameModes: "game_modes",
  players: "players",
  regions: "regions",
  sanctions: "sanctions",
} as const;

export const redisKeys = {
  activeMatch: (playerId: string): string => `player:${playerId}:active_match`,
  ratingQueue: (mode: string, region: string): string => `mm:q:${mode}:${region}:rating`,
  ticket: (playerId: string): string => `mm:ticket:${playerId}`,
  waitQueue: (mode: string, region: string): string => `mm:q:${mode}:${region}:wait`,
};
