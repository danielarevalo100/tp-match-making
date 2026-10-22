import type {
  AdministratorInfo,
  HeldBoard,
  HeldStanding,
  RatingReversal,
  ReportInfo,
  ReversalStep,
  ReversibleMatch,
  SanctionRecord,
  SeasonCatalog,
  SeasonStanding,
} from "../models/sanction.js";

/** Sanciones y journal de la reversión (`sanctions` en MongoDB), más las lecturas que las validan. */
export interface SanctionRepositoryPort {
  find(sanctionId: string): Promise<SanctionRecord | null>;
  /** False si ya existe una sanción con el mismo id (el pedido es un reintento). */
  insert(sanction: SanctionRecord): Promise<boolean>;
  playerExists(playerId: string): Promise<boolean>;
  findAdministrator(administratorId: string): Promise<AdministratorInfo | null>;
  findReport(reportId: string): Promise<ReportInfo | null>;
  /** `pending | failed | reverting -> reverting`, contando el intento. */
  beginReversal(sanctionId: string, at: Date): Promise<void>;
  /** Anota un paso terminado; `hold` también anota los tableros que retuvo. */
  markStep(
    sanctionId: string,
    step: ReversalStep,
    at: Date,
    heldBoards?: readonly HeldBoard[],
  ): Promise<void>;
  markMatchReverted(sanctionId: string, matchId: string, at: Date): Promise<void>;
  completeReversal(sanctionId: string, at: Date): Promise<void>;
  /** Solo `reverting -> failed`: nunca degrada una reversión que otro intento completó. */
  failReversal(sanctionId: string, message: string, at: Date): Promise<void>;
}

/** Partidas, ratings y standings de temporada (`matches` y `players` en MongoDB). */
export interface ResultReversalPort {
  findMatches(matchIds: readonly string[]): Promise<ReversibleMatch[]>;
  /** Modos rankeados y temporadas que ya empezaron (activas o cerradas). */
  findSeasonCatalog(): Promise<SeasonCatalog>;
  /** `closed -> voided`. Idempotente: una partida ya anulada (por cualquier sanción) queda como está. */
  voidMatch(matchId: string, sanctionId: string, at: Date): Promise<void>;
  /**
   * Resta el delta del rating del modo y de los standings de temporada afectados, una vez por
   * (partida, jugador), y solo si el problema 4 lo había aplicado.
   */
  revertRating(reversal: RatingReversal): Promise<void>;
  findStandings(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<SeasonStanding[]>;
}

/** Cola de matchmaking (Redis): la misma operación que usa el problema 1 para salir de la cola. */
export interface SanctionQueuePort {
  /** True si el jugador estaba en la cola (o siendo ubicado en una partida) y se lo sacó. */
  leave(playerId: string): Promise<boolean>;
}

/** Historial de jugadores (Cassandra `match_history_by_player`, problema 6). */
export interface HistoryCleanupPort {
  /** Borra la fila de la partida de cada jugador. Idempotente. */
  deleteMatch(matchId: string, endedAt: Date, playerIds: readonly string[]): Promise<void>;
}

/** Grafo de coparticipación (Neo4j, problema 7). */
export interface GraphCleanupPort {
  /** Borra el nodo de la partida y sus relaciones PLAYED. Idempotente. */
  deleteMatch(matchId: string): Promise<void>;
}

/** Leaderboards de temporada (sorted sets de Redis, problema 5). */
export interface ReversalLeaderboardPort {
  /** Las publicaciones de estos jugadores se saltean hasta liberarlos. Idempotente. */
  hold(seasonId: string, mode: string, holdId: string, playerIds: readonly string[]): Promise<void>;
  /** Quita la retención y escribe los standings actuales, de forma atómica para todo el tablero. */
  release(
    seasonId: string,
    mode: string,
    holdId: string,
    entries: readonly HeldStanding[],
  ): Promise<void>;
  /** La publicación del problema 5, que respeta la revisión; saltea a los jugadores retenidos. */
  publish(seasonId: string, mode: string, standings: readonly SeasonStanding[]): Promise<void>;
}
