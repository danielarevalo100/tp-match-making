import { randomUUID } from "node:crypto";

import {
  AccountNotActiveError,
  AlreadyInMatchError,
  AlreadyInQueueError,
  ModeNotAvailableError,
  PlayerNotFoundError,
  PlayerSanctionedError,
  RegionNotFoundError,
  TicketNotFoundError,
} from "../models/matchmakingErrors.js";
import type { EnqueueResult, EvictionResult, QueueTicket } from "../models/queueTicket.js";
import type { EligibilityRepositoryPort, MatchmakingQueuePort } from "../ports/matchmakingPorts.js";

export type EnqueuePlayerInput = {
  mode: string;
  playerId: string;
  region?: string;
  ticketId?: string;
};

export class MatchmakingService {
  constructor(
    private readonly eligibility: EligibilityRepositoryPort,
    private readonly queue: MatchmakingQueuePort,
  ) {}

  async enqueue(input: EnqueuePlayerInput): Promise<EnqueueResult> {
    const player = await this.eligibility.findPlayer(input.playerId);
    if (!player) throw new PlayerNotFoundError(input.playerId);
    if (player.accountStatus !== "active") throw new AccountNotActiveError(player.accountStatus);

    const mode = await this.eligibility.findActiveMode(input.mode);
    if (!mode) throw new ModeNotAvailableError(input.mode);

    const region = input.region ?? player.region;
    if (!(await this.eligibility.isActiveRegion(region))) throw new RegionNotFoundError(region);

    const now = new Date();
    const sanction = await this.eligibility.findSanctionInForce(player.id, now);
    if (sanction) throw new PlayerSanctionedError(sanction.id, sanction.type, sanction.endsAt);

    const outcome = await this.queue.enqueue({
      enqueuedAt: now.getTime(),
      mmr: player.ratings[mode.id]?.mmr ?? mode.initialRating,
      mode: mode.id,
      playerId: player.id,
      region,
      ticketId: input.ticketId ?? randomUUID(),
    });

    switch (outcome.status) {
      case "enqueued":
      case "replayed":
        // Pudo aplicarse una sanción entre el chequeo de arriba y la escritura en Redis; se
        // vuelve a chequear ahora que el ticket ya está visible en la cola.
        await this.assertNotSanctionedOrLeave(player.id);
        return { created: outcome.status === "enqueued", ticket: outcome.ticket };
      case "already_in_queue":
        throw new AlreadyInQueueError(outcome.ticket);
      case "already_in_match":
        throw new AlreadyInMatchError(outcome.matchId);
    }
  }

  private async assertNotSanctionedOrLeave(playerId: string): Promise<void> {
    const sanction = await this.eligibility.findSanctionInForce(playerId, new Date());
    if (!sanction) return;
    await this.queue.leave(playerId);
    throw new PlayerSanctionedError(sanction.id, sanction.type, sanction.endsAt);
  }

  async evictIfSanctioned(playerId: string): Promise<EvictionResult> {
    const sanction = await this.eligibility.findSanctionInForce(playerId, new Date());
    if (!sanction) return { evicted: false, sanctioned: false };
    const evicted = await this.queue.leave(playerId);
    return { evicted, sanction, sanctioned: true };
  }

  async getTicket(playerId: string): Promise<QueueTicket> {
    const ticket = await this.queue.findTicket(playerId);
    if (!ticket) throw new TicketNotFoundError(playerId);
    return ticket;
  }

  async leave(playerId: string): Promise<void> {
    if (!(await this.queue.leave(playerId))) throw new TicketNotFoundError(playerId);
  }
}
