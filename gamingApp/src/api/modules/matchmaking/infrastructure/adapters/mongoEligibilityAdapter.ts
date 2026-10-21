import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type { FormationMode } from "../../business/models/matchFormation.js";
import type {
  EligiblePlayer,
  QueueMode,
  SanctionInForce,
} from "../../business/models/queueTicket.js";
import type { EligibilityRepositoryPort } from "../../business/ports/matchmakingPorts.js";
import {
  toEligiblePlayer,
  toFormationMode,
  toQueueMode,
  toSanctionInForce,
  type EligiblePlayerDocument,
  type GameModeDocument,
  type RegionDocument,
  type SanctionDocument,
} from "../mappers/eligibilityMapper.js";

export class MongoEligibilityAdapter extends BaseMongoAdapter implements EligibilityRepositoryPort {
  private readonly players: Collection<EligiblePlayerDocument>;
  private readonly gameModes: Collection<GameModeDocument>;
  private readonly regions: Collection<RegionDocument>;
  private readonly sanctions: Collection<SanctionDocument>;

  constructor(database: Db) {
    super(database);
    this.players = database.collection<EligiblePlayerDocument>(mongoCollections.players);
    this.gameModes = database.collection<GameModeDocument>(mongoCollections.gameModes);
    this.regions = database.collection<RegionDocument>(mongoCollections.regions);
    this.sanctions = database.collection<SanctionDocument>(mongoCollections.sanctions);
  }

  findPlayer(playerId: string): Promise<EligiblePlayer | null> {
    return this.run("matchmaking.findPlayer", async () => {
      const player = await this.players.findOne(
        { _id: playerId },
        { projection: { accountStatus: 1, ratings: 1, region: 1 } },
      );
      return player ? toEligiblePlayer(player) : null;
    });
  }

  findActiveMode(modeId: string): Promise<QueueMode | null> {
    return this.run("matchmaking.findActiveMode", async () => {
      const mode = await this.gameModes.findOne({ _id: modeId, active: true });
      return mode ? toQueueMode(mode) : null;
    });
  }

  findFormationMode(modeId: string): Promise<FormationMode | null> {
    return this.run("matchmaking.findFormationMode", async () => {
      const mode = await this.gameModes.findOne({ _id: modeId, active: true });
      return mode ? toFormationMode(mode) : null;
    });
  }

  isActiveRegion(regionId: string): Promise<boolean> {
    return this.run("matchmaking.isActiveRegion", async () => {
      const count = await this.regions.countDocuments(
        { _id: regionId, active: true },
        { limit: 1 },
      );
      return count > 0;
    });
  }

  findSanctionInForce(playerId: string, at: Date): Promise<SanctionInForce | null> {
    return this.run("matchmaking.findSanctionInForce", async () => {
      const sanction = await this.sanctions.findOne({
        playerId,
        status: "active",
        startsAt: { $lte: at },
        $or: [{ endsAt: null }, { endsAt: { $gt: at } }],
      });
      return sanction ? toSanctionInForce(sanction) : null;
    });
  }
}
