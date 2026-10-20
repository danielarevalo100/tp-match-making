import { InjectedFailureError, StorageError } from "../../../../../shared/errors.js";
import {
  ratingDeltaByResult,
  type DeclaredPlayerResult,
  type FinishMatchInput,
  type FinishMatchResult,
  type MatchClosureRecord,
  type PlayerFinalScore,
  type ScoringEvent,
} from "../models/matchClosure.js";
import {
  MatchCloseUnavailableError,
  MatchClosureConflictError,
  MatchClosureParticipantsError,
  MatchForClosureNotFoundError,
} from "../models/matchClosureErrors.js";
import type {
  LiveMatchClosurePort,
  MatchClosureLogPort,
  MatchClosureRepositoryPort,
} from "../ports/matchClosurePorts.js";

const scoringPageSize = 500;
type ScoreCounters = Pick<
  PlayerFinalScore,
  "deaths" | "kills" | "objectives" | "playerId" | "score"
>;

export class MatchClosureService {
  constructor(
    private readonly matches: MatchClosureRepositoryPort,
    private readonly live: LiveMatchClosurePort,
    private readonly log: MatchClosureLogPort,
  ) {}

  async finish(input: FinishMatchInput): Promise<FinishMatchResult> {
    let match = await this.matches.find(input.matchId);
    if (!match) throw new MatchForClosureNotFoundError(input.matchId);
    this.assertSameClosureOrClosable(match, input);
    this.assertCompleteResults(match, input.results);

    if (match.status === "closed") return this.scoreIfNeeded(match, input.closureId);

    let closingOutcome;
    try {
      closingOutcome = await this.live.beginClosing(input.matchId, input.closureId);
    } catch (error: unknown) {
      if (error instanceof StorageError) {
        throw new MatchCloseUnavailableError(input.matchId, error);
      }
      throw error;
    }

    if (match.status === "in_progress") {
      try {
        match = await this.matches.prepare(input);
        if (!match) throw new MatchClosureConflictError(input.matchId, "changed_concurrently");
      } catch (error: unknown) {
        await this.live.rollbackClosing(input.matchId, input.closureId).catch(() => undefined);
        throw error;
      }
    }

    try {
      await this.log.appendFinished({ ...input, type: "match_finished" });
    } catch (error: unknown) {
      // An injected failure happens before the adapter writes, so preparation can be safely
      // compensated. A real driver error has an ambiguous outcome: keep `closing` and let the
      // caller retry the same idempotency keys instead of reopening a possibly finished match.
      if (error instanceof InjectedFailureError) await this.rollbackPreparation(input);
      throw error;
    }

    if (closingOutcome !== "released") {
      await this.live.release(
        input.matchId,
        input.closureId,
        match.players.map((player) => player.playerId),
      );
    }
    await this.matches.markClosedPending(input.matchId, input.closureId, new Date());

    const closed = await this.matches.find(input.matchId);
    if (!closed) throw new MatchForClosureNotFoundError(input.matchId);
    return this.scoreIfNeeded(closed, input.closureId);
  }

  private async rollbackPreparation(input: FinishMatchInput): Promise<void> {
    await this.matches.rollbackPreparation(input.matchId, input.closureId);
    await this.live.rollbackClosing(input.matchId, input.closureId);
  }

  private async scoreIfNeeded(
    match: MatchClosureRecord,
    closureId: string,
  ): Promise<FinishMatchResult> {
    if (match.closureId !== closureId) {
      throw new MatchClosureConflictError(match.id, match.status);
    }
    if (match.scoringStatus === "applied") return this.result(match, "applied");

    try {
      const scoringStatus = await this.matches.beginScoring(match.id, closureId, new Date());
      if (scoringStatus === "applied") return this.result(match, "applied");
      const scores = await this.calculateScores(match);
      for (const score of scores) {
        await this.matches.applyRating(
          score.playerId,
          match.mode,
          match.id,
          score.ratingDelta,
          new Date(),
        );
      }
      await this.matches.completeScoring(match.id, closureId, scores, new Date());
      return this.result(match, "applied");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unspecified scoring failure.";
      await this.matches
        .failScoring(match.id, closureId, message, new Date())
        .catch(() => undefined);
      const current = await this.matches.find(match.id).catch(() => null);
      if (current?.scoringStatus === "applied") return this.result(current, "applied");
      return this.result(match, "failed");
    }
  }

