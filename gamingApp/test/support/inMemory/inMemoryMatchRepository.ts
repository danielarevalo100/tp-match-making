import type { MatchRecord } from "../../../src/api/modules/matchmaking/business/models/matchFormation.js";
import type { MatchRepositoryPort } from "../../../src/api/modules/matchmaking/business/ports/matchmakingPorts.js";
import { failIfRequested } from "../../../src/shared/requestContext.js";

export class InMemoryMatchRepository implements MatchRepositoryPort {
  readonly matches = new Map<string, MatchRecord>();

  async create(match: MatchRecord): Promise<void> {
    failIfRequested("mongo");
    if (!this.matches.has(match.id)) this.matches.set(match.id, match);
  }

  async delete(matchId: string): Promise<void> {
    failIfRequested("mongo");
    this.matches.delete(matchId);
  }
}
