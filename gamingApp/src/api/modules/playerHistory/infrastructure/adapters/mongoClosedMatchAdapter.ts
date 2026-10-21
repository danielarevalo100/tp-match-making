import type { Collection, Db, Filter } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type { PlayerFinalScore } from "../../../matchClosure/business/models/matchClosure.js";
import type { ClosedMatch, ClosedMatchQuery } from "../../business/models/playerHistory.js";
import type { ClosedMatchSourcePort } from "../../business/ports/playerHistoryPorts.js";

type ClosedMatchDocument = {
  _id: string;
  closure?: { tsMs: number };
  finalScoreboard?: PlayerFinalScore[];
  mode: string;
  region: string;
  scoringStatus?: string;
  status: string;
};

export class MongoClosedMatchAdapter extends BaseMongoAdapter implements ClosedMatchSourcePort {
  private readonly matches: Collection<ClosedMatchDocument>;

  constructor(database: Db) {
    super(database);
    this.matches = database.collection<ClosedMatchDocument>(mongoCollections.matches);
  }

  // Only matches whose scoring is applied have a final scoreboard worth keeping in the history.
  listClosedMatches(query: ClosedMatchQuery): Promise<ClosedMatch[]> {
    return this.run("playerHistory.listClosedMatches", async () => {
      const filter: Filter<ClosedMatchDocument> = {
        "closure.tsMs": query.since ? { $gte: query.since.getTime() } : { $exists: true },
        finalScoreboard: { $exists: true },
        scoringStatus: "applied",
        status: "closed",
        ...(query.afterId ? { _id: { $gt: query.afterId } } : {}),
      };
      const documents = await this.matches
        .find(filter)
        .sort({ _id: 1 })
        .limit(query.limit)
        .toArray();
      return documents.map((document) => ({
        endedAt: new Date(document.closure?.tsMs ?? 0),
        id: document._id,
        mode: document.mode,
        players: document.finalScoreboard ?? [],
        region: document.region,
      }));
    });
  }
}
