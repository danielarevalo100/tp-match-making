import type {
  ApplyOutcome,
  EventPage,
  EventQuery,
  LiveMatch,
  MatchEvent,
  Scoreboard,
} from "../../../src/api/modules/matchEvents/business/models/matchEvent.js";
import type {
  LiveScoreboardPort,
  MatchEventLogPort,
} from "../../../src/api/modules/matchEvents/business/ports/matchEventPorts.js";
import { toScoreboard } from "../../../src/api/modules/matchEvents/infrastructure/mappers/scoreboardMapper.js";
import { failIfRequested } from "../../../src/shared/requestContext.js";

export class InMemoryEventLog implements MatchEventLogPort {
  // Con la misma clave que la primaria de Cassandra, así un reintento pisa en lugar de duplicar.
  readonly rows = new Map<string, MatchEvent>();

  async append(event: MatchEvent): Promise<void> {
    failIfRequested("cassandra");
    this.rows.set(`${event.matchId}|${String(event.tsMs)}|${event.eventId}`, event);
  }

  async list(matchId: string, query: EventQuery): Promise<EventPage> {
    const sorted = [...this.rows.values()]
      .filter(
        (event) =>
          event.matchId === matchId &&
          event.tsMs >= (query.fromTsMs ?? 0) &&
          event.tsMs <= (query.toTsMs ?? Number.MAX_SAFE_INTEGER),
      )
      .sort((a, b) => a.tsMs - b.tsMs || a.eventId.localeCompare(b.eventId));
    const start = query.pageState ? Number(query.pageState) : 0;
    const events = sorted.slice(start, start + query.limit);
    const next = start + events.length;
    return { events, nextPageState: next < sorted.length ? String(next) : null };
  }
}

/** Replica `applyEventScript`: si cambia el script Lua, cambiar esto también. */
export class InMemoryLiveScoreboard implements LiveScoreboardPort {
  readonly applied = new Map<string, Set<string>>();
  readonly boards = new Map<string, Record<string, string>>();
  readonly liveMatches = new Map<string, LiveMatch>();

  addLiveMatch(matchId: string, players: readonly string[]): void {
    this.liveMatches.set(matchId, {
      matchId,
      mode: "ranked_1v1",
      players,
      region: "NA",
      startedAt: 1_000,
      status: "in_progress",
    });
  }

  async findLiveMatch(matchId: string): Promise<LiveMatch | null> {
    return this.liveMatches.get(matchId) ?? null;
  }

  async apply(event: MatchEvent): Promise<ApplyOutcome> {
    failIfRequested("redis");
    return this.applyOne(event);
  }

  async applyMany(events: readonly MatchEvent[]): Promise<number> {
    failIfRequested("redis");
    return events.filter((event) => this.applyOne(event) === "applied").length;
  }

  async findScoreboard(matchId: string): Promise<Scoreboard | null> {
    const live = this.liveMatches.get(matchId);
    return live ? toScoreboard(live, this.boards.get(matchId) ?? {}) : null;
  }

  private applyOne(event: MatchEvent): ApplyOutcome {
    if (this.liveMatches.get(event.matchId)?.status !== "in_progress") return "not_live";
    const seen = this.applied.get(event.matchId) ?? new Set<string>();
    this.applied.set(event.matchId, seen);
    if (seen.has(event.eventId)) return "duplicate";
    seen.add(event.eventId);

    const board = this.boards.get(event.matchId) ?? {};
    this.boards.set(event.matchId, board);
    const add = (field: string, delta: number): void => {
      board[field] = String(Number(board[field] ?? 0) + delta);
    };

    add("events", 1);
    if (event.tsMs > Number(board["lastEventTs"] ?? 0)) board["lastEventTs"] = String(event.tsMs);

    if (event.type === "kill") {
      add(`${event.playerId}:kills`, 1);
      add(`${event.playerId}:score`, event.points);
      if (event.targetPlayerId) add(`${event.targetPlayerId}:deaths`, 1);
    } else if (event.type === "objective") {
      add(`${event.playerId}:objectives`, 1);
      add(`${event.playerId}:score`, event.points);
    } else {
      const seenTs = Number(board[`${event.playerId}:connectionTs`] ?? 0);
      if (event.tsMs > seenTs || (event.tsMs === seenTs && event.type === "disconnect")) {
        board[`${event.playerId}:connectionTs`] = String(event.tsMs);
        board[`${event.playerId}:connected`] = event.type === "reconnect" ? "1" : "0";
      }
    }
    return "applied";
  }
}
