export type QueueTicket = {
  enqueuedAt: number;
  mmr: number;
  mode: string;
  playerId: string;
  region: string;
  ticketId: string;
};

export type EnqueueOutcome =
  | { status: "enqueued"; ticket: QueueTicket }
  | { status: "replayed"; ticket: QueueTicket }
  | { status: "already_in_queue"; ticket: QueueTicket }
  | { status: "already_in_match"; matchId: string };

export type EnqueueResult = {
  created: boolean;
  ticket: QueueTicket;
};

export type EligiblePlayer = {
  accountStatus: string;
  id: string;
  ratings: Readonly<Record<string, { mmr: number }>>;
  region: string;
};

export type QueueMode = {
  id: string;
  initialRating: number;
};

export type SanctionInForce = {
  endsAt: Date | null;
  id: string;
  type: string;
};

export type EvictionResult = {
  evicted: boolean;
  sanction?: SanctionInForce;
  sanctioned: boolean;
};
