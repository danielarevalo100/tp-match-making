export const matchEventTypes = ["kill", "objective", "disconnect", "reconnect"] as const;
export type MatchEventType = (typeof matchEventTypes)[number];

/** Una entrada del log de la partida, que solo crece (Cassandra `events_by_match`). */
export type MatchEvent = {
  detail: Record<string, unknown> | null;
  /** Clave de idempotencia que elige quien produce el evento, para reconocer los reintentos. */
  eventId: string;
  matchId: string;
  /** Quién lo hizo: el que mató, el que tomó el objetivo, el que se (des)conectó. */
  playerId: string;
  /** Puntos que vale, fijados al registrarlo, así repetirlo da el mismo resultado. */
  points: number;
  /** Solo en kills: la víctima. */
  targetPlayerId: string | null;
  /** Cuándo pasó según quien lo produce, en milisegundos epoch. */
  tsMs: number;
  type: MatchEventType;
};

export type MatchFinishedLogEvent = {
  detail: Record<string, unknown> | null;
  eventId: string;
  matchId: string;
  playerId: null;
  points: 0;
  targetPlayerId: null;
  tsMs: number;
  type: "match_finished";
};

export type MatchLogEvent = MatchEvent | MatchFinishedLogEvent;

export function isGameplayEvent(event: MatchLogEvent): event is MatchEvent {
  return event.type !== "match_finished";
}

/** Partida en vivo publicada por el problema 2 (`match:{matchId}` en Redis). */
export type LiveMatch = {
  matchId: string;
  mode: string;
  players: readonly string[];
  region: string;
  startedAt: number;
  status: string;
};

export type PlayerScore = {
  connected: boolean;
  deaths: number;
  kills: number;
  objectives: number;
  playerId: string;
  score: number;
};

export type Scoreboard = {
  /** Eventos ya aplicados a este marcador. */
  eventCount: number;
  lastEventTsMs: number | null;
  matchId: string;
  mode: string;
  /** Ordenados por puntaje, después kills, después menos muertes. */
  players: readonly PlayerScore[];
  region: string;
  startedAt: number;
  status: string;
};

export type ApplyOutcome = "applied" | "duplicate" | "not_live";

export type RecordResult = { eventId: string; status: "recorded" | "duplicate" };

export type ReconcileResult = {
  /** Eventos encontrados en el log. */
  read: number;
  /** Eventos que le faltaban al marcador y se aplicaron ahora. */
  repaired: number;
};

export type EventQuery = {
  fromTsMs?: number;
  limit: number;
  pageState?: string;
  toTsMs?: number;
};

export type EventPage = {
  events: readonly MatchLogEvent[];
  nextPageState: string | null;
};
