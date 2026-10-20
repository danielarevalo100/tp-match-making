import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type {
  DeclaredPlayerResult,
  FinishMatchInput,
  MatchClosureRecord,
  MatchLifecycleStatus,
  MatchParticipant,
  PlayerFinalScore,
  ScoringStatus,
} from "../../business/models/matchClosure.js";
import { MatchClosureConflictError } from "../../business/models/matchClosureErrors.js";
import type { MatchClosureRepositoryPort } from "../../business/ports/matchClosurePorts.js";

type ClosureDocument = {
  completedAt?: Date;
  eventId: string;
  id: string;
  reason: string;
  requestedAt: Date;
  results: DeclaredPlayerResult[];
  tsMs: number;
};

type MatchClosureDocument = {
  _id: string;
  closure?: ClosureDocument;
  finalScoreboard?: PlayerFinalScore[];
  mode: string;
  players: MatchParticipant[];
  scoringAttempts?: number;
  scoringLastError?: string;
  scoringStatus?: ScoringStatus;
  scoringUpdatedAt?: Date;
  status: MatchLifecycleStatus;
};

type RatingDocument = {
  gamesPlayed: number;
  mmr: number;
  updatedAt: Date;
};

type RatingPlayerDocument = {
  _id: string;
  appliedRatingMatches?: string[];
  ratings: Record<string, RatingDocument>;
  updatedAt: Date;
};

function toRecord(document: MatchClosureDocument): MatchClosureRecord {
  return {
    closureId: document.closure?.id ?? null,
    eventId: document.closure?.eventId ?? null,
    id: document._id,
    mode: document.mode,
    players: document.players.map((player) => ({ ...player })),
    results: document.closure?.results.map((result) => ({ ...result })) ?? null,
    scoringStatus: document.scoringStatus ?? "not_started",
    status: document.status,
  };
}

export class MongoMatchClosureAdapter
  extends BaseMongoAdapter
  implements MatchClosureRepositoryPort
{
  private readonly matches: Collection<MatchClosureDocument>;
  private readonly players: Collection<RatingPlayerDocument>;

  constructor(database: Db) {
    super(database);
    this.matches = database.collection<MatchClosureDocument>(mongoCollections.matches);
    this.players = database.collection<RatingPlayerDocument>(mongoCollections.players);
  }

  find(matchId: string): Promise<MatchClosureRecord | null> {
    return this.run("matchClosure.findMatch", async () => {
      const match = await this.matches.findOne({ _id: matchId });
      return match ? toRecord(match) : null;
    });
  }

  prepare(input: FinishMatchInput): Promise<MatchClosureRecord | null> {
    return this.run("matchClosure.prepareMongo", async () => {
      const match = await this.matches.findOneAndUpdate(
        { _id: input.matchId, status: "in_progress" },
        {
          $set: {
            closure: {
              eventId: input.eventId,
              id: input.closureId,
              reason: input.reason,
              requestedAt: new Date(),
              results: input.results.map((result) => ({ ...result })),
              tsMs: input.tsMs,
            },
            scoringStatus: "not_started",
            status: "closing",
          },
        },
        { returnDocument: "after" },
      );
      return match ? toRecord(match) : null;
    });
  }

  rollbackPreparation(matchId: string, closureId: string): Promise<void> {
    return this.run("matchClosure.rollbackMongo", async () => {
      await this.matches.updateOne(
        { _id: matchId, "closure.id": closureId, status: "closing" },
        {
          $set: { status: "in_progress" },
          $unset: { closure: "", scoringStatus: "" },
        },
      );
    });
  }

  markClosedPending(matchId: string, closureId: string, closedAt: Date): Promise<void> {
    return this.run("matchClosure.markClosed", async () => {
      const result = await this.matches.updateOne(
        { _id: matchId, "closure.id": closureId, status: "closing" },
        {
          $set: {
            "closure.completedAt": closedAt,
            scoringStatus: "pending",
            scoringUpdatedAt: closedAt,
            status: "closed",
          },
        },
      );
      if (result.matchedCount > 0) return;
      const current = await this.matches.findOne({ _id: matchId });
      if (current?.status !== "closed" || current.closure?.id !== closureId) {
        throw new MatchClosureConflictError(matchId, current?.status ?? "missing");
      }
    });
  }

  beginScoring(matchId: string, closureId: string, at: Date): Promise<ScoringStatus> {
    return this.run("matchClosure.beginScoring", async () => {
      const match = await this.matches.findOneAndUpdate(
        {
          _id: matchId,
          "closure.id": closureId,
          scoringStatus: { $in: ["pending", "failed", "calculating"] },
          status: "closed",
        },
        {
          $inc: { scoringAttempts: 1 },
          $set: { scoringStatus: "calculating", scoringUpdatedAt: at },
          $unset: { scoringLastError: "" },
        },
        { returnDocument: "after" },
      );
      if (match) return match.scoringStatus ?? "calculating";
      const current = await this.matches.findOne({ _id: matchId });
      if (current?.scoringStatus === "applied" && current.closure?.id === closureId) {
        return "applied";
      }
      throw new MatchClosureConflictError(matchId, current?.status ?? "missing");
    });
  }

  completeScoring(
    matchId: string,
    closureId: string,
    scores: readonly PlayerFinalScore[],
    at: Date,
  ): Promise<void> {
    return this.run("matchClosure.completeScoring", async () => {
      const result = await this.matches.updateOne(
        { _id: matchId, "closure.id": closureId, status: "closed" },
        {
          $set: {
            finalScoreboard: scores.map((score) => ({ ...score })),
            scoringStatus: "applied",
            scoringUpdatedAt: at,
          },
          $unset: { scoringLastError: "" },
        },
      );
      if (result.matchedCount === 0) {
        throw new MatchClosureConflictError(matchId, "scoring_not_closable");
      }
    });
  }

  failScoring(matchId: string, closureId: string, message: string, at: Date): Promise<void> {
    return this.run("matchClosure.failScoring", async () => {
      await this.matches.updateOne(
        {
          _id: matchId,
          "closure.id": closureId,
          scoringStatus: "calculating",
          status: "closed",
        },
        {
          $set: {
            scoringLastError: message.slice(0, 1_000),
            scoringStatus: "failed",
            scoringUpdatedAt: at,
          },
        },
      );
    });
  }

  applyRating(
    playerId: string,
    mode: string,
    matchId: string,
    delta: number,
    at: Date,
  ): Promise<void> {
    return this.run("matchClosure.applyRating", async () => {
      const mmrPath = `ratings.${mode}.mmr`;
      const gamesPath = `ratings.${mode}.gamesPlayed`;
      const ratingUpdatedAtPath = `ratings.${mode}.updatedAt`;
      const result = await this.players.updateOne(
        { _id: playerId, appliedRatingMatches: { $ne: matchId } },
        {
          $addToSet: { appliedRatingMatches: matchId },
          $inc: { [gamesPath]: 1, [mmrPath]: delta },
          $set: { [ratingUpdatedAtPath]: at, updatedAt: at },
        },
      );
      if (result.matchedCount > 0) return;
      const alreadyApplied = await this.players.findOne({
        _id: playerId,
        appliedRatingMatches: matchId,
      });
      if (!alreadyApplied) throw new Error(`Player ${playerId} was not found while scoring.`);
    });
  }
}
