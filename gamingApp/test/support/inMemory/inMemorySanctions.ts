import type {
  ProfileDirectoryEntry,
  ProfileSanctionRecord,
} from "../../../src/api/modules/sanctions/business/models/playerProfile.js";
import type {
  AdministratorInfo,
  HeldBoard,
  RatingReversal,
  ReportInfo,
  ReversalStep,
  ReversibleMatch,
  SanctionRecord,
  SeasonCatalog,
  SeasonStanding,
} from "../../../src/api/modules/sanctions/business/models/sanction.js";
import { MatchNotReversibleError } from "../../../src/api/modules/sanctions/business/models/sanctionErrors.js";
import type { ProfileDirectoryPort } from "../../../src/api/modules/sanctions/business/ports/playerProfilePorts.js";
import type {
  GraphCleanupPort,
  HistoryCleanupPort,
  ResultReversalPort,
  SanctionQueuePort,
  SanctionRepositoryPort,
} from "../../../src/api/modules/sanctions/business/ports/sanctionPorts.js";
import { InjectedFailureError } from "../../../src/shared/errors.js";
import { requestContext } from "../../../src/shared/requestContext.js";
import type { InMemoryPlayerHistoryStore } from "./inMemoryPlayerHistory.js";

function failIfRequested(step: string): void {
  if (requestContext.getStore()?.failAt === step) throw new InjectedFailureError(step);
}

function copy(record: SanctionRecord): SanctionRecord {
  return structuredClone(record);
}

export class InMemorySanctionRepository implements SanctionRepositoryPort {
  readonly sanctions = new Map<string, SanctionRecord>();
  readonly players = new Set<string>();
  readonly administrators = new Map<string, AdministratorInfo>();
  readonly reports = new Map<string, ReportInfo>();

  async find(sanctionId: string): Promise<SanctionRecord | null> {
    failIfRequested("sanctions.findSanction");
    const record = this.sanctions.get(sanctionId);
    return record ? copy(record) : null;
  }

  async insert(sanction: SanctionRecord): Promise<boolean> {
    failIfRequested("sanctions.insertSanction");
    if (this.sanctions.has(sanction.id)) return false;
    this.sanctions.set(sanction.id, copy(sanction));
    return true;
  }

  async playerExists(playerId: string): Promise<boolean> {
    failIfRequested("sanctions.findPlayer");
    return this.players.has(playerId);
  }

  async findAdministrator(administratorId: string): Promise<AdministratorInfo | null> {
    failIfRequested("sanctions.findAdministrator");
    return this.administrators.get(administratorId) ?? null;
  }

  async findReport(reportId: string): Promise<ReportInfo | null> {
    failIfRequested("sanctions.findReport");
    return this.reports.get(reportId) ?? null;
  }

  async beginReversal(sanctionId: string, at: Date): Promise<void> {
    failIfRequested("sanctions.beginReversal");
    const record = this.sanctions.get(sanctionId);
    if (!record || record.reversal.status === "completed") {
      throw new Error(`Sanction ${sanctionId} has no reversal to continue.`);
    }
    this.update(sanctionId, (reversal) => ({
      ...reversal,
      attempts: reversal.attempts + 1,
      lastError: null,
      status: "reverting",
      updatedAt: at,
    }));
  }

  async markStep(
    sanctionId: string,
    step: ReversalStep,
    at: Date,
    heldBoards?: readonly HeldBoard[],
  ): Promise<void> {
    failIfRequested("sanctions.markStep");
    this.update(sanctionId, (reversal) => ({
      ...reversal,
      completedSteps: reversal.completedSteps.includes(step)
        ? reversal.completedSteps
        : [...reversal.completedSteps, step],
      heldBoards: heldBoards ? structuredClone([...heldBoards]) : reversal.heldBoards,
      updatedAt: at,
    }));
  }

