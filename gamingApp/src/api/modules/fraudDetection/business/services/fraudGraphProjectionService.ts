import type {
  ProjectionInput,
  ProjectionResult,
} from "../../../playerHistory/business/models/playerHistory.js";
import { projectClosedMatches } from "../../../playerHistory/business/services/playerHistoryProjectionService.js";
import type { FraudMatchSourcePort, MatchGraphPort } from "../ports/fraudPorts.js";

/**
 * Carga las partidas cerradas en el grafo de coparticipación (Neo4j). Mismo recorrido que la
 * proyección del historial; es idempotente porque nodos y relaciones se unen (MERGE) por id.
 */
export class FraudGraphProjectionService {
  constructor(
    private readonly source: FraudMatchSourcePort,
    private readonly graph: MatchGraphPort,
  ) {}

  project(input: ProjectionInput): Promise<ProjectionResult> {
    return projectClosedMatches(this.source, input, (page) => this.graph.upsertMatches(page));
  }
}
