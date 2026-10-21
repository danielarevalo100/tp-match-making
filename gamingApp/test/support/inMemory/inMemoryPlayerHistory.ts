import type {
  ActiveSeason,
  ClosedMatch,
  ClosedMatchQuery,
  HistoryEntry,
  HistoryPlayer,
  HistoryRow,
} from "../../../src/api/modules/playerHistory/business/models/playerHistory.js";
import type {
  ClosedMatchSourcePort,
  PlayerDirectoryPort,
  PlayerHistoryStorePort,
} from "../../../src/api/modules/playerHistory/business/ports/playerHistoryPorts.js";
import { InjectedFailureError } from "../../../src/shared/errors.js";
import { requestContext } from "../../../src/shared/requestContext.js";

function failIfRequested(step: string): void {
  if (requestContext.getStore()?.failAt === step) throw new InjectedFailureError(step);
}

export class InMemoryPlayerHistoryStore implements PlayerHistoryStorePort {
  // Keyed like the Cassandra primary key, so a retry overwrites instead of duplicating.
  readonly rows = new Map<string, HistoryRow>();

  async append(rows: readonly HistoryRow[]): Promise<void> {
    failIfRequested("playerHistory.appendRows");
    for (const row of rows) {
      this.rows.set(`${row.playerId}|${String(row.endedAt.getTime())}|${row.matchId}`, row);
    }
  }

  async findLatest(playerId: string, limit: number): Promise<HistoryEntry[]> {
    failIfRequested("playerHistory.findLatest");
    return this.forPlayer(playerId).slice(0, limit);
  }

  async findSince(playerId: string, since: Date): Promise<HistoryEntry[]> {
    failIfRequested("playerHistory.findSince");
    return this.forPlayer(playerId).filter((entry) => entry.endedAt >= since);
  }

  private forPlayer(playerId: string): HistoryEntry[] {
    return [...this.rows.values()]
      .filter((row) => row.playerId === playerId)
      .sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
  }
}

export class InMemoryPlayerDirectory implements PlayerDirectoryPort {
  readonly players = new Map<string, HistoryPlayer>();
  season: ActiveSeason | null = null;

  async findPlayer(playerId: string): Promise<HistoryPlayer | null> {
    failIfRequested("playerHistory.findPlayer");
    return this.players.get(playerId) ?? null;
  }

  async findActiveSeason(): Promise<ActiveSeason | null> {
    failIfRequested("playerHistory.findActiveSeason");
    return this.season;
  }
}

export class InMemoryClosedMatchSource implements ClosedMatchSourcePort {
  readonly matches: ClosedMatch[] = [];

  async listClosedMatches(query: ClosedMatchQuery): Promise<ClosedMatch[]> {
    failIfRequested("playerHistory.listClosedMatches");
    return this.matches
      .filter(
        (match) =>
          (query.afterId === null || match.id > query.afterId) &&
          (!query.since || match.endedAt >= query.since),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, query.limit);
  }
}
