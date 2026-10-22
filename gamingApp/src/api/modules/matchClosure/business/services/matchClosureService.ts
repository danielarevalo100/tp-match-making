import { InjectedFailureError, StorageError } from "../../../../../shared/errors.js";
import type {
  FinishMatchInput,
  FinishMatchResult,
  LeaderboardStatus,
  MatchClosureRecord,
  PlayerFinalScore,
  ScoringEvent,
} from "../models/matchClosure.js";
import {
  MatchCloseUnavailableError,
  MatchClosureConflictError,
  MatchForClosureNotFoundError,
} from "../models/matchClosureErrors.js";
import type {
  LiveMatchClosurePort,
  MatchClosureLogPort,
  MatchClosureRepositoryPort,
  MatchLeaderboardPort,
} from "../ports/matchClosurePorts.js";
import {
  assertCompleteResults,
  assertSameClosureOrClosable,
  computeFinalScores,
} from "./matchClosureRules.js";

const scoringPageSize = 500;

/**
 * Cierre de partida (problema 4). Orden de escrituras:
 *   1. Redis      `closing`        la partida deja de aceptar eventos
 *   2. Mongo      prepare          guarda el cierre pedido (estado `closing`)
 *   3. Cassandra  match_finished   punto de commit: desde acá el cierre ya no se deshace
 *   4. Redis      release          libera a los jugadores
 *   5. Mongo      closed           y después el scoring (ratings y marcador final)
 *   6. Redis      leaderboard      publica los standings de la temporada (problema 5)
 * Si falla algo antes del paso 3 se compensa; después del paso 3 solo se avanza: repetir el mismo
 * pedido continúa desde donde quedó.
 */
export class MatchClosureService {
  constructor(
    private readonly matches: MatchClosureRepositoryPort,
    private readonly live: LiveMatchClosurePort,
    private readonly log: MatchClosureLogPort,
    private readonly leaderboard: MatchLeaderboardPort,
  ) {}

  async finish(input: FinishMatchInput): Promise<FinishMatchResult> {
    let match = await this.matches.find(input.matchId);
    if (!match) throw new MatchForClosureNotFoundError(input.matchId);
    assertSameClosureOrClosable(match, input);
    assertCompleteResults(match, input.results);

    if (match.status === "closed") return this.scoreIfNeeded(match, input.closureId);

    // 1. Redis: si no responde, no se sabe si la partida quedó en `closing`; se puede reintentar.
    let closingOutcome;
    try {
      closingOutcome = await this.live.beginClosing(input.matchId, input.closureId);
    } catch (error: unknown) {
      if (error instanceof StorageError) throw new MatchCloseUnavailableError(input.matchId, error);
      throw error;
    }

    // 2. Mongo: si falla, se devuelve la partida a `in_progress` en Redis.
    if (match.status === "in_progress") {
      try {
        match = await this.matches.prepare(input);
        if (!match) throw new MatchClosureConflictError(input.matchId, "changed_concurrently");
      } catch (error: unknown) {
        await this.live.rollbackClosing(input.matchId, input.closureId).catch(() => undefined);
        throw error;
      }
    }

    // 3. Cassandra: una falla simulada no llegó a escribir, así que se puede compensar. Un error
    // real del driver es ambiguo (el evento pudo quedar escrito): se deja `closing` y el cliente
    // reintenta con las mismas claves en lugar de reabrir una partida que quizás terminó.
    try {
      await this.log.appendFinished({ ...input, type: "match_finished" });
    } catch (error: unknown) {
      if (error instanceof InjectedFailureError) {
        await this.matches.rollbackPreparation(input.matchId, input.closureId);
        await this.live.rollbackClosing(input.matchId, input.closureId);
      }
      throw error;
    }

    // 4 y 5.
    if (closingOutcome !== "released") {
      const playerIds = match.players.map((player) => player.playerId);
      await this.live.release(input.matchId, input.closureId, playerIds);
    }
    await this.matches.markClosedPending(input.matchId, input.closureId, new Date());

    const closed = await this.matches.find(input.matchId);
    if (!closed) throw new MatchForClosureNotFoundError(input.matchId);
    return this.scoreIfNeeded(closed, input.closureId);
  }

