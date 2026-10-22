import type {
  CrossReportCriteria,
  CrossReportResult,
  IrregularBehaviorResult,
  MatchFixingCriteria,
  MatchFixingResult,
} from "../models/fraud.js";
import type { MatchGraphPort, PlayerNamesPort, ReportsPort } from "../ports/fraudPorts.js";
import { buildMatchFixingGroups, findReportBursts } from "./detectionRules.js";

// El grafo devuelve pares, no grupos; esto acota lo que lee una detección.
const maxPairs = 5_000;
const minuteMs = 60_000;

/**
 * Detección de comportamiento irregular (problema 7), solo lectura. Dos señales independientes:
 *   - Arreglo de partidas: Neo4j encuentra los jugadores que se enfrentaron muchas veces, y las
 *     reglas de `detectionRules` se quedan con los pares donde uno gana (casi) siempre.
 *   - Reportes coincidentes: MongoDB devuelve los jugadores reportados por muchas personas
 *     distintas, y las reglas se quedan con los casos ocurridos dentro de una ventana corta.
 * Los nombres de usuario se resuelven al final en MongoDB (`players`), por el playerId compartido.
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
