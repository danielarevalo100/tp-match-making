import type {
  CommitOutcome,
  ReserveOutcome,
  RestoreOutcome,
} from "../../../src/api/modules/matchmaking/business/models/matchFormation.js";
import type {
  EnqueueOutcome,
  QueueTicket,
} from "../../../src/api/modules/matchmaking/business/models/queueTicket.js";
import type { MatchmakingQueuePort } from "../../../src/api/modules/matchmaking/business/ports/matchmakingPorts.js";
import { InjectedFailureError } from "../../../src/shared/errors.js";
import { requestContext } from "../../../src/shared/requestContext.js";

type Formation = {
  abandoned: Set<string>;
  createdAt: number;
  status: "reserved" | "committed" | "rolled_back";
  tickets: QueueTicket[];
};

export class InMemoryMatchmakingQueue implements MatchmakingQueuePort {
  readonly tickets = new Map<string, QueueTicket>();
  readonly activeMatches = new Map<string, string>();
  readonly formations = new Map<string, Formation>();
  readonly liveMatches = new Map<string, readonly string[]>();

  private failIfRequested(step: string): void {
    if (requestContext.getStore()?.failAt === step) throw new InjectedFailureError(step);
  }

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
    if (this.tickets.delete(playerId)) return true;
    const matchId = this.activeMatches.get(playerId);
    const formation = matchId ? this.formations.get(matchId) : undefined;
    if (!matchId || formation?.status !== "reserved") return false;
    formation.abandoned.add(playerId);
    this.activeMatches.delete(playerId);
    return true;
  }

  async findOldestTicket(mode: string, region: string): Promise<QueueTicket | null> {
    return (
      [...this.tickets.values()]
        .filter((ticket) => ticket.mode === mode && ticket.region === region)
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0] ?? null
    );
  }

  async findTicketsInRatingRange(
    mode: string,
    region: string,
    minMmr: number,
    maxMmr: number,
    limit: number,
  ): Promise<QueueTicket[]> {
    return [...this.tickets.values()]
      .filter(
        (ticket) =>
          ticket.mode === mode &&
          ticket.region === region &&
          ticket.mmr >= minMmr &&
          ticket.mmr <= maxMmr,
      )
      .slice(0, limit);
  }

  async reserveFormation(
    matchId: string,
    tickets: readonly QueueTicket[],
  ): Promise<ReserveOutcome> {
    this.failIfRequested("matchmaking.reserve");
    const missing = tickets.filter(
      (ticket) => this.tickets.get(ticket.playerId)?.ticketId !== ticket.ticketId,
    );
    if (missing.length > 0) return { status: "missing", playerIds: missing.map((t) => t.playerId) };

    this.formations.set(matchId, {
      abandoned: new Set(),
      createdAt: Date.now(),
      status: "reserved",
      tickets: tickets.map((ticket) => ({ ...ticket })),
    });
    for (const ticket of tickets) {
      this.tickets.delete(ticket.playerId);
      this.activeMatches.set(ticket.playerId, matchId);
    }
    return { status: "reserved" };
  }

  async commitFormation(
    matchId: string,
    _mode: string,
    _region: string,
    playerIds: readonly string[],
  ): Promise<CommitOutcome> {
    this.failIfRequested("matchmaking.commit");
    const formation = this.formations.get(matchId);
    if (formation?.status === "committed") return { status: "committed" };
    if (!formation || formation.status !== "reserved") throw new Error("Invalid formation.");
    if (formation.abandoned.size > 0) return { status: "abandoned" };
    this.liveMatches.set(matchId, playerIds);
    formation.status = "committed";
    return { status: "committed" };
  }

  async restoreFormation(matchId: string): Promise<RestoreOutcome> {
    this.failIfRequested("matchmaking.restore");
    const formation = this.formations.get(matchId);
    if (!formation) return { restored: [], status: "not_found" };
    if (formation.status === "rolled_back") return { restored: [], status: "already_rolled_back" };
    if (formation.status === "committed") return { restored: [], status: "committed" };

    const restored: string[] = [];
    for (const ticket of formation.tickets) {
      if (formation.abandoned.has(ticket.playerId)) continue;
      if (!this.tickets.has(ticket.playerId)) {
        this.tickets.set(ticket.playerId, { ...ticket });
        restored.push(ticket.playerId);
      }
      if (this.activeMatches.get(ticket.playerId) === matchId) {
        this.activeMatches.delete(ticket.playerId);
      }
    }
    this.liveMatches.delete(matchId);
    formation.status = "rolled_back";
    return { restored, status: "rolled_back" };
  }

  async findStaleFormations(olderThanMs: number): Promise<string[]> {
    return [...this.formations]
      .filter(
        ([, formation]) =>
          formation.status === "reserved" && formation.createdAt <= Date.now() - olderThanMs,
      )
      .map(([matchId]) => matchId);
  }
}
