import type {
  AffectedSeasons,
  HeldBoard,
  ReversibleMatch,
  SanctionInput,
  SanctionOutcome,
  SanctionRecord,
  SanctionView,
} from "../models/sanction.js";
import {
  AdministratorNotActiveError,
  AdministratorNotFoundError,
  InvalidSanctionReportError,
  MatchNotReversibleError,
  SanctionConflictError,
  SanctionNotFoundError,
  SanctionPlayerNotFoundError,
} from "../models/sanctionErrors.js";
import type {
  GraphCleanupPort,
  HistoryCleanupPort,
  ResultReversalPort,
  ReversalLeaderboardPort,
  SanctionQueuePort,
  SanctionRepositoryPort,
} from "../ports/sanctionPorts.js";
import { affectedSeasons, heldBoards } from "./reversalRules.js";

/**
 * Problem 8: an administrator sanctions a player for cheating and the results of the matches it
 * cheated in are voided.
 *
 * The sanction is registered first (MongoDB) and is in force from then on, whatever happens next.
 * The reversal then only moves forward, and every step can be repeated without changing the
 * result, so a failure is resolved by retrying until it completes:
 *
 *   1. queue        Redis      the player leaves the matchmaking queue
 *   2. hold         Redis      the affected players are held in their leaderboards
 *   3. per match    MongoDB    voided, ratings and season standings reverted
 *                   Cassandra  rows removed from the player history (problem 6)
 *                   Neo4j      match removed from the co-participation graph (problem 7)
 *   4. leaderboard  Redis      one script per board publishes everyone and drops the hold
 *
 * Each finished step is written to the journal in the sanction document. While the reversal is
 * incomplete the held players keep the board position they had before it, so no leaderboard ever
 * shows results partially voided.
 */
export class SanctionService {
  constructor(
    private readonly sanctions: SanctionRepositoryPort,
    private readonly results: ResultReversalPort,
    private readonly queue: SanctionQueuePort,
    private readonly history: HistoryCleanupPort,
    private readonly graph: GraphCleanupPort,
    private readonly leaderboard: ReversalLeaderboardPort,
  ) {}

  async sanction(input: SanctionInput): Promise<SanctionOutcome> {
    const existing = await this.sanctions.find(input.sanctionId);
    if (existing) {
      assertSameSanction(existing, input);
      return { created: false, sanction: await this.revert(existing) };
    }

    await this.validate(input);
    const record = newSanction(input, new Date());
    if (await this.sanctions.insert(record)) {
      return { created: true, sanction: await this.revert(record) };
    }

    // A concurrent request with the same id was inserted first: continue that one.
    const stored = await this.sanctions.find(input.sanctionId);
    if (!stored) throw new SanctionNotFoundError(input.sanctionId);
    assertSameSanction(stored, input);
    return { created: false, sanction: await this.revert(stored) };
  }

  /** Continues an incomplete reversal from its journal (after a crash or a failed attempt). */
  async resume(sanctionId: string): Promise<SanctionView> {
    const record = await this.sanctions.find(sanctionId);
    if (!record) throw new SanctionNotFoundError(sanctionId);
    return this.revert(record);
  }

  async get(sanctionId: string): Promise<SanctionView> {
    const record = await this.sanctions.find(sanctionId);
    if (!record) throw new SanctionNotFoundError(sanctionId);
    return toView(record);
  }

