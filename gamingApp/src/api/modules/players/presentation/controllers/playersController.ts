import type { Request, Response } from "express";

import type { PlayersService } from "../../business/services/playersService.js";
import {
  listPlayersSchema,
  playerIdSchema,
  registerPlayerSchema,
  updatePlayerProfileSchema,
  updatePlayerStatusSchema,
} from "../schemas/playersSchema.js";

export class PlayersController {
  constructor(private readonly playersService: PlayersService) {}

  readonly register = async (request: Request, response: Response): Promise<void> => {
    const input = registerPlayerSchema.parse(request.body as unknown);
    const player = await this.playersService.register(input);
    response.status(201).json(player);
  };

  readonly getById = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdSchema.parse(request.params);
    const player = await this.playersService.getById(playerId);
    response.json(player);
  };

  readonly list = async (request: Request, response: Response): Promise<void> => {
    const query = listPlayersSchema.parse(request.query);
    const page = await this.playersService.list({
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    response.json(page);
  };

  readonly updateProfile = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdSchema.parse(request.params);
    const input = updatePlayerProfileSchema.parse(request.body as unknown);
    const player = await this.playersService.updateProfile(playerId, input);
    response.json(player);
  };

  readonly updateStatus = async (request: Request, response: Response): Promise<void> => {
    const { playerId } = playerIdSchema.parse(request.params);
    const { status } = updatePlayerStatusSchema.parse(request.body as unknown);
    const player = await this.playersService.updateStatus(playerId, status);
    response.json(player);
  };
}
