import type {
  ApplyRatingInput,
  FinishMatchInput,
  LeaderboardStanding,
  MatchClosureRecord,
  MatchFinishedEvent,
  PlayerFinalScore,
  RedisClosingOutcome,
  RedisReleaseOutcome,
  ScoringEvent,
  ScoringEventPage,
  ScoringStatus,
} from "../../../src/api/modules/matchClosure/business/models/matchClosure.js";
import type {
  LiveMatchClosurePort,
  MatchClosureLogPort,
  MatchClosureRepositoryPort,
} from "../../../src/api/modules/matchClosure/business/ports/matchClosurePorts.js";
import { failIfRequested } from "../../../src/shared/requestContext.js";

export class InMemoryMatchClosureRepository implements MatchClosureRepositoryPort {
  readonly matches = new Map<string, MatchClosureRecord>();
  readonly ratings = new Map<string, number>();
  readonly ratingApplications = new Set<string>();
  readonly finalScores = new Map<string, readonly PlayerFinalScore[]>();
  /** Standings de temporada por `${seasonId}|${mode}|${playerId}`. */
  readonly standings = new Map<string, LeaderboardStanding>();
  readonly regions = new Map<string, string>();
  leaderboardSeason: string | null = "2026-S2";

  async find(matchId: string): Promise<MatchClosureRecord | null> {
    return this.matches.get(matchId) ?? null;
  }

  async prepare(input: FinishMatchInput): Promise<MatchClosureRecord | null> {
    failIfRequested("mongo");
    const match = this.matches.get(input.matchId);
    if (!match || match.status !== "in_progress") return null;
    const prepared: MatchClosureRecord = {
      ...match,
      closureId: input.closureId,
      eventId: input.eventId,
      results: input.results.map((result) => ({ ...result })),
      scoringStatus: "not_started",
      status: "closing",
    };
    this.matches.set(input.matchId, prepared);
    return prepared;
  }

  async rollbackPreparation(matchId: string, closureId: string): Promise<void> {
    failIfRequested("mongo");
    const match = this.matches.get(matchId);
    if (match?.status !== "closing" || match.closureId !== closureId) return;
    this.matches.set(matchId, {
      ...match,
      closureId: null,
      eventId: null,
      results: null,
      scoringStatus: "not_started",
      status: "in_progress",
    });
  }

  async markClosedPending(matchId: string, closureId: string): Promise<void> {
    failIfRequested("mongo");
    const match = this.matches.get(matchId);
    if (!match || match.closureId !== closureId) return;
    this.matches.set(matchId, { ...match, scoringStatus: "pending", status: "closed" });
  }

  async beginScoring(matchId: string, closureId: string, _at: Date): Promise<ScoringStatus> {
    failIfRequested("mongo");
    const match = this.matches.get(matchId);
    if (!match || match.closureId !== closureId) return "failed";
    if (match.scoringStatus === "applied") return "applied";
    this.matches.set(matchId, { ...match, scoringStatus: "calculating" });
    return "calculating";
  }

  async completeScoring(
    matchId: string,
    closureId: string,
    scores: readonly PlayerFinalScore[],
  ): Promise<void> {
    failIfRequested("mongo");
    const match = this.matches.get(matchId);
    if (!match || match.closureId !== closureId) return;
    this.finalScores.set(
      matchId,
      scores.map((score) => ({ ...score })),
    );
    this.matches.set(matchId, { ...match, scoringStatus: "applied" });
  }

  async failScoring(
    matchId: string,
    closureId: string,
    _message: string,
    _at: Date,
  ): Promise<void> {
    const match = this.matches.get(matchId);
    if (!match || match.closureId !== closureId || match.scoringStatus !== "calculating") return;
    this.matches.set(matchId, { ...match, scoringStatus: "failed" });
  }

  async findLeaderboardSeason(_mode: string, _playedAt: Date): Promise<string | null> {
    return this.leaderboardSeason;
  }

