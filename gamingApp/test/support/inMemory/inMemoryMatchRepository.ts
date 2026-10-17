import type { MatchRecord } from "../../../src/api/modules/matchmaking/business/models/matchFormation.js";
import type { MatchRepositoryPort } from "../../../src/api/modules/matchmaking/business/ports/matchmakingPorts.js";
import { InjectedFailureError } from "../../../src/shared/errors.js";
import { requestContext } from "../../../src/shared/requestContext.js";

export class InMemoryMatchRepository implements MatchRepositoryPort {
  readonly matches = new Map<string, MatchRecord>();

  async create(match: MatchRecord): Promise<void> {
    if (requestContext.getStore()?.failAt === "matchmaking.createMatch") {
      throw new InjectedFailureError("matchmaking.createMatch");
    }
    if (!this.matches.has(match.id)) this.matches.set(match.id, match);
  }

  async delete(matchId: string): Promise<void> {
    this.matches.delete(matchId);
  }
}
