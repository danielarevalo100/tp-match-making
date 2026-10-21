import type { Request, Response } from "express";

import type { CrossReportCriteria, MatchFixingCriteria } from "../../business/models/fraud.js";
import type { FraudDetectionService } from "../../business/services/fraudDetectionService.js";
import type { FraudGraphProjectionService } from "../../business/services/fraudGraphProjectionService.js";
import {
  crossReportsQuerySchema,
  irregularBehaviorQuerySchema,
  matchFixingQuerySchema,
  projectGraphSchema,
} from "../schemas/fraudSchema.js";

const dayMs = 86_400_000;
const minuteMs = 60_000;

const since = (days: number): Date => new Date(Date.now() - days * dayMs);

function matchFixingCriteria(query: {
  days: number;
  limit: number;
  minBenefitRatio: number;
  minMatches: number;
  mode?: string;
}): MatchFixingCriteria {
  return {
    limit: query.limit,
    minBenefitRatio: query.minBenefitRatio,
    minMatches: query.minMatches,
    mode: query.mode,
    since: since(query.days),
  };
}

function crossReportCriteria(query: {
  days: number;
  minReporters: number;
  windowMinutes: number;
}): CrossReportCriteria {
  return {
    minReporters: query.minReporters,
    since: since(query.days),
    windowMs: query.windowMinutes * minuteMs,
  };
}

export class FraudController {
  constructor(
    private readonly detection: FraudDetectionService,
    private readonly projection: FraudGraphProjectionService,
  ) {}

  readonly matchFixing = async (request: Request, response: Response): Promise<void> => {
    const query = matchFixingQuerySchema.parse(request.query);
    response.json(await this.detection.detectMatchFixing(matchFixingCriteria(query)));
  };

  readonly crossReports = async (request: Request, response: Response): Promise<void> => {
    const query = crossReportsQuerySchema.parse(request.query);
    response.json(await this.detection.detectCrossReports(crossReportCriteria(query)));
  };

  readonly irregularBehavior = async (request: Request, response: Response): Promise<void> => {
    const query = irregularBehaviorQuerySchema.parse(request.query);
    response.json(
      await this.detection.detectIrregularBehavior(
        matchFixingCriteria(query),
        crossReportCriteria(query),
      ),
    );
  };

  readonly project = async (request: Request, response: Response): Promise<void> => {
    const body = projectGraphSchema.parse(request.body ?? {});
    response.json(
      await this.projection.project({
        afterId: body.afterId ?? null,
        limit: body.limit,
        since: body.since,
      }),
    );
  };
}