  private async calculateScores(match: MatchClosureRecord): Promise<PlayerFinalScore[]> {
    const counters = new Map<string, ScoreCounters>();
    for (const player of match.players) {
      counters.set(player.playerId, {
        deaths: 0,
        kills: 0,
        objectives: 0,
        playerId: player.playerId,
        score: 0,
      });
    }

    let pageState: string | undefined;
    do {
      const page = await this.log.listScoringEvents(match.id, scoringPageSize, pageState);
      for (const event of page.events) applyScoringEvent(counters, event);
      pageState = page.nextPageState ?? undefined;
    } while (pageState);

    if (!match.results) throw new MatchClosureParticipantsError("closure results are missing");
    const results = new Map(match.results.map((result) => [result.playerId, result.result]));
    return match.players.map((player) => {
      const counter = counters.get(player.playerId);
      const result = results.get(player.playerId);
      if (!counter || !result)
        throw new MatchClosureParticipantsError("a player result is missing");
      const ratingDelta = ratingDeltaByResult[result];
      return {
        ...counter,
        mmrAfter: player.mmr + ratingDelta,
        mmrBefore: player.mmr,
        ratingDelta,
        result,
      };
    });
  }

  private assertSameClosureOrClosable(match: MatchClosureRecord, input: FinishMatchInput): void {
    if (match.status === "voided") throw new MatchClosureConflictError(match.id, match.status);
    if (match.status === "in_progress") return;
    if (match.closureId !== input.closureId || match.eventId !== input.eventId) {
      throw new MatchClosureConflictError(match.id, match.status);
    }
    const storedResults = match.results ?? [];
    const normalize = (results: readonly DeclaredPlayerResult[]): string =>
      JSON.stringify(
        [...results].sort((left, right) => left.playerId.localeCompare(right.playerId)),
      );
    if (normalize(storedResults) !== normalize(input.results)) {
      throw new MatchClosureConflictError(match.id, match.status);
    }
  }

  private assertCompleteResults(
    match: MatchClosureRecord,
    results: readonly DeclaredPlayerResult[],
  ): void {
    const participants = new Set(match.players.map((player) => player.playerId));
    const declared = new Set(results.map((result) => result.playerId));
    if (declared.size !== results.length) {
      throw new MatchClosureParticipantsError("a player appears more than once");
    }
    if (declared.size !== participants.size) {
      throw new MatchClosureParticipantsError("every participant must have one result");
    }
    for (const playerId of declared) {
      if (!participants.has(playerId)) {
        throw new MatchClosureParticipantsError(`player ${playerId} is not in the match`);
      }
    }
    const distinctResults = new Set(results.map((result) => result.result));
    const isDraw = distinctResults.size === 1 && distinctResults.has("draw");
    const hasCompetitiveResult = distinctResults.has("win") && distinctResults.has("loss");
    if (!isDraw && (!hasCompetitiveResult || distinctResults.has("draw"))) {
      throw new MatchClosureParticipantsError(
        "results must be either all draws or a partition of winners and losers",
      );
    }
  }

  private result(
    match: MatchClosureRecord,
    scoringStatus: "applied" | "failed",
  ): FinishMatchResult {
    return {
      closureId: match.closureId ?? "",
      matchId: match.id,
      playersReleased: true,
      scoringStatus,
      status: "closed",
    };
  }
}

function applyScoringEvent(counters: Map<string, ScoreCounters>, event: ScoringEvent): void {
  const actor = counters.get(event.playerId);
  if (!actor) return;
  if (event.type === "kill") {
    actor.kills += 1;
    actor.score += event.points;
    if (event.targetPlayerId) {
      const target = counters.get(event.targetPlayerId);
      if (target) target.deaths += 1;
    }
  } else if (event.type === "objective") {
    actor.objectives += 1;
    actor.score += event.points;
  }
}
