import { isGameplayEvent } from "../models/matchEvent.js";
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
 * Eventos dentro de la partida (problema 3). Un evento se escribe en dos bases, en este orden:
 *   1. Cassandra  append  - log durable; clave (matchId, tsMs, eventId), un reintento pisa la misma fila
 *   2. Redis      apply   - marcador en vivo; un script Lua que saltea un eventId ya aplicado
 * El log va primero: si falla el marcador, el evento ya está a salvo y el marcador se repara
 * reintentando el mismo evento o con `reconcile`. Al revés, el marcador podría mostrar puntos que
 * ningún evento del log explica.
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
    // La partida se cerró entre el chequeo y el script: el evento está en el log pero no puntúa.
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
   * Vuelve a aplicar todos los eventos del log al marcador en vivo. Los ya aplicados se saltean,
   * así que se puede correr mientras siguen llegando eventos; completa lo que dejó un paso 2
   * fallido (o la pérdida de Redis, en cuyo caso reconstruye todo el marcador).
   */
  async reconcile(matchId: string): Promise<ReconcileResult> {
    if ((await this.scoreboard.findLiveMatch(matchId))?.status !== "in_progress") {
      throw new MatchNotLiveError(matchId);
    }

    let read = 0;
    let repaired = 0;
    let pageState: string | undefined;
    do {
      const page = await this.log.list(matchId, { limit: reconcilePageSize, pageState });
      read += page.events.length;
      const gameplayEvents = page.events.filter(isGameplayEvent);
      if (gameplayEvents.length > 0) repaired += await this.scoreboard.applyMany(gameplayEvents);
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