  async markMatchReverted(sanctionId: string, matchId: string, at: Date): Promise<void> {
    failIfRequested("sanctions.markMatchReverted");
    this.update(sanctionId, (reversal) => ({
      ...reversal,
      revertedMatchIds: reversal.revertedMatchIds.includes(matchId)
        ? reversal.revertedMatchIds
        : [...reversal.revertedMatchIds, matchId],
      updatedAt: at,
    }));
  }

  async completeReversal(sanctionId: string, at: Date): Promise<void> {
    failIfRequested("sanctions.completeReversal");
    this.update(sanctionId, (reversal) => ({
      ...reversal,
      completedAt: at,
      lastError: null,
      status: "completed",
      updatedAt: at,
    }));
  }

  async failReversal(sanctionId: string, message: string, at: Date): Promise<void> {
    failIfRequested("sanctions.failReversal");
    if (this.sanctions.get(sanctionId)?.reversal.status !== "reverting") return;
    this.update(sanctionId, (reversal) => ({
      ...reversal,
      lastError: message,
      status: "failed",
      updatedAt: at,
    }));
  }

  private update(
    sanctionId: string,
    change: (reversal: SanctionRecord["reversal"]) => SanctionRecord["reversal"],
  ): void {
    const record = this.sanctions.get(sanctionId);
    if (!record) return;
    this.sanctions.set(sanctionId, { ...record, reversal: change(record.reversal) });
  }
}

type Rating = { gamesPlayed: number; mmr: number };

/** Mirrors MongoResultReversalAdapter, including the pipeline's rules for season standings. */
export class InMemoryResultReversal implements ResultReversalPort {
  readonly matches = new Map<string, ReversibleMatch>();
  catalog: SeasonCatalog = {
    rankedModes: ["ranked_1v1"],
    seasons: [
      {
        endsAt: new Date("2026-06-30T23:59:59Z"),
        id: "2026-S1",
        startsAt: new Date("2026-01-01T00:00:00Z"),
        status: "closed",
      },
      {
        endsAt: new Date("2026-12-31T23:59:59Z"),
        id: "2026-S2",
        startsAt: new Date("2026-07-01T00:00:00Z"),
        status: "active",
      },
    ],
  };
  /** Ratings by `${playerId}|${mode}`. */
  readonly ratings = new Map<string, Rating>();
  /** Season standings by `${seasonId}|${mode}|${playerId}`. */
  readonly standings = new Map<string, SeasonStanding>();
  /** `${matchId}|${playerId}` problem 4 applied, and the ones already reverted. */
  readonly applied = new Set<string>();
  readonly reverted = new Set<string>();
  ratingReversals = 0;
  /** Makes `revertRating` fail for this match, as a storage error would. */
  failRevertOf: string | null = null;

  async findMatches(matchIds: readonly string[]): Promise<ReversibleMatch[]> {
    failIfRequested("sanctions.findMatches");
    return matchIds.flatMap((matchId) => {
      const match = this.matches.get(matchId);
      return match ? [structuredClone(match)] : [];
    });
  }

  async findSeasonCatalog(): Promise<SeasonCatalog> {
    failIfRequested("sanctions.findSeasonCatalog");
    return structuredClone(this.catalog);
  }

  async voidMatch(matchId: string, sanctionId: string, _at: Date): Promise<void> {
    failIfRequested("sanctions.voidMatch");
    const match = this.matches.get(matchId);
    if (!match) throw new MatchNotReversibleError(matchId, "not_found");
    if (match.status === "voided") return;
    if (match.status !== "closed" || match.scoringStatus !== "applied") {
      throw new MatchNotReversibleError(matchId, "not_scored");
    }
    this.matches.set(matchId, { ...match, status: "voided", voidedBySanctionId: sanctionId });
  }