  /** Everything is checked before the sanction is written: a rejected request leaves no trace. */
  private async validate(input: SanctionInput): Promise<void> {
    const [playerExists, administrator, report, matches] = await Promise.all([
      this.sanctions.playerExists(input.playerId),
      this.sanctions.findAdministrator(input.administratorId),
      input.reportId ? this.sanctions.findReport(input.reportId) : Promise.resolve(null),
      this.results.findMatches(input.matchIds),
    ]);

    if (!playerExists) throw new SanctionPlayerNotFoundError(input.playerId);
    if (!administrator) throw new AdministratorNotFoundError(input.administratorId);
    if (!administrator.active) throw new AdministratorNotActiveError(input.administratorId);
    if (input.reportId) {
      if (!report) throw new InvalidSanctionReportError(input.reportId, "not_found");
      if (report.reportedPlayerId !== input.playerId) {
        throw new InvalidSanctionReportError(input.reportId, "other_player");
      }
    }

    const byId = new Map(matches.map((match) => [match.id, match]));
    for (const matchId of input.matchIds) {
      const match = byId.get(matchId);
      if (!match) throw new MatchNotReversibleError(matchId, "not_found");
      // A voided match was already reverted by another sanction; including it changes nothing.
      const scored = match.status === "closed" && match.scoringStatus === "applied";
      if (!scored && match.status !== "voided") {
        throw new MatchNotReversibleError(matchId, "not_scored");
      }
      if (!match.participants.some((participant) => participant.playerId === input.playerId)) {
        throw new MatchNotReversibleError(matchId, "not_participant");
      }
    }
  }

  /**
   * Runs the steps the journal does not have yet. A failure is recorded (`failed`, with the
   * message) and the sanction is returned as it is: retrying the request, or `resume`, continues
   * from the first missing step.
   */
  private async revert(record: SanctionRecord): Promise<SanctionView> {
    if (record.reversal.status === "completed") return toView(record);

    try {
      await this.sanctions.beginReversal(record.id, new Date());
      const done = new Set(record.reversal.completedSteps);

      if (!done.has("queue")) {
        await this.queue.leave(record.playerId);
        await this.sanctions.markStep(record.id, "queue", new Date());
      }

      const matches = await this.findSanctionMatches(record);
      const catalog = await this.results.findSeasonCatalog();
      const seasonsByMatch = new Map(
        matches.map((match) => [match.id, affectedSeasons(catalog, match.mode, match.createdAt)]),
      );

      let boards = record.reversal.heldBoards;
      if (!done.has("hold")) {
        boards = heldBoards(matches, seasonsByMatch);
        for (const board of boards) {
          await this.leaderboard.hold(board.seasonId, board.mode, record.id, board.playerIds);
        }
        await this.sanctions.markStep(record.id, "hold", new Date(), boards);
      }

      const reverted = new Set(record.reversal.revertedMatchIds);
      for (const match of matches) {
        if (reverted.has(match.id)) continue;
        await this.revertMatch(record.id, match, seasonsByMatch.get(match.id));
        await this.sanctions.markMatchReverted(record.id, match.id, new Date());
      }

      if (!done.has("leaderboard")) {
        for (const board of boards) await this.releaseBoard(record.id, board);
        await this.sanctions.markStep(record.id, "leaderboard", new Date());
      }

      await this.sanctions.completeReversal(record.id, new Date());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unspecified reversal failure.";
      await this.sanctions.failReversal(record.id, message, new Date()).catch(() => undefined);
      const current = await this.sanctions.find(record.id).catch(() => null);
      return toView(
        current ?? {
          ...record,
          reversal: { ...record.reversal, lastError: message, status: "failed" },
        },
      );
    }

    const completed = await this.sanctions.find(record.id).catch(() => null);
    return toView(completed ?? completedCopy(record));
  }

  private async findSanctionMatches(record: SanctionRecord): Promise<ReversibleMatch[]> {
    const byId = new Map(
      (await this.results.findMatches(record.matchIds)).map((match) => [match.id, match]),
    );
    return record.matchIds.map((matchId) => {
      const match = byId.get(matchId);
      if (!match) throw new MatchNotReversibleError(matchId, "not_found");
      return match;
    });
  }

  /** Every write here is idempotent, so a match interrupted half way is simply done again. */
  private async revertMatch(
    sanctionId: string,
    match: ReversibleMatch,
    seasons: AffectedSeasons | undefined,
  ): Promise<void> {
    const at = new Date();
    // Voided first: from now on problems 4, 6 and 7 ignore the match, so nothing projects it again
    // after its history rows and graph node are deleted below.
    await this.results.voidMatch(match.id, sanctionId, at);
    for (const participant of match.participants) {
      await this.results.revertRating({
        at,
        delta: participant.ratingDelta,
        matchId: match.id,
        matchSeasonId: seasons?.matchSeasonId ?? null,
        mode: match.mode,
        playerId: participant.playerId,
        seasonIds: seasons?.seasonIds ?? [],
      });
    }
    const playerIds = match.participants.map((participant) => participant.playerId);
    if (match.endedAt) await this.history.deleteMatch(match.id, match.endedAt, playerIds);
    await this.graph.deleteMatch(match.id);
  }

