import { BaseRedisAdapter } from "../../../../../infrastructure/redis/baseRedisAdapter.js";
import { redisKeys } from "../../../../../shared/storageKeys.js";
import type {
  ApplyOutcome,
  LiveMatch,
  MatchEvent,
  Scoreboard,
} from "../../business/models/matchEvent.js";
import type { LiveScoreboardPort } from "../../business/ports/matchEventPorts.js";
import { toLiveMatch, toScoreboard } from "../mappers/scoreboardMapper.js";
import { applyEventScript } from "../scripts/matchEventScripts.js";

const outcomes: Record<string, ApplyOutcome> = {
  APPLIED: "applied",
  DUPLICATE: "duplicate",
  NOT_LIVE: "not_live",
};

function scriptArguments(event: MatchEvent): [number, ...string[]] {
  return [
    3,
    redisKeys.matchAppliedEvents(event.matchId),
    redisKeys.matchScoreboard(event.matchId),
    redisKeys.match(event.matchId),
    event.eventId,
    event.type,
    event.playerId,
    event.targetPlayerId ?? "",
    String(event.points),
    String(event.tsMs),
  ];
}

function toOutcome(reply: unknown): ApplyOutcome {
  const outcome = typeof reply === "string" ? outcomes[reply] : undefined;
  if (!outcome) throw new Error(`Unexpected apply reply: ${String(reply)}`);
  return outcome;
}

export class RedisScoreboardAdapter extends BaseRedisAdapter implements LiveScoreboardPort {
  findLiveMatch(matchId: string): Promise<LiveMatch | null> {
    return this.read(async () => toLiveMatch(await this.redis.hgetall(redisKeys.match(matchId))));
  }

  apply(event: MatchEvent): Promise<ApplyOutcome> {
    return this.write(async () => {
      const [keyCount, ...args] = scriptArguments(event);
      return toOutcome(await this.redis.eval(applyEventScript, keyCount, ...args));
    });
  }

  applyMany(events: readonly MatchEvent[]): Promise<number> {
    return this.write(async () => {
      const pipeline = this.redis.pipeline();
      for (const event of events) {
        const [keyCount, ...args] = scriptArguments(event);
        pipeline.eval(applyEventScript, keyCount, ...args);
      }
      const replies = (await pipeline.exec()) ?? [];
      return replies.filter(([error, reply]) => {
        if (error) throw error;
        return toOutcome(reply) === "applied";
      }).length;
    });
  }

  findScoreboard(matchId: string): Promise<Scoreboard | null> {
    return this.read(async () => {
      const replies =
        (await this.redis
          .pipeline()
          .hgetall(redisKeys.match(matchId))
          .hgetall(redisKeys.matchScoreboard(matchId))
          .exec()) ?? [];
      const [match, board] = replies.map(([error, fields]) => {
        if (error) throw error;
        return fields as Record<string, string>;
      });
      const live = toLiveMatch(match ?? {});
      return live ? toScoreboard(live, board ?? {}) : null;
    });
  }
}
