/** Dos jugadores que se enfrentaron (uno ganó y el otro perdió) en `matches` partidas. */
export type OpposingPair = {
  matches: number;
  playerA: string;
  playerB: string;
  winsA: number;
  winsB: number;
};

export type MatchFixingCriteria = {
  /** Cantidad máxima de grupos devueltos. */
  limit: number;
  /** Proporción de sus partidas entre sí que tiene que ganar el beneficiado. */
  minBenefitRatio: number;
  /** Mínimo de partidas decididas que los dos jugaron entre sí. */
  minMatches: number;
  mode?: string;
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

/** Un jugador que le gana siempre a los mismos rivales, con esos rivales. */
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

/** Todos los reportes con un jugador como autor que recibió un jugador. */
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
  /** Jugadores que están en un grupo de arreglo de partidas y además tienen reportes coincidentes. */
  playersInBoth: readonly string[];
};
