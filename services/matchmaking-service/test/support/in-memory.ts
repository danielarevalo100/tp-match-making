import type { Clock, IdGenerator } from "../../src/application/ports/system.js";
import type { QueueTicket } from "../../src/domain/entities/queue-ticket.js";
import type {
  EligibilityRepository,
  EligiblePlayer,
  QueueMode,
  SanctionInForce,
} from "../../src/domain/repositories/eligibility-repository.js";
import type {
  EnqueueOutcome,
  MatchmakingQueue,
} from "../../src/domain/repositories/matchmaking-queue.js";

export type StoredSanction = SanctionInForce & {
  playerId: string;
  startsAt: Date;
  status: "active" | "expired" | "revoked";
};

export class InMemoryEligibilityRepository implements EligibilityRepository {
  readonly players = new Map<string, EligiblePlayer>();
  readonly modes = new Map<string, QueueMode>([
    ["ranked_1v1", { id: "ranked_1v1", initialRating: 1_000 }],
  ]);
  readonly regions = new Set(["LATAM", "EU"]);
  readonly sanctions: StoredSanction[] = [];

  async findPlayer(playerId: string): Promise<EligiblePlayer | null> {
    return this.players.get(playerId) ?? null;
  }

  async findActiveMode(modeId: string): Promise<QueueMode | null> {
    return this.modes.get(modeId) ?? null;
  }

  async isActiveRegion(regionId: string): Promise<boolean> {
    return this.regions.has(regionId);
  }

  // Same predicate as the Mongo query.
  async findSanctionInForce(playerId: string, at: Date): Promise<SanctionInForce | null> {
    return (
      this.sanctions.find(
        (sanction) =>
          sanction.playerId === playerId &&
          sanction.status === "active" &&
          sanction.startsAt <= at &&
          (sanction.endsAt === null || sanction.endsAt > at),
      ) ?? null
    );
  }
}

// Mirrors the semantics of the Lua script (single-threaded, so trivially atomic).
export class InMemoryMatchmakingQueue implements MatchmakingQueue {
  readonly tickets = new Map<string, QueueTicket>();
  readonly activeMatches = new Map<string, string>();

  async enqueue(ticket: QueueTicket): Promise<EnqueueOutcome> {
    const existing = this.tickets.get(ticket.playerId);
    if (existing) {
      return {
        status: existing.ticketId === ticket.ticketId ? "replayed" : "already_in_queue",
        ticket: existing,
      };
    }
    const matchId = this.activeMatches.get(ticket.playerId);
    if (matchId) return { status: "already_in_match", matchId };
    this.tickets.set(ticket.playerId, ticket);
    return { status: "enqueued", ticket };
  }

  async findTicket(playerId: string): Promise<QueueTicket | null> {
    return this.tickets.get(playerId) ?? null;
  }

  async leave(playerId: string): Promise<boolean> {
    return this.tickets.delete(playerId);
  }
}

export class FixedClock implements Clock {
  constructor(private readonly date: Date) {}
  now(): Date {
    return this.date;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;
  generate(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
  }
}
