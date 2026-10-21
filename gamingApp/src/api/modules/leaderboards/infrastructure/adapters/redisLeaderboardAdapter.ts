import { BaseRedisAdapter } from "../../../../../infrastructure/redis/baseRedisAdapter.js";
import { redisKeys } from "../../../../../shared/storageKeys.js";
import type { MatchLeaderboardPort } from "../../../matchClosure/business/ports/matchClosurePorts.js";
import type {
  LeaderboardBoard,
  LeaderboardStanding,
  RankedPlayer,
  RankingSlice,
  RankingWindow,
} from "../../business/models/leaderboard.js";
import type { LeaderboardRankingPort } from "../../business/ports/leaderboardPorts.js";
import {
  aroundScript,
  publishScript,
  removeScript,
  topScript,
} from "../scripts/leaderboardScripts.js";

// Bounds the arguments of a single script call; each call is still atomic on its own.
const writeBatchSize = 500;

function boardKey(board: LeaderboardBoard): string {
  return board.region === null
    ? redisKeys.leaderboardGlobal(board.seasonId, board.mode)
    : redisKeys.leaderboardRegional(board.seasonId, board.mode, board.region);
}

/** Turns a WITHSCORES reply into ranked players; `firstRank` is the 0-based rank of the first. */
function toRankedPlayers(rows: readonly string[], firstRank: number): RankedPlayer[] {
  const players: RankedPlayer[] = [];
  for (let index = 0; index + 1 < rows.length; index += 2) {
    players.push({
      mmr: Number(rows[index + 1]),
      playerId: rows[index] as string,
      position: firstRank + index / 2 + 1,
    });
  }
  return players;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

export class RedisLeaderboardAdapter
  extends BaseRedisAdapter
  implements LeaderboardRankingPort, MatchLeaderboardPort
{
  top(board: LeaderboardBoard, limit: number): Promise<RankingSlice> {
    return this.run("leaderboard.top", async () => {
      const [total, rows] = (await this.redis.eval(
        topScript,
        1,
        boardKey(board),
        String(limit),
      )) as [number, string[]];
      return { entries: toRankedPlayers(rows, 0), totalPlayers: total };
    });
  }

  around(board: LeaderboardBoard, playerId: string, radius: number): Promise<RankingWindow | null> {
    return this.run("leaderboard.around", async () => {
      const reply = (await this.redis.eval(
        aroundScript,
        1,
        boardKey(board),
        playerId,
        String(radius),
      )) as [number, number, number, string[]] | null;
      if (!reply) return null;
      const [rank, first, total, rows] = reply;
      return { entries: toRankedPlayers(rows, first), position: rank + 1, totalPlayers: total };
    });
  }

  publish(
    seasonId: string,
    mode: string,
    standings: readonly LeaderboardStanding[],
  ): Promise<void> {
    return this.run("leaderboard.publish", async () => {
      for (const batch of chunks(standings, writeBatchSize)) {
        await this.redis.eval(
          publishScript,
          2,
          redisKeys.leaderboardGlobal(seasonId, mode),
          redisKeys.leaderboardMembers(seasonId, mode),
          redisKeys.leaderboardRegionPrefix(seasonId, mode),
          ...batch.flatMap((standing) => [
            standing.playerId,
            String(standing.mmr),
            standing.region,
            String(standing.revision),
          ]),
        );
      }
    });
  }

  listMembers(seasonId: string, mode: string): Promise<string[]> {
    return this.run("leaderboard.listMembers", async () => {
      const members: string[] = [];
      let cursor = "0";
      do {
        const [next, fields] = await this.redis.hscan(
          redisKeys.leaderboardMembers(seasonId, mode),
          cursor,
          "COUNT",
          1_000,
        );
        for (let index = 0; index < fields.length; index += 2) {
          members.push(fields[index] as string);
        }
        cursor = next;
      } while (cursor !== "0");
      return members;
    });
  }

  remove(seasonId: string, mode: string, playerIds: readonly string[]): Promise<number> {
    return this.run("leaderboard.remove", async () => {
      let removed = 0;
      for (const batch of chunks(playerIds, writeBatchSize)) {
        removed += Number(
          await this.redis.eval(
            removeScript,
            2,
            redisKeys.leaderboardGlobal(seasonId, mode),
            redisKeys.leaderboardMembers(seasonId, mode),
            redisKeys.leaderboardRegionPrefix(seasonId, mode),
            ...batch,
          ),
        );
      }
      return removed;
    });
  }
}