  async revertRating(reversal: RatingReversal): Promise<void> {
    failIfRequested("sanctions.revertRating");
    if (this.failRevertOf === reversal.matchId) {
      throw new Error(`Simulated storage failure reverting match ${reversal.matchId}.`);
    }
    const key = `${reversal.matchId}|${reversal.playerId}`;
    if (!this.applied.has(key) || this.reverted.has(key)) return;
    this.reverted.add(key);
    this.ratingReversals += 1;

    const ratingKey = `${reversal.playerId}|${reversal.mode}`;
    const rating = this.ratings.get(ratingKey);
    if (rating) {
      this.ratings.set(ratingKey, {
        gamesPlayed: Math.max(rating.gamesPlayed - 1, 0),
        mmr: rating.mmr - reversal.delta,
      });
    }
    for (const seasonId of reversal.seasonIds) {
      const standingKey = `${seasonId}|${reversal.mode}|${reversal.playerId}`;
      const standing = this.standings.get(standingKey);
      if (!standing) continue;
      this.standings.set(standingKey, {
        ...standing,
        gamesPlayed:
          seasonId === reversal.matchSeasonId
            ? Math.max(standing.gamesPlayed - 1, 0)
            : standing.gamesPlayed,
        mmr: standing.mmr - reversal.delta,
        revision: standing.revision + 1,
      });
    }
  }

  async findStandings(
    playerIds: readonly string[],
    seasonId: string,
    mode: string,
  ): Promise<SeasonStanding[]> {
    failIfRequested("sanctions.findStandings");
    return playerIds.flatMap((playerId) => {
      const standing = this.standings.get(`${seasonId}|${mode}|${playerId}`);
      return standing ? [{ ...standing }] : [];
    });
  }

  rating(playerId: string, mode: string): Rating | undefined {
    return this.ratings.get(`${playerId}|${mode}`);
  }

  standing(seasonId: string, mode: string, playerId: string): SeasonStanding | undefined {
    return this.standings.get(`${seasonId}|${mode}|${playerId}`);
  }
}

export class InMemorySanctionQueue implements SanctionQueuePort {
  readonly queued = new Set<string>();

  async leave(playerId: string): Promise<boolean> {
    failIfRequested("matchmaking.leave");
    return this.queued.delete(playerId);
  }
}

/** Deletes from the problem 6 fake, keyed like the Cassandra primary key. */
export class InMemoryHistoryCleanup implements HistoryCleanupPort {
  constructor(private readonly store: InMemoryPlayerHistoryStore) {}

  async deleteMatch(matchId: string, endedAt: Date, playerIds: readonly string[]): Promise<void> {
    failIfRequested("sanctions.deleteHistory");
    for (const playerId of playerIds) {
      this.store.rows.delete(`${playerId}|${String(endedAt.getTime())}|${matchId}`);
    }
  }
}

export class InMemoryGraphCleanup implements GraphCleanupPort {
  readonly matches = new Set<string>();

  async deleteMatch(matchId: string): Promise<void> {
    failIfRequested("sanctions.deleteGraph");
    this.matches.delete(matchId);
  }
}

export class InMemoryProfileDirectory implements ProfileDirectoryPort {
  readonly players = new Map<string, ProfileDirectoryEntry>();
  readonly sanctions: ProfileSanctionRecord[] = [];
  readonly sanctionOwners = new Map<string, string>();
  activeSeasonId: string | null = "2026-S2";

  async findPlayer(playerId: string): Promise<ProfileDirectoryEntry | null> {
    failIfRequested("profile.findPlayer");
    return this.players.get(playerId) ?? null;
  }

  async findActiveSeasonId(): Promise<string | null> {
    failIfRequested("profile.findActiveSeason");
    return this.activeSeasonId;
  }

  async findSanctions(playerId: string, limit: number): Promise<ProfileSanctionRecord[]> {
    failIfRequested("profile.findSanctions");
    return this.sanctions
      .filter((sanction) => this.sanctionOwners.get(sanction.sanctionId) === playerId)
      .sort((left, right) => right.startsAt.getTime() - left.startsAt.getTime())
      .slice(0, limit);
  }
}
