import type { Collection, Db } from "mongodb";

import { BaseMongoAdapter } from "../../../../../infrastructure/mongo/baseMongoAdapter.js";
import { mongoCollections } from "../../../../../shared/storageKeys.js";
import type { ReportedPlayerReports } from "../../business/models/fraud.js";
import type { ReportsPort } from "../../business/ports/fraudPorts.js";

type ReportDocument = {
  _id: string;
  createdAt: Date;
  reportedPlayerId: string;
  reporterPlayerId: string | null;
};

type GroupedReports = {
  _id: string;
  reports: { createdAt: Date; reportId: string; reporterPlayerId: string }[];
};

export class MongoReportsAdapter extends BaseMongoAdapter implements ReportsPort {
  private readonly reports: Collection<ReportDocument>;

  constructor(database: Db) {
    super(database);
    this.reports = database.collection<ReportDocument>(mongoCollections.reports);
  }

  // Los reportes automáticos (reporterPlayerId null) no tienen autor; la cantidad de autores
  // distintos se calcula en MongoDB, así solo viajan los jugadores que pueden quedar marcados.
  findReportedByMany(since: Date, minReporters: number): Promise<ReportedPlayerReports[]> {
    return this.read(async () => {
      const groups = await this.reports
        .aggregate<GroupedReports>([
          { $match: { createdAt: { $gte: since }, reporterPlayerId: { $ne: null } } },
          {
            $group: {
              _id: "$reportedPlayerId",
              reporters: { $addToSet: "$reporterPlayerId" },
              reports: {
                $push: {
                  createdAt: "$createdAt",
                  reportId: "$_id",
                  reporterPlayerId: "$reporterPlayerId",
                },
              },
            },
          },
          { $match: { $expr: { $gte: [{ $size: "$reporters" }, minReporters] } } },
          { $project: { reports: 1 } },
        ])
        .toArray();
      return groups.map((group) => ({ reportedPlayerId: group._id, reports: group.reports }));
    });
  }
}