  /** Writes what MongoDB holds now for every held player of the board, in one Redis script. */
  private async releaseBoard(sanctionId: string, board: HeldBoard): Promise<void> {
    const standings = new Map(
      (await this.results.findStandings(board.playerIds, board.seasonId, board.mode)).map(
        (standing) => [standing.playerId, standing],
      ),
    );
    await this.leaderboard.release(
      board.seasonId,
      board.mode,
      sanctionId,
      board.playerIds.map((playerId) => ({ playerId, standing: standings.get(playerId) ?? null })),
    );

    // Catch-up: a match of a held player that closed after the read above was published by
    // problem 4 while the player was still held, so it was skipped. MongoDB has it: publish what
    // it holds now. The board is already consistent; this only keeps it from lagging, and the
    // revision check means it can never move anyone backwards.
    const current = (
      await this.results.findStandings(board.playerIds, board.seasonId, board.mode)
    ).filter((standing) => standing.gamesPlayed > 0);
    if (current.length > 0) await this.leaderboard.publish(board.seasonId, board.mode, current);
  }
}

function newSanction(input: SanctionInput, now: Date): SanctionRecord {
  return {
    administratorId: input.administratorId,
    createdAt: now,
    description: input.description,
    endsAt: input.endsAt,
    id: input.sanctionId,
    matchIds: [...input.matchIds],
    playerId: input.playerId,
    reason: input.reason,
    reportId: input.reportId,
    reversal: {
      attempts: 0,
      completedAt: null,
      completedSteps: [],
      heldBoards: [],
      lastError: null,
      revertedMatchIds: [],
      status: "pending",
      updatedAt: now,
    },
    startsAt: input.startsAt ?? now,
    status: "active",
    type: input.type,
  };
}

/** A retry must describe the same sanction; otherwise the id is being reused by mistake. */
function assertSameSanction(record: SanctionRecord, input: SanctionInput): void {
  const sameMatches =
    JSON.stringify([...record.matchIds].sort()) === JSON.stringify([...input.matchIds].sort());
  const same =
    record.playerId === input.playerId &&
    record.administratorId === input.administratorId &&
    record.type === input.type &&
    record.reportId === input.reportId &&
    (record.endsAt?.getTime() ?? null) === (input.endsAt?.getTime() ?? null) &&
    sameMatches;
  if (!same) throw new SanctionConflictError(record.id);
}

function completedCopy(record: SanctionRecord): SanctionRecord {
  return {
    ...record,
    reversal: {
      ...record.reversal,
      completedAt: new Date(),
      completedSteps: ["queue", "hold", "leaderboard"],
      lastError: null,
      revertedMatchIds: [...record.matchIds],
      status: "completed",
    },
  };
}

function toView(record: SanctionRecord): SanctionView {
  const reverted = new Set(record.reversal.revertedMatchIds);
  return {
    administratorId: record.administratorId,
    createdAt: record.createdAt,
    description: record.description,
    endsAt: record.endsAt,
    matchIds: record.matchIds,
    playerId: record.playerId,
    reason: record.reason,
    reportId: record.reportId,
    reversal: {
      attempts: record.reversal.attempts,
      completedAt: record.reversal.completedAt,
      completedSteps: record.reversal.completedSteps,
      lastError: record.reversal.lastError,
      pendingMatchIds: record.matchIds.filter((matchId) => !reverted.has(matchId)),
      revertedMatchIds: record.reversal.revertedMatchIds,
      status: record.reversal.status,
    },
    sanctionId: record.id,
    startsAt: record.startsAt,
    status: record.status,
    type: record.type,
  };
}
