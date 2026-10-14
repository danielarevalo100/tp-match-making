import { toPublicPlayer, type PublicPlayer } from "../../domain/entities/player.js";
import { PlayerNotFoundError } from "../../domain/errors/player-errors.js";
import type { PlayerRepository } from "../../domain/repositories/player-repository.js";

export class GetPlayer {
  constructor(private readonly players: PlayerRepository) {}

  async execute(playerId: string): Promise<PublicPlayer> {
    const player = await this.players.findById(playerId);
    if (!player) throw new PlayerNotFoundError(playerId);
    return toPublicPlayer(player);
  }
}
