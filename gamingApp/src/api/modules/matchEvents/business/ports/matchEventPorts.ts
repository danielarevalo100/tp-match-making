import type {
  ApplyOutcome,
  EventPage,
  EventQuery,
  LiveMatch,
  MatchEvent,
  Scoreboard,
} from "../models/matchEvent.js";

/** Durable, append-only record of every event (Cassandra). */
export interface MatchEventLogPort {
  /** Idempotent: writing the same (matchId, tsMs, eventId) again overwrites the same row. */
  append(event: MatchEvent): Promise<void>;
  list(matchId: string, query: EventQuery): Promise<EventPage>;
}

/** Live state of the match: who is playing and the running score (Redis). */
export interface LiveScoreboardPort {
  findLiveMatch(matchId: string): Promise<LiveMatch | null>;
  /** Atomic and idempotent per `eventId`: an event already applied changes nothing. */
  apply(event: MatchEvent): Promise<ApplyOutcome>;
  /** Same as `apply` for many events in one round trip; returns how many were newly applied. */
  applyMany(events: readonly MatchEvent[]): Promise<number>;
  findScoreboard(matchId: string): Promise<Scoreboard | null>;
}
