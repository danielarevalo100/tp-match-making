import type {
  GameModeInfo,
  LeaderboardBoard,
  LeaderboardStanding,
  PlayerSummary,
  RankedPlayer,
  RankingSlice,
  RankingWindow,
  SeasonInfo,
} from "../../../src/api/modules/leaderboards/business/models/leaderboard.js";
import type {
  LeaderboardDirectoryPort,
  LeaderboardRankingPort,
} from "../../../src/api/modules/leaderboards/business/ports/leaderboardPorts.js";
import type { MatchLeaderboardPort } from "../../../src/api/modules/matchClosure/business/ports/matchClosurePorts.js";
import { InjectedFailureError } from "../../../src/shared/errors.js";
import { requestContext } from "../../../src/shared/requestContext.js";

function failIfRequested(step: string): void {
  if (requestContext.getStore()?.failAt === step) throw new InjectedFailureError(step);
}

type StoredStanding = { mmr: number; region: string; revision: number };

/** Same order as Redis ZREVRANGE: higher score first, equal scores by descending member. */
function compareRanked(
  [leftId, left]: [string, StoredStanding],
  [rightId, right]: [string, StoredStanding],
): number {
  if (left.mmr !== right.mmr) return right.mmr - left.mmr;
  return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
}

export class InMemoryLeaderboardRanking implements LeaderboardRankingPort, MatchLeaderboardPort {
  /** Boards by `${seasonId}|${mode}`, each with every ranked player of the season and mode. */
  readonly boards = new Map<string, Map<string, StoredStanding>>();
  publications = 0;

  async top(board: LeaderboardBoard, limit: number): Promise<RankingSlice> {
    failIfRequested("leaderboard.top");
    const ranked = this.ranked(board);
    return { entries: ranked.slice(0, limit), totalPlayers: ranked.length };
  }

  async around(
    board: LeaderboardBoard,
    playerId: string,
    radius: number,
  ): Promise<RankingWindow | null> {
    failIfRequested("leaderboard.around");
    const ranked = this.ranked(board);
    const index = ranked.findIndex((entry) => entry.playerId === playerId);
    if (index === -1) return null;
    return {
      entries: ranked.slice(Math.max(index - radius, 0), index + radius + 1),
      position: index + 1,
      totalPlayers: ranked.length,
    };
  }

  async publish(
    seasonId: string,
    mode: string,
    standings: readonly LeaderboardStanding[],
  ): Promise<void> {
    failIfRequested("leaderboard.publish");
    const board = this.board(seasonId, mode);
    for (const standing of standings) {
      const stored = board.get(standing.playerId);
      if (stored && stored.revision > standing.revision) continue;
      board.set(standing.playerId, {
        mmr: standing.mmr,
        region: standing.region,
        revision: standing.revision,
      });
    }
    this.publications += 1;
  }

  async listMembers(seasonId: string, mode: string): Promise<string[]> {
    return [...this.board(seasonId, mode).keys()];
  }

  async remove(seasonId: string, mode: string, playerIds: readonly string[]): Promise<number> {
    const board = this.board(seasonId, mode);
    return playerIds.filter((playerId) => board.delete(playerId)).length;
  }

  standing(seasonId: string, mode: string, playerId: string): StoredStanding | undefined {
    return this.board(seasonId, mode).get(playerId);
  }

  private board(seasonId: string, mode: string): Map<string, StoredStanding> {
    const key = `${seasonId}|${mode}`;
    let board = this.boards.get(key);
    if (!board) {
      board = new Map();
      this.boards.set(key, board);
    }
    return board;
  }

  private ranked(board: LeaderboardBoard): RankedPlayer[] {
    return [...this.board(board.seasonId, board.mode).entries()]
      .filter(([, standing]) => board.region === null || standing.region === board.region)
      .sort(compareRanked)
      .map(([playerId, standing], index) => ({
        mmr: standing.mmr,
        playerId,
        position: index + 1,
      }));
  }
}

type DirectoryPlayer = {
  country: string;
  standings: Map<string, LeaderboardStanding & { gamesPlayed: number }>;
  username: string;
};

export class InMemoryLeaderboardDirectory implements LeaderboardDirectoryPort {
  readonly seasons = new Map<string, SeasonInfo>([
    ["2026-S1", { id: "2026-S1", status: "closed" }],
    ["2026-S2", { id: "2026-S2", status: "active" }],
  ]);
  readonly modes = new Map<string, GameModeInfo>([
    ["ranked_1v1", { id: "ranked_1v1", ranked: true }],
    ["casual_5v5", { id: "casual_5v5", ranked: false }],
  ]);
  readonly regions = new Set(["NA", "LATAM", "EU"]);
  readonly players = new Map<string, DirectoryPlayer>();

  /** Adds a player with a standing in `${seasonId}|${mode}`. */
  addStanding(
    seasonId: string,
    mode: string,
    standing: LeaderboardStanding,
    profile: { country?: string; gamesPlayed?: number; username?: string } = {},
  ): void {
    const player = this.players.get(standing.playerId) ?? {
      country: profile.country ?? "US",
      standings: new Map(),
      username: profile.username ?? `player_${standing.playerId.slice(0, 8)}`,
    };
    player.standings.set(`${seasonId}|${mode}`, {
      ...standing,
      gamesPlayed: profile.gamesPlayed ?? 1,
    });
    this.players.set(standing.playerId, player);
  }

  async findSeason(seasonId: string): Promise<SeasonInfo | null> {
    failIfRequested("leaderboard.findSeason");
    return this.seasons.get(seasonId) ?? null;
  }

  async findMode(mode: string): Promise<GameModeInfo | null> {
    failIfRequested("leaderboard.findMode");
    return this.modes.get(mode) ?? null;
  }

  async regionExists(region: string): Promise<boolean> {
    failIfRequested("leaderboard.findRegion");
    return this.regions.has(region);
  }

  async findPlayers(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<ReadonlyMap<string, PlayerSummary>> {
    failIfRequested("leaderboard.findPlayers");
    const summaries = new Map<string, PlayerSummary>();
    for (const playerId of playerIds) {
      const player = this.players.get(playerId);
      if (!player) continue;
      const standing = player.standings.get(`${seasonId}|${mode}`);
      summaries.set(playerId, {
        country: player.country,
        gamesPlayed: standing?.gamesPlayed ?? null,
        region: standing?.region ?? null,
        username: player.username,
      });
    }
    return summaries;
  }

  async findStandings(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<LeaderboardStanding[]> {
    return playerIds.flatMap((playerId) => this.standing(playerId, seasonId, mode) ?? []);
  }

  async *listStandings(
    seasonId: string,
    mode: string,
    batchSize: number,
  ): AsyncIterable<LeaderboardStanding[]> {
    const standings = [...this.players.keys()].flatMap(
      (playerId) => this.standing(playerId, seasonId, mode) ?? [],
    );
    for (let start = 0; start < standings.length; start += batchSize) {
      yield standings.slice(start, start + batchSize);
    }
  }

  private standing(playerId: string, seasonId: string, mode: string): LeaderboardStanding | null {
    const standing = this.players.get(playerId)?.standings.get(`${seasonId}|${mode}`);
    if (!standing) return null;
    return {
      mmr: standing.mmr,
      playerId,
      region: standing.region,
      revision: standing.revision,
    };
  }
}
