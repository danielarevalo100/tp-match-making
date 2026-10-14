import type { Collection } from "mongodb";

import type {
  EligibilityRepository,
  EligiblePlayer,
  QueueMode,
  SanctionInForce,
} from "../../domain/repositories/eligibility-repository.js";

type PlayerDocument = {
  _id: string;
  accountStatus: string;
  ratings: Record<string, { mmr: number }>;
  region: string;
};

type GameModeDocument = { _id: string; active: boolean; initialRating?: number };
type RegionDocument = { _id: string; active: boolean };
type SanctionDocument = {
  _id: string;
  endsAt: Date | null;
  playerId: string;
  startsAt: Date;
  status: string;
  type: string;
};

export class MongoEligibilityRepository implements EligibilityRepository {
  constructor(
    private readonly players: Collection<PlayerDocument>,
    private readonly gameModes: Collection<GameModeDocument>,
    private readonly regions: Collection<RegionDocument>,
    private readonly sanctions: Collection<SanctionDocument>,
  ) {}

  async findPlayer(playerId: string): Promise<EligiblePlayer | null> {
    const player = await this.players.findOne(
      { _id: playerId },
      { projection: { accountStatus: 1, ratings: 1, region: 1 } },
    );
    if (!player) return null;
    return {
      accountStatus: player.accountStatus,
      id: player._id,
      ratings: player.ratings,
      region: player.region,
    };
  }

  async findActiveMode(modeId: string): Promise<QueueMode | null> {
    const mode = await this.gameModes.findOne({ _id: modeId, active: true });
    return mode ? { id: mode._id, initialRating: mode.initialRating ?? 1_000 } : null;
  }

  async isActiveRegion(regionId: string): Promise<boolean> {
    return (await this.regions.countDocuments({ _id: regionId, active: true }, { limit: 1 })) > 0;
  }

  // In force: status "active", already started, and not ended (endsAt null =
  // permanent). Served by the index {playerId, status, endsAt}.
  async findSanctionInForce(playerId: string, at: Date): Promise<SanctionInForce | null> {
    const sanction = await this.sanctions.findOne({
      playerId,
      status: "active",
      startsAt: { $lte: at },
      $or: [{ endsAt: null }, { endsAt: { $gt: at } }],
    });
    return sanction ? { endsAt: sanction.endsAt, id: sanction._id, type: sanction.type } : null;
  }
}
