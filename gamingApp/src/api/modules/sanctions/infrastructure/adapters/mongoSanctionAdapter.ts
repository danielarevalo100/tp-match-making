import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type {
  AdministratorInfo,
  HeldBoard,
  ReportInfo,
  ReversalStep,
  SanctionRecord,
} from "../../business/models/sanction.js";
import type { SanctionRepositoryPort } from "../../business/ports/sanctionPorts.js";
import {
  isDuplicateKey,
  toSanctionDocument,
  toSanctionRecord,
  type SanctionDocument,
} from "../mappers/sanctionMapper.js";

type PlayerDocument = { _id: string };
type AdministratorDocument = { _id: string; active: boolean };
type ReportDocument = { _id: string; matchId?: string | null; reportedPlayerId: string };

const maxErrorLength = 1_000;

export class MongoSanctionAdapter extends BaseMongoAdapter implements SanctionRepositoryPort {
  private readonly administrators: Collection<AdministratorDocument>;
  private readonly players: Collection<PlayerDocument>;
  private readonly reports: Collection<ReportDocument>;
  private readonly sanctions: Collection<SanctionDocument>;

  constructor(database: Db) {
    super(database);
    this.administrators = database.collection<AdministratorDocument>(
      mongoCollections.administrators,
    );
    this.players = database.collection<PlayerDocument>(mongoCollections.players);
    this.reports = database.collection<ReportDocument>(mongoCollections.reports);
    this.sanctions = database.collection<SanctionDocument>(mongoCollections.sanctions);
  }

  find(sanctionId: string): Promise<SanctionRecord | null> {
    return this.run("sanctions.findSanction", async () => {
      const document = await this.sanctions.findOne({ _id: sanctionId });
      return document ? toSanctionRecord(document) : null;
    });
  }

  // `_id` is the caller's sanctionId: a retry hits the unique index instead of a second sanction.
  insert(sanction: SanctionRecord): Promise<boolean> {
    return this.run("sanctions.insertSanction", async () => {
      try {
        await this.sanctions.insertOne(toSanctionDocument(sanction));
        return true;
      } catch (error: unknown) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    });
  }

  playerExists(playerId: string): Promise<boolean> {
    return this.run("sanctions.findPlayer", async () => {
      return (await this.players.countDocuments({ _id: playerId }, { limit: 1 })) > 0;
    });
  }

  findAdministrator(administratorId: string): Promise<AdministratorInfo | null> {
    return this.run("sanctions.findAdministrator", async () => {
      const administrator = await this.administrators.findOne(
        { _id: administratorId },
        { projection: { active: 1 } },
      );
      return administrator ? { active: administrator.active, id: administrator._id } : null;
    });
  }

  findReport(reportId: string): Promise<ReportInfo | null> {
    return this.run("sanctions.findReport", async () => {
      const report = await this.reports.findOne(
        { _id: reportId },
        { projection: { matchId: 1, reportedPlayerId: 1 } },
      );
      return report
        ? {
            id: report._id,
            matchId: report.matchId ?? null,
            reportedPlayerId: report.reportedPlayerId,
          }
        : null;
    });
  }

  beginReversal(sanctionId: string, at: Date): Promise<void> {
    return this.run("sanctions.beginReversal", async () => {
      const result = await this.sanctions.updateOne(
        { _id: sanctionId, "reversal.status": { $in: ["pending", "failed", "reverting"] } },
        {
          $inc: { "reversal.attempts": 1 },
          $set: {
            "reversal.lastError": null,
            "reversal.status": "reverting",
            "reversal.updatedAt": at,
          },
        },
      );
      if (result.matchedCount === 0) {
        throw new Error(`Sanction ${sanctionId} has no reversal to continue.`);
      }
    });
  }

  markStep(
    sanctionId: string,
    step: ReversalStep,
    at: Date,
    heldBoards?: readonly HeldBoard[],
  ): Promise<void> {
    return this.run("sanctions.markStep", async () => {
      await this.sanctions.updateOne(
        { _id: sanctionId },
        {
          $addToSet: { "reversal.completedSteps": step },
          $set: {
            "reversal.updatedAt": at,
            ...(heldBoards
              ? {
                  "reversal.heldBoards": heldBoards.map((board) => ({
                    mode: board.mode,
                    playerIds: [...board.playerIds],
                    seasonId: board.seasonId,
                  })),
                }
              : {}),
          },
        },
      );
    });
  }

  markMatchReverted(sanctionId: string, matchId: string, at: Date): Promise<void> {
    return this.run("sanctions.markMatchReverted", async () => {
      await this.sanctions.updateOne(
        { _id: sanctionId },
        {
          $addToSet: { "reversal.revertedMatchIds": matchId },
          $set: { "reversal.updatedAt": at },
        },
      );
    });
  }

  completeReversal(sanctionId: string, at: Date): Promise<void> {
    return this.run("sanctions.completeReversal", async () => {
      await this.sanctions.updateOne(
        { _id: sanctionId },
        {
          $set: {
            "reversal.completedAt": at,
            "reversal.lastError": null,
            "reversal.status": "completed",
            "reversal.updatedAt": at,
          },
        },
      );
    });
  }

  failReversal(sanctionId: string, message: string, at: Date): Promise<void> {
    return this.run("sanctions.failReversal", async () => {
      await this.sanctions.updateOne(
        { _id: sanctionId, "reversal.status": "reverting" },
        {
          $set: {
            "reversal.lastError": message.slice(0, maxErrorLength),
            "reversal.status": "failed",
            "reversal.updatedAt": at,
          },
        },
      );
    });
  }
}
