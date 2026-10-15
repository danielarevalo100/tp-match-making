import type {
  EligiblePlayer,
  QueueMode,
  SanctionInForce,
} from "../../../src/api/modules/matchmaking/business/models/queueTicket.js";
import type { EligibilityRepositoryPort } from "../../../src/api/modules/matchmaking/business/ports/matchmakingPorts.js";

export type StoredSanction = SanctionInForce & {
  playerId: string;
  startsAt: Date;
  status: "active" | "expired" | "revoked";
};

export class InMemoryEligibilityRepository implements EligibilityRepositoryPort {
  readonly players = new Map<string, EligiblePlayer>();
  readonly modes = new Map<string, QueueMode>([
    ["ranked_1v1", { id: "ranked_1v1", initialRating: 1_000 }],
  ]);
  readonly regions = new Set(["LATAM", "EU"]);
  readonly sanctions: StoredSanction[] = [];

  async findPlayer(playerId: string): Promise<EligiblePlayer | null> {
    return this.players.get(playerId) ?? null;
  }

  async findActiveMode(modeId: string): Promise<QueueMode | null> {
    return this.modes.get(modeId) ?? null;
  }

  async isActiveRegion(regionId: string): Promise<boolean> {
    return this.regions.has(regionId);
  }

  async findSanctionInForce(playerId: string, at: Date): Promise<SanctionInForce | null> {
    return (
      this.sanctions.find(
        (sanction) =>
          sanction.playerId === playerId &&
          sanction.status === "active" &&
          sanction.startsAt <= at &&
          (sanction.endsAt === null || sanction.endsAt > at),
      ) ?? null
    );
  }
}
