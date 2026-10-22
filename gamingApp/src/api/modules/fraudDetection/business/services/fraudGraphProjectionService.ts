import type {
  ProjectionInput,
  ProjectionResult,
} from "../../../playerHistory/business/models/playerHistory.js";
import type { FraudMatchSourcePort, MatchGraphPort } from "../ports/fraudPorts.js";

const pageSize = 500;

/**
 * Carga las partidas cerradas en el grafo de coparticipación (Neo4j). Mismo contrato que la
 * proyección del historial: idempotente (nodos y relaciones se unen por id) y reanudable con
 * `nextCursor`.
 */
export class FraudGraphProjectionService {
  constructor(
    private readonly source: FraudMatchSourcePort,
    private readonly graph: MatchGraphPort,
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
      if (page.length > 0) await this.graph.upsertMatches(page);

      matches += page.length;
      rows += page.reduce((sum, match) => sum + match.players.length, 0);
      cursor = page.at(-1)?.id ?? cursor;
      if (page.length < requested) return { matches, nextCursor: null, rows };
    }
    return { matches, nextCursor: cursor, rows };
  }
}
