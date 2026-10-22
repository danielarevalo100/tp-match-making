import type { HistoryEntry } from "../../../playerHistory/business/models/playerHistory.js";
import type { ReversalStatus, SanctionStatus, SanctionType } from "./sanction.js";

export const defaultProfileMatches = 10;
export const maxProfileMatches = 50;
export const maxProfileSanctions = 20;

export type ProfilePlayer = {
  accountStatus: string;
  country: string;
  id: string;
  level: number;
  region: string;
  registeredAt: Date;
  username: string;
};

export type ProfileRating = {
  gamesPlayed: number;
  mmr: number;
  mode: string;
};

export type ProfileStanding = {
  gamesPlayed: number;
  mmr: number;
  mode: string;
  region: string;
  seasonId: string;
};

/** Lo que MongoDB sabe del jugador: perfil, rating por modo y standings de temporada. */
export type ProfileDirectoryEntry = {
  player: ProfilePlayer;
  ratings: readonly ProfileRating[];
  standings: readonly ProfileStanding[];
};

export type ProfileSanctionRecord = {
  endsAt: Date | null;
  reason: string;
  reversalStatus: ReversalStatus | null;
  sanctionId: string;
  startsAt: Date;
  status: SanctionStatus;
  type: SanctionType;
  voidedMatches: number;
};

export type ProfileSanction = ProfileSanctionRecord & {
  /** La misma regla que aplica el problema 1: activa, ya empezada y todavía sin terminar. */
  inForce: boolean;
};

export type BoardPosition = {
  position: number;
  totalPlayers: number;
};

/** Posición leída de Redis en el momento; null si el jugador no está en ese tablero. */
export type ProfileLeaderboard = {
  gamesPlayed: number;
  global: BoardPosition | null;
  mmr: number;
  mode: string;
  region: string;
  regional: BoardPosition | null;
  seasonId: string;
};

export type PlayerProfile = {
  /** Posiciones en los tableros de la temporada activa, una por modo rankeado que jugó. */
  leaderboards: readonly ProfileLeaderboard[];
  player: ProfilePlayer;
  ratings: readonly ProfileRating[];
  /** La más nueva primero, del historial (problema 6); las partidas anuladas no están. */
  recentMatches: readonly HistoryEntry[];
  sanctions: readonly ProfileSanction[];
  seasonId: string | null;
};
