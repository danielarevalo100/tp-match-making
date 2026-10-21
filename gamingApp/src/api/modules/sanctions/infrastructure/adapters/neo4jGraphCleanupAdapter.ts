import { BaseNeo4jAdapter } from "../../../../../infrastructure/neo4j/baseNeo4jAdapter.js";
import type { GraphCleanupPort } from "../../business/ports/sanctionPorts.js";

// DETACH DELETE removes the match and its PLAYED relationships; Player nodes stay, since players
// keep their other matches. Matching nothing (already deleted) is not an error.
const deleteMatch = `
MATCH (match:Match {id: $matchId})
DETACH DELETE match
`;

export class Neo4jGraphCleanupAdapter extends BaseNeo4jAdapter implements GraphCleanupPort {
  async deleteMatch(matchId: string): Promise<void> {
    await this.query("sanctions.deleteGraph", "write", deleteMatch, { matchId });
  }
}
