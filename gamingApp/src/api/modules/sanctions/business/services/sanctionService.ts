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
import { assertSameSanction, completedCopy, newSanction, toView } from "./sanctionRecords.js";

/**
 * Problema 8: un administrador sanciona a un jugador por hacer trampa y se anulan los resultados
 * de las partidas en las que la hizo.
 *
 * La sanción se registra primero (MongoDB) y queda en vigor desde ese momento, pase lo que pase.
 * Después la reversión solo avanza, y cada paso se puede repetir sin cambiar el resultado, así
 * una falla se resuelve reintentando hasta completar:
 *
 *   1. queue        Redis      el jugador sale de la cola de matchmaking
 *   2. hold         Redis      los jugadores afectados quedan retenidos en sus leaderboards
 *   3. por partida  MongoDB    anulada, y ratings y standings de temporada revertidos
 *                   Cassandra  filas borradas del historial (problema 6)
 *                   Neo4j      partida borrada del grafo de coparticipación (problema 7)
 *   4. leaderboard  Redis      un script por tablero publica a todos y quita la retención
 *
 * Cada paso terminado se anota en el journal del documento de la sanción. Mientras la reversión
 * está incompleta, los jugadores retenidos conservan la posición que tenían antes, así ningún
 * leaderboard muestra resultados anulados a medias.
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

    // Un pedido concurrente con el mismo id se insertó primero: se continúa ese.
    const stored = await this.sanctions.find(input.sanctionId);
    if (!stored) throw new SanctionNotFoundError(input.sanctionId);
    assertSameSanction(stored, input);
    return { created: false, sanction: await this.revert(stored) };
  }

  /** Continúa una reversión incompleta desde su journal (después de una caída o un intento fallido). */
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

  /** Se valida todo antes de escribir la sanción: un pedido rechazado no deja rastro. */
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
      // Una partida anulada ya la revirtió otra sanción; incluirla no cambia nada.
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
   * Ejecuta los pasos que el journal todavía no tiene. Una falla se anota (`failed`, con el
   * mensaje) y la sanción se devuelve como está: repetir el pedido, o `resume`, continúa desde el
   * primer paso que falta.
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

  /** Todas las escrituras son idempotentes, así una partida que quedó a medias simplemente se rehace. */
  private async revertMatch(
    sanctionId: string,
    match: ReversibleMatch,
    seasons: AffectedSeasons | undefined,
  ): Promise<void> {
    const at = new Date();
    // Primero se anula: desde ahí los problemas 4, 6 y 7 ignoran la partida, así nada la vuelve a
    // proyectar después de borrar sus filas del historial y su nodo del grafo.
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

  /** Escribe lo que MongoDB tiene ahora para cada jugador retenido del tablero, en un solo script de Redis. */
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

    // Puesta al día: una partida de un jugador retenido que se cerró después de la lectura de arriba
    // la publicó el problema 4 mientras el jugador seguía retenido, así que se salteó. MongoDB la
    // tiene: se publica lo que tiene ahora. El tablero ya es consistente; esto solo evita que quede
    // atrasado, y el chequeo de revisión impide que alguien retroceda.
    const current = (
      await this.results.findStandings(board.playerIds, board.seasonId, board.mode)
    ).filter((standing) => standing.gamesPlayed > 0);
    if (current.length > 0) await this.leaderboard.publish(board.seasonId, board.mode, current);
  }
}
