import type {
  ClosedMatch,
  ClosedMatchQuery,
} from "../../../playerHistory/business/models/playerHistory.js";
import type { OpposingPair, ReportedPlayerReports } from "../models/fraud.js";

/** Quién jugó contra quién (Neo4j). */
export interface MatchGraphPort {
  /** Idempotente: nodos y relaciones se unen (MERGE) por matchId / playerId. */
  upsertMatches(matches: readonly ClosedMatch[]): Promise<void>;
  /** Pares que jugaron al menos `minMatches` partidas decididas entre sí desde `since`. */
  findOpposingPairs(query: {
    limit: number;
    minMatches: number;
    mode?: string;
    since: Date;
  }): Promise<OpposingPair[]>;
}

/** Reportes hechos por jugadores (MongoDB). */
export interface ReportsPort {
  /** Jugadores con al menos `minReporters` autores distintos desde `since`, con esos reportes. */
  findReportedByMany(since: Date, minReporters: number): Promise<ReportedPlayerReports[]>;
}

export interface PlayerNamesPort {
  findUsernames(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** Las mismas partidas cerradas que lee el historial: `matches` de Mongo con marcador final aplicado. */
export interface FraudMatchSourcePort {
  listClosedMatches(query: ClosedMatchQuery): Promise<ClosedMatch[]>;
}
