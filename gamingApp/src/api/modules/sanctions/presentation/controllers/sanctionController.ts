import type { Request, Response } from "express";

import type { SanctionView } from "../../business/models/sanction.js";
import type { SanctionService } from "../../business/services/sanctionService.js";
import { createSanctionSchema, sanctionParamsSchema } from "../schemas/sanctionSchema.js";

/** 202 mientras la reversión está incompleta: la sanción está en vigor y un reintento la continúa. */
function reversalStatusCode(sanction: SanctionView, completedCode: number): number {
  return sanction.reversal.status === "completed" ? completedCode : 202;
}

export class SanctionController {
  constructor(private readonly sanctions: SanctionService) {}

  readonly create = async (request: Request, response: Response): Promise<void> => {
    const body = createSanctionSchema.parse(request.body as unknown);
    // El servicio usa null para "no informado".
    const outcome = await this.sanctions.sanction({
      ...body,
      description: body.description ?? null,
      endsAt: body.endsAt ?? null,
      reportId: body.reportId ?? null,
      startsAt: body.startsAt ?? null,
    });
    response
      .status(reversalStatusCode(outcome.sanction, outcome.created ? 201 : 200))
      .json(outcome.sanction);
  };

  readonly get = async (request: Request, response: Response): Promise<void> => {
    const { sanctionId } = sanctionParamsSchema.parse(request.params);
    response.json(await this.sanctions.get(sanctionId));
  };

  readonly resume = async (request: Request, response: Response): Promise<void> => {
    const { sanctionId } = sanctionParamsSchema.parse(request.params);
    const sanction = await this.sanctions.resume(sanctionId);
    response.status(reversalStatusCode(sanction, 200)).json(sanction);
  };
}
