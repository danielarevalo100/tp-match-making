import type {
  EligiblePlayer,
  QueueMode,
  SanctionInForce,
} from "../../business/models/queueTicket.js";

export type EligiblePlayerDocument = {
  _id: string;
  accountStatus: string;
  ratings: Record<string, { mmr: number }>;
  region: string;
};

export type GameModeDocument = {
  _id: string;
  active: boolean;
  initialRating?: number;
};

export type RegionDocument = {
  _id: string;
  active: boolean;
};

export type SanctionDocument = {
  _id: string;
  endsAt: Date | null;
  playerId: string;
  startsAt: Date;
  status: string;
  type: string;
};

export function toEligiblePlayer(document: EligiblePlayerDocument): EligiblePlayer {
  return {
    accountStatus: document.accountStatus,
    id: document._id,
    ratings: document.ratings,
    region: document.region,
  };
}

export function toQueueMode(document: GameModeDocument): QueueMode {
  return { id: document._id, initialRating: document.initialRating ?? 1_000 };
}

export function toSanctionInForce(document: SanctionDocument): SanctionInForce {
  return { endsAt: document.endsAt, id: document._id, type: document.type };
}
