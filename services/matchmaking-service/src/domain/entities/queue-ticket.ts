// A player's place in a matchmaking queue. It lives only in Redis (live state);
// `mmr` is a snapshot of the player's rating for `mode` taken when joining.
export type QueueTicket = {
  enqueuedAt: number;
  mmr: number;
  mode: string;
  playerId: string;
  region: string;
  ticketId: string;
};
