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
import type { EnqueueResult, QueueTicket } from "../models/queueTicket.js";
import type { EligibilityRepositoryPort, MatchmakingQueuePort } from "../ports/matchmakingPorts.js";

export type EnqueuePlayerInput = {
  mode: string;
  playerId: string;
  region?: string | undefined;
  ticketId?: string | undefined;
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
        return { created: true, ticket: outcome.ticket };
      case "replayed":
        return { created: false, ticket: outcome.ticket };
      case "already_in_queue":
        throw new AlreadyInQueueError(outcome.ticket);
      case "already_in_match":
        throw new AlreadyInMatchError(outcome.matchId);
    }
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
