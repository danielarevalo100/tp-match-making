// Redis key naming. Keep in sync with infra/redis/README.md and with the key
// patterns hardcoded inside LEAVE_SCRIPT (redis-scripts.ts).
export const ticketKey = (playerId: string): string => `mm:ticket:${playerId}`;

export const activeMatchKey = (playerId: string): string => `player:${playerId}:active_match`;

export const ratingQueueKey = (mode: string, region: string): string =>
  `mm:q:${mode}:${region}:rating`;

export const waitQueueKey = (mode: string, region: string): string => `mm:q:${mode}:${region}:wait`;
