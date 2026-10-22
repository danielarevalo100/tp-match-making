import { BaseRedisAdapter } from "../../../../../infrastructure/redis/baseRedisAdapter.js";
import { redisKeys } from "../../../../../shared/storageKeys.js";
import type {
  CommitOutcome,
  RestoreOutcome,
  ReserveOutcome,
} from "../../business/models/matchFormation.js";
import type { EnqueueOutcome, QueueTicket } from "../../business/models/queueTicket.js";
import type { MatchmakingQueuePort } from "../../business/ports/matchmakingPorts.js";
import { flatToRecord, toQueueTicket } from "../mappers/queueTicketMapper.js";
import {
  abandonFormationScript,
  commitFormationScript,
  enqueueScript,
  leaveScript,
  reserveFormationScript,
  restoreFormationScript,
} from "../scripts/matchmakingScripts.js";

export class RedisQueueAdapter extends BaseRedisAdapter implements MatchmakingQueuePort {
  enqueue(ticket: QueueTicket): Promise<EnqueueOutcome> {
    return this.write(async () => {
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
    return this.read(async () =>
      toQueueTicket(await this.redis.hgetall(redisKeys.ticket(playerId))),
    );
  }

  leave(playerId: string): Promise<boolean> {
    return this.write(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const ticket = toQueueTicket(await this.redis.hgetall(redisKeys.ticket(playerId)));
        if (!ticket) return this.abandonFormation(playerId);

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

  // Sin ticket: el jugador puede estar reservado en una partida que todavía se está formando.
  private async abandonFormation(playerId: string): Promise<boolean> {
    const matchId = await this.redis.get(redisKeys.activeMatch(playerId));
    if (!matchId) return false;
    const abandoned = (await this.redis.eval(
      abandonFormationScript,
      2,
      redisKeys.formation(matchId),
      redisKeys.activeMatch(playerId),
      playerId,
      matchId,
    )) as number;
    return abandoned === 1;
  }

  findOldestTicket(mode: string, region: string): Promise<QueueTicket | null> {
    return this.read(async () => {
      const [playerId] = await this.redis.zrange(redisKeys.waitQueue(mode, region), 0, 0);
      if (!playerId) return null;
      return toQueueTicket(await this.redis.hgetall(redisKeys.ticket(playerId)));
    });
  }

  findTicketsInRatingRange(
    mode: string,
    region: string,
    minMmr: number,
    maxMmr: number,
    limit: number,
  ): Promise<QueueTicket[]> {
    return this.read(async () => {
      const playerIds = await this.redis.zrangebyscore(
        redisKeys.ratingQueue(mode, region),
        minMmr,
        maxMmr,
        "LIMIT",
        0,
        limit,
      );
      if (playerIds.length === 0) return [];

      const pipeline = this.redis.pipeline();
      for (const playerId of playerIds) pipeline.hgetall(redisKeys.ticket(playerId));
      const replies = (await pipeline.exec()) ?? [];
      return replies.flatMap(([error, fields]) => {
        if (error) throw error;
        const ticket = toQueueTicket(fields as Record<string, string>);
        return ticket ? [ticket] : [];
      });
    });
  }

  reserveFormation(matchId: string, tickets: readonly QueueTicket[]): Promise<ReserveOutcome> {
    return this.write(async () => {
      const first = tickets[0];
      if (!first) throw new Error("A formation needs at least one ticket.");

      const reply = (await this.redis.eval(
        reserveFormationScript,
        4 + tickets.length * 2,
        redisKeys.formation(matchId),
        redisKeys.formationIndex,
        redisKeys.ratingQueue(first.mode, first.region),
        redisKeys.waitQueue(first.mode, first.region),
        ...tickets.map((ticket) => redisKeys.ticket(ticket.playerId)),
        ...tickets.map((ticket) => redisKeys.activeMatch(ticket.playerId)),
        matchId,
        String(Date.now()),
        String(tickets.length),
        ...tickets.map((ticket) => ticket.playerId),
        ...tickets.map((ticket) => ticket.ticketId),
      )) as string[];

      const [status, ...rest] = reply;
      switch (status) {
        case "RESERVED":
          return { status: "reserved" };
        case "MISSING":
          return { status: "missing", playerIds: rest };
        default:
          throw new Error(`Unexpected reserve reply: ${String(status)} ${rest.join(" ")}`);
      }
    });
  }

  commitFormation(
    matchId: string,
    mode: string,
    region: string,
    playerIds: readonly string[],
  ): Promise<CommitOutcome> {
    return this.write(async () => {
      const [status] = (await this.redis.eval(
        commitFormationScript,
        3,
        redisKeys.formation(matchId),
        redisKeys.formationIndex,
        redisKeys.match(matchId),
        matchId,
        mode,
        region,
        String(Date.now()),
        playerIds.join(","),
      )) as string[];

      if (status === "COMMITTED") return { status: "committed" };
      if (status === "ABANDONED") return { status: "abandoned" };
      throw new Error(`Unexpected commit reply: ${String(status)}`);
    });
  }

  restoreFormation(matchId: string): Promise<RestoreOutcome> {
    return this.write(async () => {
      const raw = await this.redis.hget(redisKeys.formation(matchId), "tickets");
      if (!raw) return { restored: [], status: "not_found" };

      // La foto de los tickets no cambia, así las claves que se arman acá coinciden con el script.
      const snapshot = (JSON.parse(raw) as Record<string, string>[])
        .map((fields) => toQueueTicket(fields))
        .filter((ticket): ticket is QueueTicket => ticket !== null);
      const first = snapshot[0];
      if (!first) return { restored: [], status: "not_found" };

      const [status, ...restored] = (await this.redis.eval(
        restoreFormationScript,
        5 + snapshot.length * 2,
        redisKeys.formation(matchId),
        redisKeys.formationIndex,
        redisKeys.ratingQueue(first.mode, first.region),
        redisKeys.waitQueue(first.mode, first.region),
        redisKeys.match(matchId),
        ...snapshot.map((ticket) => redisKeys.ticket(ticket.playerId)),
        ...snapshot.map((ticket) => redisKeys.activeMatch(ticket.playerId)),
        matchId,
      )) as string[];

      switch (status) {
        case "ROLLED_BACK":
          return { restored, status: "rolled_back" };
        case "ALREADY_ROLLED_BACK":
          return { restored: [], status: "already_rolled_back" };
        case "COMMITTED":
          return { restored: [], status: "committed" };
        case "NOT_FOUND":
          return { restored: [], status: "not_found" };
        default:
          throw new Error(`Unexpected restore reply: ${String(status)}`);
      }
    });
  }

  findStaleFormations(olderThanMs: number): Promise<string[]> {
    return this.read(async () =>
      this.redis.zrangebyscore(redisKeys.formationIndex, "-inf", Date.now() - olderThanMs),
    );
  }
}
