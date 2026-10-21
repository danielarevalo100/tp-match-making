import type {
  CrossReportCriteria,
  CrossReportResult,
  IrregularBehaviorResult,
  MatchFixingCriteria,
  MatchFixingResult,
} from "../models/fraud.js";
import type { MatchGraphPort, PlayerNamesPort, ReportsPort } from "../ports/fraudPorts.js";
import { buildMatchFixingGroups, findReportBursts } from "./detectionRules.js";

// The graph returns pairs, not groups; this bounds what a single detection reads.
const maxPairs = 5_000;
const minuteMs = 60_000;

/**
 * Irregular behavior detection (problem 7), read-only. Two independent signals:
 *   - Match fixing: Neo4j finds the players who faced each other repeatedly, and the rules in
 *     `detectionRules` keep those where one of them wins (almost) every time.
 *   - Converging reports: MongoDB returns the players reported by many different people, and the
 *     rules keep those where that happened inside a short window.
 * Usernames are resolved at the end from MongoDB (the players collection), by the shared playerId.
 */
export class FraudDetectionService {
  constructor(
    private readonly graph: MatchGraphPort,
    private readonly reports: ReportsPort,
    private readonly players: PlayerNamesPort,
  ) {}

  async detectMatchFixing(criteria: MatchFixingCriteria): Promise<MatchFixingResult> {
    const pairs = await this.graph.findOpposingPairs({
      limit: maxPairs,
      minMatches: criteria.minMatches,
      mode: criteria.mode,
      since: criteria.since,
    });
    const groups = buildMatchFixingGroups(pairs, criteria).slice(0, criteria.limit);

    const names = await this.players.findUsernames(
      groups.flatMap((group) => [
        group.beneficiary.playerId,
        ...group.partners.map((partner) => partner.playerId),
      ]),
    );
    return {
      criteria: {
        minBenefitRatio: criteria.minBenefitRatio,
        minMatches: criteria.minMatches,
        mode: criteria.mode ?? null,
        since: criteria.since,
      },
      groups: groups.map((group) => ({
        beneficiary: {
          playerId: group.beneficiary.playerId,
          username: names.get(group.beneficiary.playerId) ?? null,
        },
        partners: group.partners.map((partner) => ({
          ...partner,
          username: names.get(partner.playerId) ?? null,
        })),
        totalMatches: group.totalMatches,
      })),
    };
  }

  async detectCrossReports(criteria: CrossReportCriteria): Promise<CrossReportResult> {
    const reported = await this.reports.findReportedByMany(criteria.since, criteria.minReporters);
    const alerts = findReportBursts(reported, criteria);
    const names = await this.players.findUsernames(alerts.map((alert) => alert.reportedPlayerId));
    return {
      alerts: alerts.map((alert) => ({
        ...alert,
        username: names.get(alert.reportedPlayerId) ?? null,
      })),
      criteria: {
        minReporters: criteria.minReporters,
        since: criteria.since,
        windowMinutes: criteria.windowMs / minuteMs,
      },
    };
  }

  async detectIrregularBehavior(
    matchFixing: MatchFixingCriteria,
    crossReports: CrossReportCriteria,
  ): Promise<IrregularBehaviorResult> {
    const [fixing, reported] = await Promise.all([
      this.detectMatchFixing(matchFixing),
      this.detectCrossReports(crossReports),
    ]);
    const fixingPlayers = new Set(
      fixing.groups.flatMap((group) => [
        group.beneficiary.playerId,
        ...group.partners.map((partner) => partner.playerId),
      ]),
    );
    return {
      crossReports: reported,
      matchFixing: fixing,
      playersInBoth: reported.alerts
        .map((alert) => alert.reportedPlayerId)
        .filter((playerId) => fixingPlayers.has(playerId)),
    };
  }
}
