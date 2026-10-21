import { PlayerNotFoundError } from "../../../players/business/models/playerErrors.js";
import type { HistoryEntry, PeriodWindow, PlayerHistoryView } from "../models/playerHistory.js";
import type { PlayerDirectoryPort, PlayerHistoryStorePort } from "../ports/playerHistoryPorts.js";
import { summarizePeriod } from "./periodStats.js";

export const historyLimit = 50;
const dayMs = 86_400_000;

/**
 * Player history and statistics (problem 6), read-only. Reads, in this order:
 *   1. MongoDB   the player exists, and which season is active (catalog)
 *   2. Cassandra the last 50 matches, and every match since the earliest period start
 * Both Cassandra reads are slices of one partition (`player_id`), so they do not depend on how
 * many matches the platform has. The periods are rolling: week = last 7 days, month = last 30
 * days, season = from the start of the active season until now.
 */
export class PlayerHistoryService {
  constructor(
    private readonly directory: PlayerDirectoryPort,
    private readonly history: PlayerHistoryStorePort,
  ) {}

  async getHistory(playerId: string, now: Date = new Date()): Promise<PlayerHistoryView> {
    const player = await this.directory.findPlayer(playerId);
    if (!player) throw new PlayerNotFoundError(playerId);
    const season = await this.directory.findActiveSeason();

    const week: PeriodWindow = { from: new Date(now.getTime() - 7 * dayMs), to: now };
    const month: PeriodWindow = { from: new Date(now.getTime() - 30 * dayMs), to: now };
    const seasonWindow: PeriodWindow | null =
      season && season.startsAt <= now
        ? { from: season.startsAt, to: season.endsAt < now ? season.endsAt : now }
        : null;

    const earliest = [week.from, month.from, seasonWindow?.from ?? month.from].reduce((a, b) =>
      a < b ? a : b,
    );
    const [matches, sinceEarliest]: [HistoryEntry[], HistoryEntry[]] = await Promise.all([
      this.history.findLatest(playerId, historyLimit),
      this.history.findSince(playerId, earliest),
    ]);

    return {
      matches,
      player,
      stats: {
        month: summarizePeriod(sinceEarliest, month),
        season:
          season && seasonWindow
            ? { ...summarizePeriod(sinceEarliest, seasonWindow), seasonId: season.id }
            : null,
        week: summarizePeriod(sinceEarliest, week),
      },
    };
  }
}
