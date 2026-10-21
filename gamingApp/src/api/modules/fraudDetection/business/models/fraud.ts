/** Two players that faced each other (one won, the other lost) in `matches` matches. */
export type OpposingPair = {
  matches: number;
  playerA: string;
  playerB: string;
  winsA: number;
  winsB: number;
};

export type MatchFixingCriteria = {
  /** Maximum number of groups returned. */
  limit: number;
  /** Share of their matches against each other that the beneficiary has to win. */
  minBenefitRatio: number;
  /** Minimum number of decided matches the two players played against each other. */
  minMatches: number;
  mode?: string | undefined;
  since: Date;
};

export type FixingPartner = {
  benefitRatio: number;
  beneficiaryWins: number;
  matches: number;
  partnerWins: number;
  playerId: string;
  username: string | null;
};

/** One player who keeps beating the same opponents, with those opponents. */
export type MatchFixingGroup = {
  beneficiary: { playerId: string; username: string | null };
  partners: readonly FixingPartner[];
  totalMatches: number;
};

export type MatchFixingResult = {
  criteria: { minBenefitRatio: number; minMatches: number; mode: string | null; since: Date };
  groups: readonly MatchFixingGroup[];
};

export type ReportRecord = {
  createdAt: Date;
  reportId: string;
  reporterPlayerId: string;
};

/** Every report with a human reporter received by one player. */
export type ReportedPlayerReports = {
  reportedPlayerId: string;
  reports: readonly ReportRecord[];
};

export type CrossReportCriteria = {
  minReporters: number;
  since: Date;
  windowMs: number;
};

export type CrossReportAlert = {
  distinctReporters: number;
  firstReportAt: Date;
  lastReportAt: Date;
  reportIds: readonly string[];
  reportedPlayerId: string;
  reporters: readonly string[];
  username: string | null;
};

export type CrossReportResult = {
  alerts: readonly CrossReportAlert[];
  criteria: { minReporters: number; since: Date; windowMinutes: number };
};

export type IrregularBehaviorResult = {
  crossReports: CrossReportResult;
  matchFixing: MatchFixingResult;
  /** Players that appear in a match-fixing group and also have converging reports. */
  playersInBoth: readonly string[];
};
