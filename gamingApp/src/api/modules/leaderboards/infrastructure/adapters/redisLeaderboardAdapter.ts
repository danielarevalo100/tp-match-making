import { BaseRedisAdapter } from "../../../../../infrastructure/redis/baseRedisAdapter.js";
import { redisKeys } from "../../../../../shared/storageKeys.js";
import type { MatchLeaderboardPort } from "../../../matchClosure/business/ports/matchClosurePorts.js";
import type { HeldStanding } from "../../../sanctions/business/models/sanction.js";
import type { ReversalLeaderboardPort } from "../../../sanctions/business/ports/sanctionPorts.js";
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
  holdScript,
  publishScript,
  releaseScript,
  removeScript,
  topScript,
} from "../scripts/leaderboardScripts.js";

// Acota los argumentos de una llamada al script; cada llamada sigue siendo atómica.
const writeBatchSize = 500;

function boardKey(board: LeaderboardBoard): string {
  return board.region === null
    ? redisKeys.leaderboardGlobal(board.seasonId, board.mode)
    : redisKeys.leaderboardRegional(board.seasonId, board.mode, board.region);
}

/** Convierte una respuesta WITHSCORES en jugadores rankeados; `firstRank` es el rank (desde 0) del primero. */
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

/** Qué hace el script de release con un jugador retenido (ver `releaseScript`). */
function releaseAction(entry: HeldStanding): "publish" | "release" | "remove" {
  if (!entry.standing) return "release";
  return entry.standing.gamesPlayed > 0 ? "publish" : "remove";
}

export class RedisLeaderboardAdapter
  extends BaseRedisAdapter
  implements LeaderboardRankingPort, MatchLeaderboardPort, ReversalLeaderboardPort
{
  top(board: LeaderboardBoard, limit: number): Promise<RankingSlice> {
    return this.read(async () => {
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
    return this.read(async () => {
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
    return this.write(async () => {
      for (const batch of chunks(standings, writeBatchSize)) {
        await this.redis.eval(
          publishScript,
          3,
          redisKeys.leaderboardGlobal(seasonId, mode),
          redisKeys.leaderboardMembers(seasonId, mode),
          redisKeys.leaderboardHeld(seasonId, mode),
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
    return this.read(async () => {
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
    return this.write(async () => {
      let removed = 0;
      for (const batch of chunks(playerIds, writeBatchSize)) {
        removed += Number(
          await this.redis.eval(
            removeScript,
            3,
            redisKeys.leaderboardGlobal(seasonId, mode),
            redisKeys.leaderboardMembers(seasonId, mode),
            redisKeys.leaderboardHeld(seasonId, mode),
            redisKeys.leaderboardRegionPrefix(seasonId, mode),
            ...batch,
          ),
        );
      }
      return removed;
    });
  }

  /** Problema 8: desde ahora las publicaciones saltean a estos jugadores hasta `release` (idempotente). */
  hold(
    seasonId: string,
    mode: string,
    holdId: string,
    playerIds: readonly string[],
  ): Promise<void> {
    return this.write(async () => {
      if (playerIds.length === 0) return;
      await this.redis.eval(
        holdScript,
        2,
        redisKeys.leaderboardHolds(seasonId, mode),
        redisKeys.leaderboardHeld(seasonId, mode),
        holdId,
        ...playerIds,
      );
    });
  }

  /**
   * Problema 8: quita la retención y escribe el standing actual de cada jugador retenido. Una
   * sola llamada al script por tablero, nunca en lotes, así un lector no ve media reversión.
   */
  release(
    seasonId: string,
    mode: string,
    holdId: string,
    entries: readonly HeldStanding[],
  ): Promise<void> {
    return this.write(async () => {
      if (entries.length === 0) return;
      await this.redis.eval(
        releaseScript,
        4,
        redisKeys.leaderboardGlobal(seasonId, mode),
        redisKeys.leaderboardMembers(seasonId, mode),
        redisKeys.leaderboardHolds(seasonId, mode),
        redisKeys.leaderboardHeld(seasonId, mode),
        redisKeys.leaderboardRegionPrefix(seasonId, mode),
        holdId,
        ...entries.flatMap((entry) => [
          entry.playerId,
          String(entry.standing?.mmr ?? 0),
          entry.standing?.region ?? "",
          String(entry.standing?.revision ?? 0),
          releaseAction(entry),
        ]),
      );
    });
  }
}
