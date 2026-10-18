export const matchEventTypes = ["kill", "objective", "disconnect", "reconnect"] as const;
export type MatchEventType = (typeof matchEventTypes)[number];

/** One entry of the append-only match log (Cassandra `events_by_match`). */
export type MatchEvent = {
  detail: Record<string, unknown> | null;
  /** Idempotency key chosen by whoever produces the event, so retries can be recognised. */
  eventId: string;
  matchId: string;
  /** Who did it: the killer, the player who took the objective, the player who (dis)connected. */
  playerId: string;
  /** Score the event is worth, fixed when it is recorded so a replay gives the same result. */
  points: number;
  /** Only for kills: the victim. */
  targetPlayerId: string | null;
  /** When it happened according to the producer, epoch milliseconds. */
  tsMs: number;
  type: MatchEventType;
};

/** Live match published by problem 2 (`match:{matchId}` in Redis). */
export type LiveMatch = {
  matchId: string;
  mode: string;
  players: readonly string[];
  region: string;
  startedAt: number;
  status: string;
};

export type PlayerScore = {
  connected: boolean;
  deaths: number;
  kills: number;
  objectives: number;
  playerId: string;
  score: number;
};

export type Scoreboard = {
  /** Events already applied to this scoreboard. */
  eventCount: number;
  lastEventTsMs: number | null;
  matchId: string;
  mode: string;
  /** Sorted by score, then kills, then fewer deaths. */
  players: readonly PlayerScore[];
  region: string;
  startedAt: number;
  status: string;
};

export type ApplyOutcome = "applied" | "duplicate" | "not_live";

export type RecordResult = { eventId: string; status: "recorded" | "duplicate" };

export type ReconcileResult = {
  /** Events found in the log. */
  read: number;
  /** Events that were missing from the scoreboard and have been applied now. */
  repaired: number;
};

export type EventQuery = {
  fromTsMs?: number;
  limit: number;
  pageState?: string;
  toTsMs?: number;
};

export type EventPage = {
  events: readonly MatchEvent[];
  nextPageState: string | null;
};
