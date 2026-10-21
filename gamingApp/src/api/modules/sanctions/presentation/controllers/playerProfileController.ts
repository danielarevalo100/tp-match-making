import type { Request, Response } from "express";

import type { PlayerProfileService } from "../../business/services/playerProfileService.js";
import { profileParamsSchema, profileQuerySchema } from "../schemas/sanctionSchema.js";

export class PlayerProfileController {
  constructor(private readonly profiles: PlayerProfileService) {}

  readonly get = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = profileParamsSchema.parse(request.params);
    const { matches } = profileQuerySchema.parse(request.query);
    response.json(await this.profiles.profile(playerId, matches));
  };
}
