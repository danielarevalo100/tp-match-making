import type {
  ClosedMatch,
  HistoryRow,
  ProjectionInput,
  ProjectionResult,
} from "../models/playerHistory.js";
import type { ClosedMatchSourcePort, PlayerHistoryStorePort } from "../ports/playerHistoryPorts.js";

const pageSize = 500;

export function toHistoryRows(match: ClosedMatch): HistoryRow[] {
  return match.players.map((player) => ({
    deaths: player.deaths,
    endedAt: match.endedAt,
    kills: player.kills,
    matchId: match.id,
    mmrAfter: player.mmrAfter,
    mmrBefore: player.mmrBefore,
    mode: match.mode,
    objectives: player.objectives,
    playerId: player.playerId,
    ratingDelta: player.ratingDelta,
    region: match.region,
    result: player.result,
    score: player.score,
  }));
}

/**
 * Recorre las partidas cerradas de MongoDB en páginas (en orden de `_id`) y le pasa cada página a
 * `write`. Lo usan las dos proyecciones, la del historial (Cassandra) y la del grafo (Neo4j): las
 * dos son idempotentes, así se pueden repetir, y `nextCursor` es el punto desde donde reanudar.
 * `rows` cuenta un jugador por partida (una fila del historial o una relación del grafo).
 */
export async function projectClosedMatches(
  source: ClosedMatchSourcePort,
  input: ProjectionInput,
  write: (page: readonly ClosedMatch[]) => Promise<void>,
): Promise<ProjectionResult> {
  let cursor = input.afterId;
  let matches = 0;
  let rows = 0;

  while (matches < input.limit) {
    const requested = Math.min(pageSize, input.limit - matches);
    const page = await source.listClosedMatches({
      afterId: cursor,
      limit: requested,
      since: input.since,
    });
    if (page.length > 0) await write(page);

    matches += page.length;
    rows += page.reduce((sum, match) => sum + match.players.length, 0);
    cursor = page.at(-1)?.id ?? cursor;
    if (page.length < requested) return { matches, nextCursor: null, rows };
  }
  return { matches, nextCursor: cursor, rows };
}

/**
 * Pasa las partidas cerradas al historial de jugadores. MongoDB guarda la partida cerrada
 * (problema 4); las filas del historial se escriben una por jugador en Cassandra, y una fila se
 * identifica por (playerId, endedAt, matchId), así repetir una página pisa las mismas filas.
 */
export class PlayerHistoryProjectionService {
  constructor(
    private readonly source: ClosedMatchSourcePort,
    private readonly history: PlayerHistoryStorePort,
  ) {}

  project(input: ProjectionInput): Promise<ProjectionResult> {
    return projectClosedMatches(this.source, input, async (page) => {
      const rows = page.flatMap(toHistoryRows);
      if (rows.length > 0) await this.history.append(rows);
    });
  }
}
