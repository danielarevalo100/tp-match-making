import type {
  FixingPartner,
  MatchFixingGroup,
  OpposingPair,
  CrossReportAlert,
  ReportedPlayerReports,
} from "../models/fraud.js";

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Turns the pairs found in the graph into groups: for each pair the winner of most of their
 * matches is the beneficiary, and a beneficiary keeps the opponents it beats at least
 * `minBenefitRatio` of the time. A pair with the same number of wins each has no beneficiary.
 */
export function buildMatchFixingGroups(
  pairs: readonly OpposingPair[],
  rules: { minBenefitRatio: number; minMatches: number },
): MatchFixingGroup[] {
  const byBeneficiary = new Map<string, FixingPartner[]>();

  for (const pair of pairs) {
    if (pair.matches < rules.minMatches || pair.winsA === pair.winsB) continue;
    const aBenefits = pair.winsA > pair.winsB;
    const beneficiaryWins = aBenefits ? pair.winsA : pair.winsB;
    const benefitRatio = beneficiaryWins / pair.matches;
    if (benefitRatio < rules.minBenefitRatio) continue;

    const beneficiary = aBenefits ? pair.playerA : pair.playerB;
    byBeneficiary.set(beneficiary, [
      ...(byBeneficiary.get(beneficiary) ?? []),
      {
        benefitRatio: round(benefitRatio),
        beneficiaryWins,
        matches: pair.matches,
        partnerWins: pair.matches - beneficiaryWins,
        playerId: aBenefits ? pair.playerB : pair.playerA,
        username: null,
      },
    ]);
  }

  return [...byBeneficiary.entries()]
    .map(([playerId, partners]) => ({
      beneficiary: { playerId, username: null },
      partners: [...partners].sort((a, b) => b.matches - a.matches),
      totalMatches: partners.reduce((sum, partner) => sum + partner.matches, 0),
    }))
    .sort((a, b) => b.partners.length - a.partners.length || b.totalMatches - a.totalMatches);
}

/**
 * For each reported player, finds the busiest window of `windowMs`: the one with the most
 * different reporters. The player is flagged when that number reaches `minReporters`; many
 * reports from a single reporter, or reports spread over a long time, do not count.
 */
export function findReportBursts(
  reported: readonly ReportedPlayerReports[],
  rules: { minReporters: number; windowMs: number },
): CrossReportAlert[] {
  const alerts: CrossReportAlert[] = [];

  for (const { reportedPlayerId, reports } of reported) {
    const sorted = [...reports].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const inWindow = new Map<string, number>();
    let left = 0;
    let best: { distinct: number; left: number; right: number } | null = null;

    for (let right = 0; right < sorted.length; right++) {
      const added = sorted[right];
      if (!added) continue;
      inWindow.set(added.reporterPlayerId, (inWindow.get(added.reporterPlayerId) ?? 0) + 1);

      while (
        added.createdAt.getTime() - (sorted[left]?.createdAt.getTime() ?? 0) >
        rules.windowMs
      ) {
        const removed = sorted[left]?.reporterPlayerId ?? "";
        const remaining = (inWindow.get(removed) ?? 1) - 1;
        if (remaining === 0) inWindow.delete(removed);
        else inWindow.set(removed, remaining);
        left += 1;
      }
      if (inWindow.size > (best?.distinct ?? 0)) best = { distinct: inWindow.size, left, right };
    }

    if (!best || best.distinct < rules.minReporters) continue;
    const burst = sorted.slice(best.left, best.right + 1);
    const first = burst[0];
    const last = burst.at(-1);
    if (!first || !last) continue;
    alerts.push({
      distinctReporters: best.distinct,
      firstReportAt: first.createdAt,
      lastReportAt: last.createdAt,
      reportIds: burst.map((report) => report.reportId),
      reportedPlayerId,
      reporters: [...new Set(burst.map((report) => report.reporterPlayerId))],
      username: null,
    });
  }

  return alerts.sort(
    (a, b) =>
      b.distinctReporters - a.distinctReporters ||
      b.lastReportAt.getTime() - a.lastReportAt.getTime(),
  );
}
