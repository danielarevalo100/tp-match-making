import { BaseRedisAdapter } from "../../../../../infrastructure/redis/baseRedisAdapter.js";
import { redisKeys } from "../../../../../shared/storageKeys.js";
import type { EnqueueOutcome, QueueTicket } from "../../business/models/queueTicket.js";
import type { MatchmakingQueuePort } from "../../business/ports/matchmakingPorts.js";
import { flatToRecord, toQueueTicket } from "../mappers/queueTicketMapper.js";
import { enqueueScript, leaveScript } from "../scripts/matchmakingScripts.js";

export class RedisQueueAdapter extends BaseRedisAdapter implements MatchmakingQueuePort {
  enqueue(ticket: QueueTicket): Promise<EnqueueOutcome> {
    return this.run("matchmaking.enqueue", async () => {
      const reply = (await this.redis.eval(
        enqueueScript,
        4,
        redisKeys.ticket(ticket.playerId),
        redisKeys.activeMatch(ticket.playerId),
        redisKeys.ratingQueue(ticket.mode, ticket.region),
        redisKeys.waitQueue(ticket.mode, ticket.region),
        ticket.playerId,
        ticket.ticketId,
        ticket.mode,
        ticket.region,
        String(ticket.mmr),
        String(ticket.enqueuedAt),
      )) as string[];

      const [status, ...rest] = reply;
      switch (status) {
        case "ENQUEUED":
          return { status: "enqueued", ticket };
        case "ALREADY_IN_MATCH":
          return { status: "already_in_match", matchId: rest[0] ?? "" };
        case "REPLAYED":
        case "ALREADY_IN_QUEUE": {
          const existing = toQueueTicket(flatToRecord(rest));
          if (!existing) throw new Error("Corrupt ticket in Redis.");
          return {
            status: status === "REPLAYED" ? "replayed" : "already_in_queue",
            ticket: existing,
          };
        }
        default:
          throw new Error(`Unexpected enqueue reply: ${String(status)}`);
      }
    });
  }

  findTicket(playerId: string): Promise<QueueTicket | null> {
    return this.run("matchmaking.findTicket", async () =>
      toQueueTicket(await this.redis.hgetall(redisKeys.ticket(playerId))),
    );
  }

  leave(playerId: string): Promise<boolean> {
    return this.run("matchmaking.leave", async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const ticket = toQueueTicket(await this.redis.hgetall(redisKeys.ticket(playerId)));
        if (!ticket) return false;

        const removed = (await this.redis.eval(
          leaveScript,
          3,
          redisKeys.ticket(playerId),
          redisKeys.ratingQueue(ticket.mode, ticket.region),
          redisKeys.waitQueue(ticket.mode, ticket.region),
          playerId,
          ticket.ticketId,
        )) as number;
        if (removed === 1) return true;
      }
      return false;
    });
  }
}
