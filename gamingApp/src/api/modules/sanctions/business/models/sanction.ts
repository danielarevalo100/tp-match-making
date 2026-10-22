import type {
  MatchLifecycleStatus,
  ScoringStatus,
} from "../../../matchClosure/business/models/matchClosure.js";

/** Mismos valores que el validador de `sanctions.type`; todos bloquean el matchmaking (problema 1). */
export const sanctionTypes = [
  "matchmaking_restriction",
  "temporary_suspension",
  "permanent_ban",
] as const;
export type SanctionType = (typeof sanctionTypes)[number];

export const sanctionStatuses = ["active", "expired", "revoked"] as const;
export type SanctionStatus = (typeof sanctionStatuses)[number];

/**
 * Reversión de los resultados de las partidas en las que el jugador hizo trampa. La sanción se
 * registra primero y queda en vigor pase lo que pase con la reversión, que solo avanza:
 *
 *   pending -> reverting -> completed
 *                  |
 *                  +-----> failed -> reverting (reintento o resume)
 */
export const reversalStatuses = ["pending", "reverting", "completed", "failed"] as const;
export type ReversalStatus = (typeof reversalStatuses)[number];

/**
 * Pasos de la reversión que se anotan en el journal, en orden. Las partidas se anotan una por una
 * en `revertedMatchIds`, entre `hold` y `leaderboard`.
 */
export const reversalSteps = ["queue", "hold", "leaderboard"] as const;
export type ReversalStep = (typeof reversalSteps)[number];

/** Un tablero de temporada y modo, y los jugadores de las partidas anuladas que tiene que retener. */
export type HeldBoard = {
  mode: string;
  playerIds: readonly string[];
  seasonId: string;
};

/** Punto de control durable de la reversión, guardado dentro del documento de la sanción. */
export type ReversalJournal = {
  attempts: number;
  completedAt: Date | null;
  completedSteps: readonly ReversalStep[];
  /** Tableros retenidos en Redis; el paso de release libera exactamente estos. */
  heldBoards: readonly HeldBoard[];
  lastError: string | null;
  revertedMatchIds: readonly string[];
  status: ReversalStatus;
  updatedAt: Date;
};

export type SanctionRecord = {
  administratorId: string;
  createdAt: Date;
  description: string | null;
  /** null = permanente. */
  endsAt: Date | null;
  id: string;
  /** Partidas cuyos resultados se anulan, tal como las listó el administrador. */
  matchIds: readonly string[];
  playerId: string;
  reason: string;
  reportId: string | null;
  reversal: ReversalJournal;
  startsAt: Date;
  status: SanctionStatus;
  type: SanctionType;
};

export type SanctionInput = {
  administratorId: string;
  description: string | null;
  endsAt: Date | null;
  matchIds: readonly string[];
  playerId: string;
  reason: string;
  reportId: string | null;
  /** Clave de idempotencia elegida por quien llama: reintentar el mismo id continúa la misma sanción. */
  sanctionId: string;
  startsAt: Date | null;
  type: SanctionType;
};

export type AdministratorInfo = { active: boolean; id: string };
export type ReportInfo = { id: string; matchId: string | null; reportedPlayerId: string };

/** El cambio de rating de un participante que aplicó el problema 4 y el problema 8 deshace. */
export type ReversibleParticipant = {
  playerId: string;
  ratingDelta: number;
};

/** Una partida tal como la necesita el problema 8: su marcador final y si ya está anulada. */
export type ReversibleMatch = {
  /** Cuándo la formó el problema 2; decide la temporada para la que contó. */
  createdAt: Date;
  /** `closure.tsMs`: el `ended_at` de sus filas en el historial (problema 6). */
  endedAt: Date | null;
  id: string;
  mode: string;
  /** De `finalScoreboard`; vacío hasta que el problema 4 aplica el scoring. */
  participants: readonly ReversibleParticipant[];
  scoringStatus: ScoringStatus;
  status: MatchLifecycleStatus;
  voidedBySanctionId: string | null;
};

export type CatalogSeason = {
  endsAt: Date;
  id: string;
  startsAt: Date;
  status: string;
};

/** Lo que decide qué standings de temporada cambió una partida (catálogos de MongoDB). */
export type SeasonCatalog = {
  rankedModes: readonly string[];
  seasons: readonly CatalogSeason[];
};

/**
 * Standings de temporada que cambió una partida. El MMR no se reinicia entre temporadas, así que
 * una partida mueve el standing de su temporada y el de cada temporada posterior en la que el
 * jugador tenga standing.
 */
export type AffectedSeasons = {
  /** Temporada que contiene la partida, cuyo `gamesPlayed` la contó. */
  matchSeasonId: string | null;
  /** Esa temporada y las posteriores. Vacío si el modo no es rankeado. */
  seasonIds: readonly string[];
};

export type RatingReversal = {
  at: Date;
  /** El delta que aplicó el problema 4; se resta. */
  delta: number;
  matchId: string;
  matchSeasonId: string | null;
  mode: string;
  playerId: string;
  seasonIds: readonly string[];
};

/** Un standing de temporada tal como lo guarda MongoDB, con las partidas que siguen contando. */
export type SeasonStanding = {
  gamesPlayed: number;
  mmr: number;
  playerId: string;
  region: string;
  revision: number;
};

/** Un jugador retenido y su standing actual en el tablero, o null si no tiene. */
export type HeldStanding = {
  playerId: string;
  standing: SeasonStanding | null;
};

export type ReversalView = {
  attempts: number;
  completedAt: Date | null;
  completedSteps: readonly ReversalStep[];
  lastError: string | null;
  pendingMatchIds: readonly string[];
  revertedMatchIds: readonly string[];
  status: ReversalStatus;
};

export type SanctionView = {
  administratorId: string;
  createdAt: Date;
  description: string | null;
  endsAt: Date | null;
  matchIds: readonly string[];
  playerId: string;
  reason: string;
  reportId: string | null;
  reversal: ReversalView;
  sanctionId: string;
  startsAt: Date;
  status: SanctionStatus;
  type: SanctionType;
};

export type SanctionOutcome = {
  /** False si el pedido repitió una sanción que ya estaba registrada. */
  created: boolean;
  sanction: SanctionView;
};
