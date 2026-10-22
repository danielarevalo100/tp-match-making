import { BaseNeo4jAdapter } from "../../../../../infrastructure/neo4j/baseNeo4jAdapter.js";
import type { GraphCleanupPort } from "../../business/ports/sanctionPorts.js";

// DETACH DELETE borra la partida y sus relaciones PLAYED; los nodos Player quedan, porque los
// jugadores conservan sus otras partidas. Que no matchee nada (ya borrada) no es un error.
const deleteMatch = `
MATCH (match:Match {id: $matchId})
DETACH DELETE match
`;

export class Neo4jGraphCleanupAdapter extends BaseNeo4jAdapter implements GraphCleanupPort {
  async deleteMatch(matchId: string): Promise<void> {
    await this.query("write", deleteMatch, { matchId });
  }
}
