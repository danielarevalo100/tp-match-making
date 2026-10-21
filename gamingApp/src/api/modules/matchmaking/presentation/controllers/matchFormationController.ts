import type { Request, Response } from "express";

import type { MatchFormationService } from "../../business/services/matchFormationService.js";
import { formMatchSchema, recoverFormationsSchema } from "../schemas/formationSchema.js";

export class MatchFormationController {
  constructor(private readonly formation: MatchFormationService) {}

  readonly form = async (request: Request, response: Response): Promise<void> => {
    const input = formMatchSchema.parse(request.body as unknown);
    const result = await this.formation.form(input);
    response.status(result.status === "formed" ? 201 : 200).json(result);
  };

  readonly recover = async (request: Request, response: Response): Promise<void> => {
    const { olderThanMs } = recoverFormationsSchema.parse(request.body ?? {});
    response.json(await this.formation.recoverStaleFormations(olderThanMs));
  };
}
