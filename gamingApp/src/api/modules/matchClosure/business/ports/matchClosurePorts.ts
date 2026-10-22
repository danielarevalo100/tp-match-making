import type {
  ApplyRatingInput,
  FinishMatchInput,
  LeaderboardStanding,
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
  /** Temporada para la que cuenta la partida: modo rankeado y temporada activa. */
  findLeaderboardSeason(mode: string, playedAt: Date): Promise<string | null>;
  /** Aplica el rating una vez por (partida, jugador), con el standing de temporada en la misma escritura. */
  applyRating(input: ApplyRatingInput): Promise<void>;
  findStandings(
    playerIds: readonly string[],
    mode: string,
    seasonId: string,
  ): Promise<LeaderboardStanding[]>;
  markLeaderboard(
    matchId: string,
    closureId: string,
    status: "published" | "not_ranked",
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

/** Leaderboard de temporada (problema 5). Publicar otra vez el mismo standing, o uno más viejo, no hace nada. */
export interface MatchLeaderboardPort {
  publish(seasonId: string, mode: string, standings: readonly LeaderboardStanding[]): Promise<void>;
}
