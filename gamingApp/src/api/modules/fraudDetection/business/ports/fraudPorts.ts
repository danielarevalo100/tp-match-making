import type {
  ClosedMatch,
  ClosedMatchQuery,
} from "../../../playerHistory/business/models/playerHistory.js";
import type { OpposingPair, ReportedPlayerReports } from "../models/fraud.js";

/** Who played against whom (Neo4j). */
export interface MatchGraphPort {
  /** Idempotent: nodes and relationships are merged by matchId / playerId. */
  upsertMatches(matches: readonly ClosedMatch[]): Promise<void>;
  /** Pairs that played at least `minMatches` decided matches against each other since `since`. */
  findOpposingPairs(query: {
    limit: number;
    minMatches: number;
    mode?: string;
    since: Date;
  }): Promise<OpposingPair[]>;
}

/** Reports filed by players (MongoDB). */
export interface ReportsPort {
  /** Players with at least `minReporters` distinct reporters since `since`, with all those reports. */
  findReportedByMany(since: Date, minReporters: number): Promise<ReportedPlayerReports[]>;
}

export interface PlayerNamesPort {
  findUsernames(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** Same closed matches the history reads: MongoDB `matches` with an applied final scoreboard. */
export interface FraudMatchSourcePort {
  listClosedMatches(query: ClosedMatchQuery): Promise<ClosedMatch[]>;
}
