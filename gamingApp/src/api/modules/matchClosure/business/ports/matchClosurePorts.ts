import type {
  FinishMatchInput,
  MatchClosureRecord,
  MatchFinishedEvent,
  PlayerFinalScore,
  RedisClosingOutcome,
  RedisReleaseOutcome,
  ScoringEventPage,
  ScoringStatus,
} from "../models/matchClosure.js";

export interface MatchClosureRepositoryPort {
  find(matchId: string): Promise<MatchClosureRecord | null>;
  prepare(input: FinishMatchInput): Promise<MatchClosureRecord | null>;
  rollbackPreparation(matchId: string, closureId: string): Promise<void>;
  markClosedPending(matchId: string, closureId: string, closedAt: Date): Promise<void>;
  beginScoring(matchId: string, closureId: string, at: Date): Promise<ScoringStatus>;
  completeScoring(
    matchId: string,
    closureId: string,
    scores: readonly PlayerFinalScore[],
    at: Date,
  ): Promise<void>;
  failScoring(matchId: string, closureId: string, message: string, at: Date): Promise<void>;
  applyRating(
    playerId: string,
    mode: string,
    matchId: string,
    delta: number,
    at: Date,
  ): Promise<void>;
}

export interface LiveMatchClosurePort {
  beginClosing(matchId: string, closureId: string): Promise<RedisClosingOutcome>;
  rollbackClosing(matchId: string, closureId: string): Promise<void>;
  release(
    matchId: string,
    closureId: string,
    playerIds: readonly string[],
  ): Promise<RedisReleaseOutcome>;
}

export interface MatchClosureLogPort {
  appendFinished(event: MatchFinishedEvent): Promise<void>;
  listScoringEvents(matchId: string, limit: number, pageState?: string): Promise<ScoringEventPage>;
}
