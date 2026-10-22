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
 * Pasa las partidas cerradas al historial de jugadores. MongoDB guarda la partida cerrada
 * (problema 4); las filas del historial se escriben una por jugador en Cassandra. Se puede correr
 * otra vez: una fila se identifica por (playerId, endedAt, matchId), así repetir una página pisa
 * las mismas filas. `nextCursor` es el punto desde donde reanudar.
 */
export class PlayerHistoryProjectionService {
  constructor(
    private readonly source: ClosedMatchSourcePort,
    private readonly history: PlayerHistoryStorePort,
  ) {}

  async project(input: ProjectionInput): Promise<ProjectionResult> {
    let cursor = input.afterId;
    let matches = 0;
    let rows = 0;

    while (matches < input.limit) {
      const requested = Math.min(pageSize, input.limit - matches);
      const page = await this.source.listClosedMatches({
        afterId: cursor,
        limit: requested,
        since: input.since,
      });
      const pageRows = page.flatMap(toHistoryRows);
      if (pageRows.length > 0) await this.history.append(pageRows);

      matches += page.length;
      rows += pageRows.length;
      cursor = page.at(-1)?.id ?? cursor;
      if (page.length < requested) return { matches, nextCursor: null, rows };
    }
    return { matches, nextCursor: cursor, rows };
  }
}
