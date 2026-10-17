import { randomUUID } from "node:crypto";

import { requestContext } from "../../../../../shared/requestContext.js";
import type {
  FormationInput,
  FormationMode,
  FormationResult,
  RecoveryResult,
} from "../models/matchFormation.js";
import {
  FormationContendedError,
  ModeNotAvailableError,
  RegionNotFoundError,
} from "../models/matchmakingErrors.js";
import type { QueueTicket } from "../models/queueTicket.js";
import type {
  EligibilityRepositoryPort,
  MatchRepositoryPort,
  MatchmakingQueuePort,
} from "../ports/matchmakingPorts.js";

const maxReserveAttempts = 3;
const candidateScanLimit = 500;
const defaultStaleAfterMs = 30_000;

/**
 * Rating range accepted for a player that has been waiting `waitedMs`: it starts
 * at `initialRatingRange` and grows by `ratingRangeStep` every `expandEverySeconds`,
 * capped at `maxRatingRange`.
 */
export function acceptedRatingRange(waitedMs: number, mode: FormationMode): number {
  const steps = Math.floor(Math.max(0, waitedMs) / (mode.expandEverySeconds * 1_000));
  return Math.min(mode.maxRatingRange, mode.initialRatingRange + mode.ratingRangeStep * steps);
}

/**
 * Match formation saga (problem 2). Order of writes:
 *   A. Redis  reserve  - atomically moves the players from the queue into a "reserved" formation
 *   B. Mongo  create   - inserts the match document (key = matchId, so retries do not duplicate)
 *   C. Redis  commit   - publishes the live match and closes the formation
 * If B or C fail, or a reserved player leaves, the compensation runs in reverse:
 *   Mongo delete(matchId) and then Redis restore (players back with their original enqueuedAt).
 */
export class MatchFormationService {
  constructor(
    private readonly eligibility: EligibilityRepositoryPort,
    private readonly queue: MatchmakingQueuePort,
    private readonly matches: MatchRepositoryPort,
  ) {}

  async form(input: FormationInput): Promise<FormationResult> {
    const mode = await this.eligibility.findFormationMode(input.mode);
    if (!mode) throw new ModeNotAvailableError(input.mode);
    if (!(await this.eligibility.isActiveRegion(input.region))) {
      throw new RegionNotFoundError(input.region);
    }

    for (let attempt = 0; attempt < maxReserveAttempts; attempt++) {
      const plan = await this.selectPlayers(mode, input.region);
      if (plan.status === "not_enough_players") return plan;

      const matchId = randomUUID();
      const reservation = await this.queue.reserveFormation(matchId, plan.players);
      // Someone left between the read and the reservation: nothing was written, try again.
      if (reservation.status === "missing") continue;

      return this.completeFormation(matchId, mode, input.region, plan.players, plan.ratingRange);
    }

    throw new FormationContendedError(input.mode, input.region);
  }

  /** Compensates formations left half-done (for example by a crash of the process). */
  async recoverStaleFormations(olderThanMs = defaultStaleAfterMs): Promise<RecoveryResult> {
    const recovered: { matchId: string; restored: readonly string[] }[] = [];
    for (const matchId of await this.queue.findStaleFormations(olderThanMs)) {
      recovered.push({ matchId, restored: await this.compensate(matchId) });
    }
    return { recovered };
  }

  private async selectPlayers(
    mode: FormationMode,
    region: string,
  ): Promise<
    | { players: QueueTicket[]; ratingRange: number; status: "ready" }
    | Extract<FormationResult, { status: "not_enough_players" }>
  > {
    const anchor = await this.queue.findOldestTicket(mode.id, region);
    if (!anchor) {
      return {
        queued: 0,
        ratingRange: mode.initialRatingRange,
        required: mode.minPlayers,
        status: "not_enough_players",
      };
    }

    const ratingRange = acceptedRatingRange(Date.now() - anchor.enqueuedAt, mode);
    const inRange = await this.queue.findTicketsInRatingRange(
      mode.id,
      region,
      anchor.mmr - ratingRange,
      anchor.mmr + ratingRange,
      candidateScanLimit,
    );
    const others = inRange
      .filter((ticket) => ticket.playerId !== anchor.playerId)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.playerId.localeCompare(b.playerId));
    // The longest-waiting player always gets a place; the rest are taken oldest first.
    const players = [anchor, ...others].slice(0, mode.maxPlayers);

    if (players.length < mode.minPlayers) {
      return {
        queued: players.length,
        ratingRange,
        required: mode.minPlayers,
        status: "not_enough_players",
      };
    }
    return { players, ratingRange, status: "ready" };
  }

  private async completeFormation(
    matchId: string,
    mode: FormationMode,
    region: string,
    players: readonly QueueTicket[],
    ratingRange: number,
  ): Promise<FormationResult> {
    try {
      const pauseMs = requestContext.getStore()?.pauseAfterReserveMs;
      if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));

      await this.matches.create({
        createdAt: new Date(),
        id: matchId,
        mode: mode.id,
        players: players.map(({ enqueuedAt, mmr, playerId }) => ({ enqueuedAt, mmr, playerId })),
        ratingRange,
        region,
      });

      const commit = await this.queue.commitFormation(
        matchId,
        mode.id,
        region,
        players.map((player) => player.playerId),
      );
      if (commit.status === "abandoned") {
        const restored = await this.compensate(matchId);
        return { matchId, reason: "player_left", restored, status: "rolled_back" };
      }
      return { matchId, players, ratingRange, status: "formed" };
    } catch (error: unknown) {
      try {
        await this.compensate(matchId);
      } catch (compensationError: unknown) {
        // The formation stays "reserved" and recoverStaleFormations() will undo it.
        console.error(`Compensation of match ${matchId} failed.`, compensationError);
      }
      throw error;
    }
  }

  private async compensate(matchId: string): Promise<readonly string[]> {
    await this.matches.delete(matchId);
    const outcome = await this.queue.restoreFormation(matchId);
    return outcome.restored;
  }
}
