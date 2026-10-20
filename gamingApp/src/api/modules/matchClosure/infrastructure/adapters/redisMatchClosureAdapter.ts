import { BaseRedisAdapter } from "../../../../../infrastructure/redis/baseRedisAdapter.js";
import { redisKeys } from "../../../../../shared/storageKeys.js";
import type {
  RedisClosingOutcome,
  RedisReleaseOutcome,
} from "../../business/models/matchClosure.js";
import { MatchClosureConflictError } from "../../business/models/matchClosureErrors.js";
import type { LiveMatchClosurePort } from "../../business/ports/matchClosurePorts.js";
import {
  beginClosingScript,
  releaseMatchScript,
  rollbackClosingScript,
} from "../scripts/matchClosureScripts.js";

const releaseMarkerTtlSeconds = 86_400;

export class RedisMatchClosureAdapter extends BaseRedisAdapter implements LiveMatchClosurePort {
  async beginClosing(matchId: string, closureId: string): Promise<RedisClosingOutcome> {
    const reply = await this.run("matchClosure.beginClosing", async () =>
      String(
        await this.redis.eval(
          beginClosingScript,
          2,
          redisKeys.match(matchId),
          redisKeys.matchClosure(matchId),
          closureId,
        ),
      ),
    );
    if (reply === "CLOSING") return "closing";
    if (reply === "REPLAYED") return "replayed";
    if (reply === "RELEASED") return "released";
    if (reply === "NOT_LIVE") throw new MatchClosureConflictError(matchId, "not_live");
    if (reply.startsWith("CONFLICT|")) {
      throw new MatchClosureConflictError(matchId, reply.slice("CONFLICT|".length));
    }
    throw new Error(`Unexpected begin-closing reply: ${reply}`);
  }

  rollbackClosing(matchId: string, closureId: string): Promise<void> {
    return this.run("matchClosure.rollbackClosing", async () => {
      await this.redis.eval(rollbackClosingScript, 1, redisKeys.match(matchId), closureId);
    });
  }

  async release(
    matchId: string,
    closureId: string,
    playerIds: readonly string[],
  ): Promise<RedisReleaseOutcome> {
    const reply = await this.run("matchClosure.releasePlayers", async () =>
      String(
        await this.redis.eval(
          releaseMatchScript,
          4 + playerIds.length,
          redisKeys.match(matchId),
          redisKeys.matchScoreboard(matchId),
          redisKeys.matchAppliedEvents(matchId),
          redisKeys.matchClosure(matchId),
          ...playerIds.map(redisKeys.activeMatch),
          closureId,
          matchId,
          String(Date.now()),
          String(releaseMarkerTtlSeconds),
          ...playerIds,
        ),
      ),
    );
    if (reply === "RELEASED") return "released";
    if (reply === "ALREADY_RELEASED") return "already_released";
    if (reply === "NOT_LIVE") throw new MatchClosureConflictError(matchId, "not_live");
    if (reply.startsWith("CONFLICT|")) {
      throw new MatchClosureConflictError(matchId, reply.slice("CONFLICT|".length));
    }
    throw new Error(`Unexpected release reply: ${reply}`);
  }
}
