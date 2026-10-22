import type { ClosedMatch } from "../../../src/api/modules/playerHistory/business/models/playerHistory.js";
import type {
  OpposingPair,
  ReportedPlayerReports,
} from "../../../src/api/modules/fraudDetection/business/models/fraud.js";
import type {
  MatchGraphPort,
  PlayerNamesPort,
  ReportsPort,
} from "../../../src/api/modules/fraudDetection/business/ports/fraudPorts.js";
import { failIfRequested } from "../../../src/shared/requestContext.js";

/** Replica el Cypher de `neo4jMatchGraphAdapter`: si cambia la consulta, cambiar esto también. */
export class InMemoryMatchGraph implements MatchGraphPort {
  readonly matches = new Map<string, ClosedMatch>();

  async upsertMatches(matches: readonly ClosedMatch[]): Promise<void> {
    failIfRequested("neo4j");
    for (const match of matches) this.matches.set(match.id, match);
  }

  async findOpposingPairs(query: {
    limit: number;
    minMatches: number;
    mode?: string | undefined;
    since: Date;
  }): Promise<OpposingPair[]> {
    const pairs = new Map<string, OpposingPair>();

    for (const match of this.matches.values()) {
      if (match.endedAt < query.since || (query.mode && match.mode !== query.mode)) continue;
      for (const a of match.players) {
        for (const b of match.players) {
          const opposed =
            (a.result === "win" && b.result === "loss") ||
            (a.result === "loss" && b.result === "win");
          if (!(a.playerId < b.playerId) || !opposed) continue;
          const key = `${a.playerId}|${b.playerId}`;
          const pair = pairs.get(key) ?? {
            matches: 0,
            playerA: a.playerId,
            playerB: b.playerId,
            winsA: 0,
            winsB: 0,
          };
          pair.matches += 1;
          if (a.result === "win") pair.winsA += 1;
          else pair.winsB += 1;
          pairs.set(key, pair);
        }
      }
    }

    return [...pairs.values()]
      .filter((pair) => pair.matches >= query.minMatches)
      .sort((a, b) => b.matches - a.matches)
      .slice(0, query.limit);
  }
}

export class InMemoryReports implements ReportsPort {
  readonly reports: {
    createdAt: Date;
    id: string;
    reportedPlayerId: string;
    reporterPlayerId: string | null;
  }[] = [];

  async findReportedByMany(since: Date, minReporters: number): Promise<ReportedPlayerReports[]> {
    const byReported = new Map<string, ReportedPlayerReports["reports"][number][]>();
    for (const report of this.reports) {
      if (report.createdAt < since || report.reporterPlayerId === null) continue;
      byReported.set(report.reportedPlayerId, [
        ...(byReported.get(report.reportedPlayerId) ?? []),
        {
          createdAt: report.createdAt,
          reportId: report.id,
          reporterPlayerId: report.reporterPlayerId,
        },
      ]);
    }
    return [...byReported.entries()]
      .filter(
        ([, reports]) =>
          new Set(reports.map((report) => report.reporterPlayerId)).size >= minReporters,
      )
      .map(([reportedPlayerId, reports]) => ({ reportedPlayerId, reports }));
  }
}

export class InMemoryPlayerNames implements PlayerNamesPort {
  readonly names = new Map<string, string>();

  async findUsernames(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return new Map(
      playerIds.flatMap((id) => {
        const name = this.names.get(id);
        return name === undefined ? [] : [[id, name] as const];
      }),
    );
  }
}
