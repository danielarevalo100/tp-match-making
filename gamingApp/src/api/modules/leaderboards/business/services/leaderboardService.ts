import {
  leaderboardNeighbourCount,
  leaderboardTopSize,
  type LeaderboardBoard,
  type LeaderboardEntry,
  type LeaderboardHeader,
  type LeaderboardPosition,
  type LeaderboardRebuildResult,
  type LeaderboardTop,
  type PlayerSummary,
  type RankedPlayer,
  type SeasonInfo,
} from "../models/leaderboard.js";
import {
  LeaderboardNotFoundError,
  ModeNotRankedError,
  PlayerNotRankedError,
} from "../models/leaderboardErrors.js";
import type {
  LeaderboardDirectoryPort,
  LeaderboardRankingPort,
} from "../ports/leaderboardPorts.js";

const rebuildBatchSize = 500;

export class LeaderboardService {
  constructor(
    private readonly ranking: LeaderboardRankingPort,
    private readonly directory: LeaderboardDirectoryPort,
  ) {}

  async top(board: LeaderboardBoard): Promise<LeaderboardTop> {
    const season = await this.assertBoard(board);
    const slice = await this.ranking.top(board, leaderboardTopSize);
    const players = await this.directory.findPlayers(
      slice.entries.map((entry) => entry.playerId),
      board.seasonId,
      board.mode,
    );
    return {
      ...this.header(board, season, slice.totalPlayers),
      entries: slice.entries.map((entry) => toEntry(entry, players)),
    };
  }

  async position(board: LeaderboardBoard, playerId: string): Promise<LeaderboardPosition> {
    const season = await this.assertBoard(board);
    const window = await this.ranking.around(board, playerId, leaderboardNeighbourCount);
    if (!window) throw new PlayerNotRankedError(playerId);
    const players = await this.directory.findPlayers(
      window.entries.map((entry) => entry.playerId),
      board.seasonId,
      board.mode,
    );
    const entries = window.entries.map((entry) => toEntry(entry, players));
    const player = entries.find((entry) => entry.position === window.position);
    if (!player) throw new PlayerNotRankedError(playerId);
    return {
      ...this.header(board, season, window.totalPlayers),
      above: entries.filter((entry) => entry.position < window.position),
      below: entries.filter((entry) => entry.position > window.position),
      player,
    };
  }

  /**
   * Recovery path: republishes every standing MongoDB holds for the season and mode, then removes
   * the Redis members MongoDB no longer ranks. Publishing is revision-guarded, so it can run while
   * matches keep closing without regressing anyone.
   */
  async rebuild(seasonId: string, mode: string): Promise<LeaderboardRebuildResult> {
    await this.assertBoard({ mode, region: null, seasonId });

    const seen = new Set<string>();
    for await (const batch of this.directory.listStandings(seasonId, mode, rebuildBatchSize)) {
      await this.ranking.publish(seasonId, mode, batch);
      for (const standing of batch) seen.add(standing.playerId);
    }

    const unseen = (await this.ranking.listMembers(seasonId, mode)).filter((id) => !seen.has(id));
    // A player ranked for the first time while the scan was running is in Redis without having
    // been seen: ask MongoDB again before removing anyone.
    const rankedMeanwhile = new Set(
      (await this.directory.findStandings(unseen, seasonId, mode)).map(
        (standing) => standing.playerId,
      ),
    );
    const removed = await this.ranking.remove(
      seasonId,
      mode,
      unseen.filter((id) => !rankedMeanwhile.has(id)),
    );
    return { mode, published: seen.size, removed, seasonId };
  }

  private async assertBoard(board: LeaderboardBoard): Promise<SeasonInfo> {
    const [season, mode, regionExists] = await Promise.all([
      this.directory.findSeason(board.seasonId),
      this.directory.findMode(board.mode),
      board.region === null ? true : this.directory.regionExists(board.region),
    ]);
    if (!season) throw new LeaderboardNotFoundError("season", board.seasonId);
    if (!mode) throw new LeaderboardNotFoundError("mode", board.mode);
    if (!mode.ranked) throw new ModeNotRankedError(board.mode);
    if (!regionExists) throw new LeaderboardNotFoundError("region", board.region ?? "");
    return season;
  }

  private header(
    board: LeaderboardBoard,
    season: SeasonInfo,
    totalPlayers: number,
  ): LeaderboardHeader {
    return {
      mode: board.mode,
      region: board.region,
      scope: board.region === null ? "global" : "regional",
      seasonId: board.seasonId,
      seasonStatus: season.status,
      totalPlayers,
    };
  }
}

function toEntry(
  entry: RankedPlayer,
  players: ReadonlyMap<string, PlayerSummary>,
): LeaderboardEntry {
  const player = players.get(entry.playerId);
  return {
    country: player?.country ?? null,
    gamesPlayed: player?.gamesPlayed ?? null,
    mmr: entry.mmr,
    playerId: entry.playerId,
    position: entry.position,
    region: player?.region ?? null,
    username: player?.username ?? null,
  };
}
