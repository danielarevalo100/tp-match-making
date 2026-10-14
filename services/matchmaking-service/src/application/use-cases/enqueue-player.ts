import type { QueueTicket } from "../../domain/entities/queue-ticket.js";
import {
  AccountNotActiveError,
  AlreadyInMatchError,
  AlreadyInQueueError,
  ModeNotAvailableError,
  PlayerNotFoundError,
  PlayerSanctionedError,
  RegionNotFoundError,
} from "../../domain/errors/matchmaking-errors.js";
import type { EligibilityRepository } from "../../domain/repositories/eligibility-repository.js";
import type { MatchmakingQueue } from "../../domain/repositories/matchmaking-queue.js";
import type { Clock, IdGenerator } from "../ports/system.js";

export type EnqueuePlayerInput = {
  mode: string;
  playerId: string;
  region?: string | undefined;
  ticketId?: string | undefined;
};

export type EnqueuePlayerResult = {
  // false when the same ticketId was already enqueued (idempotent replay).
  created: boolean;
  ticket: QueueTicket;
};

// Problem 1. Validates against MongoDB (read-only) and writes only to Redis.
// Checks are ordered from cheapest to most specific; the "one queue at a
// time" and "no active match" rules are enforced atomically by the queue.
export class EnqueuePlayer {
  constructor(
    private readonly eligibility: EligibilityRepository,
    private readonly queue: MatchmakingQueue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: EnqueuePlayerInput): Promise<EnqueuePlayerResult> {
    const player = await this.eligibility.findPlayer(input.playerId);
    if (!player) throw new PlayerNotFoundError(input.playerId);
    if (player.accountStatus !== "active") throw new AccountNotActiveError(player.accountStatus);

    const mode = await this.eligibility.findActiveMode(input.mode);
    if (!mode) throw new ModeNotAvailableError(input.mode);

    const region = input.region ?? player.region;
    if (!(await this.eligibility.isActiveRegion(region))) throw new RegionNotFoundError(region);

    const now = this.clock.now();
    const sanction = await this.eligibility.findSanctionInForce(player.id, now);
    if (sanction) {
      throw new PlayerSanctionedError(sanction.id, sanction.type, sanction.endsAt);
    }

    // Players registered before a mode existed have no rating for it.
    const mmr = player.ratings[mode.id]?.mmr ?? mode.initialRating;

    const outcome = await this.queue.enqueue({
      enqueuedAt: now.getTime(),
      mmr,
      mode: mode.id,
      playerId: player.id,
      region,
      ticketId: input.ticketId ?? this.ids.generate(),
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
}
