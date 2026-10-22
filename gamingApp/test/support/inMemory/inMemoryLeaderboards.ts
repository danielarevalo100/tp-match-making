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
import type { HeldStanding } from "../../../src/api/modules/sanctions/business/models/sanction.js";
import type { ReversalLeaderboardPort } from "../../../src/api/modules/sanctions/business/ports/sanctionPorts.js";
import { failIfRequested } from "../../../src/shared/requestContext.js";

type StoredStanding = { mmr: number; region: string; revision: number };

/** Mismo orden que ZREVRANGE de Redis: primero el puntaje más alto, a igual puntaje por miembro descendente. */
function compareRanked(
  [leftId, left]: [string, StoredStanding],
  [rightId, right]: [string, StoredStanding],
): number {
  if (left.mmr !== right.mmr) return right.mmr - left.mmr;
  return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
}

export class InMemoryLeaderboardRanking
  implements LeaderboardRankingPort, MatchLeaderboardPort, ReversalLeaderboardPort
{
  /** Tableros por `${seasonId}|${mode}`, cada uno con todos los jugadores rankeados de la temporada y modo. */
  readonly boards = new Map<string, Map<string, StoredStanding>>();
  /** Problema 8, por tablero: `${holdId}|${playerId}` y cuántas retenciones tiene cada jugador. */
  readonly holds = new Map<string, Set<string>>();
  readonly held = new Map<string, Map<string, number>>();
  /** Revisión de los jugadores que sacó una reversión (la marca de Redis), por tablero. */
  readonly tombstones = new Map<string, Map<string, number>>();
  publications = 0;
  releases = 0;

  async top(board: LeaderboardBoard, limit: number): Promise<RankingSlice> {
    const ranked = this.ranked(board);
    return { entries: ranked.slice(0, limit), totalPlayers: ranked.length };
  }

  async around(
    board: LeaderboardBoard,
    playerId: string,
    radius: number,
  ): Promise<RankingWindow | null> {
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
    failIfRequested("redis");
    const key = `${seasonId}|${mode}`;
    for (const standing of standings) {
      if (this.isHeld(key, standing.playerId)) continue;
      if (this.storedRevision(key, standing.playerId) > standing.revision) continue;
      this.write(key, standing.playerId, standing);
    }
    this.publications += 1;
  }

  async listMembers(seasonId: string, mode: string): Promise<string[]> {
    return [...this.board(seasonId, mode).keys()];
  }

  async remove(seasonId: string, mode: string, playerIds: readonly string[]): Promise<number> {
    const key = `${seasonId}|${mode}`;
    const board = this.board(seasonId, mode);
    return playerIds.filter((playerId) => {
      if (this.isHeld(key, playerId)) return false;
      this.tombstones.get(key)?.delete(playerId);
      return board.delete(playerId);
    }).length;
  }

  async hold(
    seasonId: string,
    mode: string,
    holdId: string,
    playerIds: readonly string[],
  ): Promise<void> {
    failIfRequested("redis");
    const key = `${seasonId}|${mode}`;
    const holds = this.holds.get(key) ?? new Set<string>();
    const held = this.held.get(key) ?? new Map<string, number>();
    for (const playerId of playerIds) {
      const member = `${holdId}|${playerId}`;
      if (holds.has(member)) continue;
      holds.add(member);
      held.set(playerId, (held.get(playerId) ?? 0) + 1);
    }
    this.holds.set(key, holds);
    this.held.set(key, held);
  }

  async release(
    seasonId: string,
    mode: string,
    holdId: string,
    entries: readonly HeldStanding[],
  ): Promise<void> {
    failIfRequested("redis");
    const key = `${seasonId}|${mode}`;
    for (const entry of entries) {
      if (this.holds.get(key)?.delete(`${holdId}|${entry.playerId}`)) {
        const held = this.held.get(key);
        const count = (held?.get(entry.playerId) ?? 1) - 1;
        if (count <= 0) held?.delete(entry.playerId);
        else held?.set(entry.playerId, count);
      }
      const standing = entry.standing;
      if (!standing || this.isHeld(key, entry.playerId)) continue;
      if (this.storedRevision(key, entry.playerId) > standing.revision) continue;
      if (standing.gamesPlayed > 0) {
        this.write(key, entry.playerId, standing);
      } else {
        this.board(seasonId, mode).delete(entry.playerId);
        const tombstones = this.tombstones.get(key) ?? new Map<string, number>();
        tombstones.set(entry.playerId, standing.revision);
        this.tombstones.set(key, tombstones);
      }
    }
    this.releases += 1;
  }

  isHeld(boardKey: string, playerId: string): boolean {
    return (this.held.get(boardKey)?.get(playerId) ?? 0) > 0;
  }

  private storedRevision(boardKey: string, playerId: string): number {
    const [seasonId = "", mode = ""] = boardKey.split("|");
    return (
      this.board(seasonId, mode).get(playerId)?.revision ??
      this.tombstones.get(boardKey)?.get(playerId) ??
      -1
    );
  }

  private write(
    boardKey: string,
    playerId: string,
    standing: { mmr: number; region: string; revision: number },
  ): void {
    const [seasonId = "", mode = ""] = boardKey.split("|");
    this.tombstones.get(boardKey)?.delete(playerId);
    this.board(seasonId, mode).set(playerId, {
      mmr: standing.mmr,
      region: standing.region,
      revision: standing.revision,
    });
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

  /** Agrega un jugador con standing en `${seasonId}|${mode}`. */
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
    return this.seasons.get(seasonId) ?? null;
  }

  async findMode(mode: string): Promise<GameModeInfo | null> {
    return this.modes.get(mode) ?? null;
  }

  async regionExists(region: string): Promise<boolean> {
    return this.regions.has(region);
  }

  async findPlayers(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<ReadonlyMap<string, PlayerSummary>> {
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