  private async scoreIfNeeded(
    match: MatchClosureRecord,
    closureId: string,
  ): Promise<FinishMatchResult> {
    if (match.closureId !== closureId) throw new MatchClosureConflictError(match.id, match.status);
    if (match.scoringStatus === "applied" && match.leaderboardStatus !== "pending") {
      return result(match, "applied", match.leaderboardStatus);
    }
    if (match.scoringStatus !== "applied" && !(await this.score(match, closureId))) {
      return result(match, "failed", "pending");
    }
    return result(match, "applied", await this.publishLeaderboard(match, closureId));
  }

  /** Aplica ratings y marcador final. Devuelve si el scoring quedó `applied`. */
  private async score(match: MatchClosureRecord, closureId: string): Promise<boolean> {
    try {
      const scoringStatus = await this.matches.beginScoring(match.id, closureId, new Date());
      if (scoringStatus === "applied") return true;
      const seasonId = await this.matches.findLeaderboardSeason(match.mode, match.createdAt);
      const scores = computeFinalScores(match, await this.readScoringEvents(match.id));
      for (const score of scores) await this.applyRating(match, score, seasonId);
      await this.matches.completeScoring(match.id, closureId, scores, new Date());
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unspecified scoring failure.";
      await this.matches
        .failScoring(match.id, closureId, message, new Date())
        .catch(() => undefined);
      // Si Mongo confirmó `applied` y solo se perdió la respuesta, no se marca como fallido.
      const current = await this.matches.find(match.id).catch(() => null);
      return current?.scoringStatus === "applied";
    }
  }

  private applyRating(
    match: MatchClosureRecord,
    score: PlayerFinalScore,
    seasonId: string | null,
  ): Promise<void> {
    return this.matches.applyRating({
      at: new Date(),
      delta: score.ratingDelta,
      fallbackMmr: score.mmrBefore,
      matchId: match.id,
      mode: match.mode,
      playerId: score.playerId,
      seasonId,
    });
  }

  private async readScoringEvents(matchId: string): Promise<ScoringEvent[]> {
    const events: ScoringEvent[] = [];
    let pageState: string | undefined;
    do {
      const page = await this.log.listScoringEvents(matchId, scoringPageSize, pageState);
      events.push(...page.events);
      pageState = page.nextPageState ?? undefined;
    } while (pageState);
    return events;
  }

  /**
   * Último paso, cuando ratings y marcador final ya están en Mongo: si falla, el leaderboard solo
   * puede quedar atrasado, nunca adelantado. Publica lo que Mongo tiene ahora, así un reintento (o
   * una partida más nueva publicada antes) no puede hacer retroceder a nadie.
   */
  private async publishLeaderboard(
    match: MatchClosureRecord,
    closureId: string,
  ): Promise<LeaderboardStatus> {
    try {
      const seasonId = await this.matches.findLeaderboardSeason(match.mode, match.createdAt);
      if (seasonId) {
        const playerIds = match.players.map((player) => player.playerId);
        const standings = await this.matches.findStandings(playerIds, match.mode, seasonId);
        await this.leaderboard.publish(seasonId, match.mode, standings);
      }
      const status = seasonId ? "published" : "not_ranked";
      await this.matches.markLeaderboard(match.id, closureId, status, new Date());
      return status;
    } catch {
      return "pending";
    }
  }
}

function result(
  match: MatchClosureRecord,
  scoringStatus: "applied" | "failed",
  leaderboardStatus: LeaderboardStatus,
): FinishMatchResult {
  return {
    closureId: match.closureId ?? "",
    leaderboardStatus,
    matchId: match.id,
    playersReleased: true,
    scoringStatus,
    status: "closed",
  };
}
