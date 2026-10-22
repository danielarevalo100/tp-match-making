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
 * Rango de rating aceptado para un jugador que espera hace `waitedMs`: empieza en
 * `initialRatingRange` y crece `ratingRangeStep` cada `expandEverySeconds`, hasta
 * `maxRatingRange`.
 */
export function acceptedRatingRange(waitedMs: number, mode: FormationMode): number {
  const steps = Math.floor(Math.max(0, waitedMs) / (mode.expandEverySeconds * 1_000));
  return Math.min(mode.maxRatingRange, mode.initialRatingRange + mode.ratingRangeStep * steps);
}

/**
 * Saga de formación de partida (problema 2). Orden de escrituras:
 *   A. Redis  reserve  - mueve los jugadores de la cola a una formación "reserved", de forma atómica
 *   B. Mongo  create   - inserta el documento de la partida (clave = matchId, un reintento no duplica)
 *   C. Redis  commit   - publica la partida en vivo y cierra la formación
 * Si fallan B o C, o se va un jugador reservado, la compensación corre en orden inverso:
 *   Mongo delete(matchId) y después Redis restore (jugadores de vuelta con su enqueuedAt original).
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
      // Alguien se fue entre la lectura y la reserva: no se escribió nada, se vuelve a intentar.
      if (reservation.status === "missing") continue;

      return this.completeFormation(matchId, mode, input.region, plan.players, plan.ratingRange);
    }

    throw new FormationContendedError(input.mode, input.region);
  }

  /** Compensa formaciones que quedaron a medias (por ejemplo por una caída del proceso). */
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
    // El jugador que más espera siempre entra; el resto se toma del que espera más al que menos.
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
        // La formación queda "reserved" y recoverStaleFormations() la va a deshacer.
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
