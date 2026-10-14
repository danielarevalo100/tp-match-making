import type { Redis } from "ioredis";

import type { QueueTicket } from "../../domain/entities/queue-ticket.js";
import { QueueUnavailableError } from "../../domain/errors/matchmaking-errors.js";
import type {
  EnqueueOutcome,
  MatchmakingQueue,
} from "../../domain/repositories/matchmaking-queue.js";
import { activeMatchKey, ratingQueueKey, ticketKey, waitQueueKey } from "./keys.js";
import { ENQUEUE_SCRIPT, LEAVE_SCRIPT } from "./redis-scripts.js";

function fieldsToTicket(fields: Record<string, string>): QueueTicket | null {
  const { enqueuedAt, mmr, mode, playerId, region, ticketId } = fields;
  if (!enqueuedAt || !mmr || !mode || !playerId || !region || !ticketId) return null;
  return {
    enqueuedAt: Number(enqueuedAt),
    mmr: Number(mmr),
    mode,
    playerId,
    region,
    ticketId,
  };
}

function flatToRecord(flat: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let index = 0; index + 1 < flat.length; index += 2) {
    record[flat[index] as string] = flat[index + 1] as string;
  }
  return record;
}

export class RedisMatchmakingQueue implements MatchmakingQueue {
  constructor(private readonly redis: Redis) {}

  async enqueue(ticket: QueueTicket): Promise<EnqueueOutcome> {
    const reply = await this.run(
      () =>
        this.redis.eval(
          ENQUEUE_SCRIPT,
          4,
          ticketKey(ticket.playerId),
          activeMatchKey(ticket.playerId),
          ratingQueueKey(ticket.mode, ticket.region),
          waitQueueKey(ticket.mode, ticket.region),
          ticket.playerId,
          ticket.ticketId,
          ticket.mode,
          ticket.region,
          String(ticket.mmr),
          String(ticket.enqueuedAt),
        ) as Promise<string[]>,
    );

    const [status, ...rest] = reply;
    switch (status) {
      case "ENQUEUED":
        return { status: "enqueued", ticket };
      case "ALREADY_IN_MATCH":
        return { status: "already_in_match", matchId: rest[0] ?? "" };
      case "REPLAYED":
      case "ALREADY_IN_QUEUE": {
        const existing = fieldsToTicket(flatToRecord(rest));
        if (!existing) throw new QueueUnavailableError(new Error("Corrupt ticket in Redis"));
        return { status: status === "REPLAYED" ? "replayed" : "already_in_queue", ticket: existing };
      }
      default:
        throw new QueueUnavailableError(new Error(`Unexpected enqueue reply: ${String(status)}`));
    }
  }

  async findTicket(playerId: string): Promise<QueueTicket | null> {
    const fields = await this.run(() => this.redis.hgetall(ticketKey(playerId)));
    return fieldsToTicket(fields);
  }

  async leave(playerId: string): Promise<boolean> {
    const removed = await this.run(
      () => this.redis.eval(LEAVE_SCRIPT, 1, ticketKey(playerId), playerId) as Promise<number>,
    );
    return removed === 1;
  }

  // Any Redis failure (connection down, timeout) surfaces as a 503.
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      throw new QueueUnavailableError(error);
    }
  }
}
