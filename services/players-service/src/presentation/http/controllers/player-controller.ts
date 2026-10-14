import type { Request, Response } from "express";

import type { GetPlayer } from "../../../application/use-cases/get-player.js";
import type { ListPlayers } from "../../../application/use-cases/list-players.js";
import type { RegisterPlayer } from "../../../application/use-cases/register-player.js";
import type { UpdatePlayerProfile } from "../../../application/use-cases/update-player-profile.js";
import type { UpdatePlayerStatus } from "../../../application/use-cases/update-player-status.js";
import {
  listPlayersSchema,
  playerIdSchema,
  registerPlayerSchema,
  updatePlayerProfileSchema,
  updatePlayerStatusSchema,
} from "../schemas/player-schemas.js";

export class PlayerController {
  constructor(
    private readonly registerPlayer: RegisterPlayer,
    private readonly getPlayer: GetPlayer,
    private readonly listPlayers: ListPlayers,
    private readonly updatePlayerProfile: UpdatePlayerProfile,
    private readonly updatePlayerStatus: UpdatePlayerStatus,
  ) {}

  readonly register = async (request: Request, response: Response): Promise<void> => {
    const input = registerPlayerSchema.parse(request.body as unknown);
    const player = await this.registerPlayer.execute(input);
    response.status(201).json(player);
  };

  readonly getById = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdSchema.parse(request.params);
    const player = await this.getPlayer.execute(playerId);
    response.json(player);
  };

  readonly list = async (request: Request, response: Response): Promise<void> => {
    const query = listPlayersSchema.parse(request.query);
    const page = await this.listPlayers.execute({
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    response.json(page);
  };

  readonly updateProfile = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdSchema.parse(request.params);
    const input = updatePlayerProfileSchema.parse(request.body as unknown);
    const player = await this.updatePlayerProfile.execute(playerId, input);
    response.json(player);
  };

  readonly updateStatus = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdSchema.parse(request.params);
    const { status } = updatePlayerStatusSchema.parse(request.body as unknown);
    const player = await this.updatePlayerStatus.execute(playerId, status);
    response.json(player);
  };
}
