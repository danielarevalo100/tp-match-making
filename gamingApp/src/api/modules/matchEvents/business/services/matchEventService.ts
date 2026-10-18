import type {
  EventPage,
  EventQuery,
  MatchEvent,
  MatchEventType,
  ReconcileResult,
  RecordResult,
  Scoreboard,
} from "../models/matchEvent.js";
import { MatchNotLiveError, PlayerNotInMatchError } from "../models/matchEventErrors.js";
import type { LiveScoreboardPort, MatchEventLogPort } from "../ports/matchEventPorts.js";

export const killPoints = 1;
const reconcilePageSize = 500;

export type RecordEventInput = {
  detail?: Record<string, unknown>;
  eventId: string;
  matchId: string;
  playerId: string;
  points?: number;
  targetPlayerId?: string;
  tsMs: number;
  type: MatchEventType;
};

/**
 * In-match events (problem 3). One event is written to two engines, in this order:
 *   1. Cassandra  append  - durable log; keyed by (matchId, tsMs, eventId), so retries overwrite
 *   2. Redis      apply   - live scoreboard; one Lua script that skips an eventId already applied
 * The log goes first: if the scoreboard step fails the event is already safe and the scoreboard
 * can be repaired by retrying the same event or by `reconcile`. The other way round, the
 * scoreboard could show points that no event in the log explains.
 */
export class MatchEventService {
  constructor(
    private readonly log: MatchEventLogPort,
    private readonly scoreboard: LiveScoreboardPort,
  ) {}

  async record(input: RecordEventInput): Promise<RecordResult> {
    const match = await this.scoreboard.findLiveMatch(input.matchId);
    if (match?.status !== "in_progress") throw new MatchNotLiveError(input.matchId);
    for (const playerId of [input.playerId, input.targetPlayerId]) {
      if (playerId !== undefined && !match.players.includes(playerId)) {
        throw new PlayerNotInMatchError(input.matchId, playerId);
      }
    }

    const event: MatchEvent = {
      detail: input.detail ?? null,
      eventId: input.eventId,
      matchId: input.matchId,
      playerId: input.playerId,
      points: pointsFor(input),
      targetPlayerId: input.targetPlayerId ?? null,
      tsMs: input.tsMs,
      type: input.type,
    };

    await this.log.append(event);
    const outcome = await this.scoreboard.apply(event);
    // The match closed between the check and the script: the event is in the log but not scored.
    if (outcome === "not_live") throw new MatchNotLiveError(input.matchId);
    return { eventId: event.eventId, status: outcome === "applied" ? "recorded" : "duplicate" };
  }

  listEvents(matchId: string, query: EventQuery): Promise<EventPage> {
    return this.log.list(matchId, query);
  }

  async getScoreboard(matchId: string): Promise<Scoreboard> {
    const scoreboard = await this.scoreboard.findScoreboard(matchId);
    if (!scoreboard) throw new MatchNotLiveError(matchId);
    return scoreboard;
  }

  /**
   * Re-applies every event of the log to the live scoreboard. Events already applied are skipped,
   * so it is safe to run while events keep arriving; it fills the gaps left by a failed step 2
   * (or by losing Redis, in which case it rebuilds the whole scoreboard).
   */
  async reconcile(matchId: string): Promise<ReconcileResult> {
    if ((await this.scoreboard.findLiveMatch(matchId))?.status !== "in_progress") {
      throw new MatchNotLiveError(matchId);
    }

    let read = 0;
    let repaired = 0;
    let pageState: string | undefined;
    do {
      const page = await this.log.list(matchId, {
        limit: reconcilePageSize,
        ...(pageState ? { pageState } : {}),
      });
      read += page.events.length;
      if (page.events.length > 0) repaired += await this.scoreboard.applyMany(page.events);
      pageState = page.nextPageState ?? undefined;
    } while (pageState);

    return { read, repaired };
  }
}

function pointsFor(input: RecordEventInput): number {
  switch (input.type) {
    case "kill":
      return killPoints;
    case "objective":
      return input.points ?? 1;
    default:
      return 0;
  }
}