  async applyRating(input: ApplyRatingInput): Promise<void> {
    failIfRequested("mongo");
    const key = `${input.matchId}|${input.playerId}`;
    if (this.ratingApplications.has(key)) return;
    this.ratingApplications.add(key);
    const mmr = (this.ratings.get(input.playerId) ?? input.fallbackMmr) + input.delta;
    this.ratings.set(input.playerId, mmr);
    if (!input.seasonId) return;
    const standingKey = `${input.seasonId}|${input.mode}|${input.playerId}`;
    this.standings.set(standingKey, {
      mmr,
      playerId: input.playerId,
      region: this.regions.get(input.playerId) ?? "NA",
      revision: (this.standings.get(standingKey)?.revision ?? 0) + 1,
    });
  }

  async findStandings(
    playerIds: readonly string[],
    mode: string,
    seasonId: string,
  ): Promise<LeaderboardStanding[]> {
    return playerIds.flatMap((playerId) => {
      const standing = this.standings.get(`${seasonId}|${mode}|${playerId}`);
      return standing ? [{ ...standing }] : [];
    });
  }

  async markLeaderboard(
    matchId: string,
    closureId: string,
    status: "published" | "not_ranked",
  ): Promise<void> {
    failIfRequested("mongo");
    const match = this.matches.get(matchId);
    if (!match || match.closureId !== closureId || match.scoringStatus !== "applied") return;
    this.matches.set(matchId, { ...match, leaderboardStatus: status });
  }
}

export class InMemoryLiveMatchClosure implements LiveMatchClosurePort {
  readonly live = new Map<
    string,
    { closureId: string | null; players: readonly string[]; status: string }
  >();
  readonly activeMatches = new Map<string, string>();
  readonly released = new Map<string, string>();

  async beginClosing(matchId: string, closureId: string): Promise<RedisClosingOutcome> {
    failIfRequested("redis");
    if (this.released.get(matchId) === closureId) return "released";
    const match = this.live.get(matchId);
    if (!match) throw new Error("not live");
    if (match.status === "closing" && match.closureId === closureId) return "replayed";
    if (match.status !== "in_progress") throw new Error("conflict");
    this.live.set(matchId, { ...match, closureId, status: "closing" });
    return "closing";
  }

  async rollbackClosing(matchId: string, closureId: string): Promise<void> {
    failIfRequested("redis");
    const match = this.live.get(matchId);
    if (match?.status === "closing" && match.closureId === closureId) {
      this.live.set(matchId, { ...match, closureId: null, status: "in_progress" });
    }
  }

  async release(
    matchId: string,
    closureId: string,
    playerIds: readonly string[],
  ): Promise<RedisReleaseOutcome> {
    failIfRequested("redis");
    if (this.released.get(matchId) === closureId) return "already_released";
    const match = this.live.get(matchId);
    if (!match || match.status !== "closing" || match.closureId !== closureId) {
      throw new Error("not closing");
    }
    for (const playerId of playerIds) {
      const active = this.activeMatches.get(playerId);
      if (active && active !== matchId) throw new Error("player in another match");
    }
    for (const playerId of playerIds) {
      if (this.activeMatches.get(playerId) === matchId) this.activeMatches.delete(playerId);
    }
    this.live.delete(matchId);
    this.released.set(matchId, closureId);
    return "released";
  }
}

export class InMemoryMatchClosureLog implements MatchClosureLogPort {
  readonly finished = new Map<string, MatchFinishedEvent>();
  readonly events: ScoringEvent[] = [];

  async appendFinished(event: MatchFinishedEvent): Promise<void> {
    failIfRequested("cassandra");
    this.finished.set(`${event.matchId}|${String(event.tsMs)}|${event.eventId}`, event);
  }

  async listScoringEvents(
    _matchId: string,
    limit: number,
    pageState?: string,
  ): Promise<ScoringEventPage> {
    const start = pageState ? Number(pageState) : 0;
    const events = this.events.slice(start, start + limit);
    const next = start + events.length;
    return { events, nextPageState: next < this.events.length ? String(next) : null };
  }
}
