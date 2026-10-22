import type {
  ApplyOutcome,
  EventPage,
  EventQuery,
  LiveMatch,
  MatchEvent,
  Scoreboard,
} from "../models/matchEvent.js";

/** Registro durable de todos los eventos, que solo crece (Cassandra). */
export interface MatchEventLogPort {
  /** Idempotente: escribir otra vez el mismo (matchId, tsMs, eventId) pisa la misma fila. */
  append(event: MatchEvent): Promise<void>;
  list(matchId: string, query: EventQuery): Promise<EventPage>;
}

/** Estado en vivo de la partida: quién juega y el puntaje parcial (Redis). */
export interface LiveScoreboardPort {
  findLiveMatch(matchId: string): Promise<LiveMatch | null>;
  /** Atómico e idempotente por `eventId`: un evento ya aplicado no cambia nada. */
  apply(event: MatchEvent): Promise<ApplyOutcome>;
  /** Igual que `apply` para muchos eventos en un solo viaje; devuelve cuántos se aplicaron ahora. */
  applyMany(events: readonly MatchEvent[]): Promise<number>;
  findScoreboard(matchId: string): Promise<Scoreboard | null>;
}
