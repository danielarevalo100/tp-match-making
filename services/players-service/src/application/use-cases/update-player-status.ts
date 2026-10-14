import { toPublicPlayer, type AccountStatus, type PublicPlayer } from "../../domain/entities/player.js";
import { PlayerNotFoundError } from "../../domain/errors/player-errors.js";
import type { PlayerRepository } from "../../domain/repositories/player-repository.js";
import type { Clock } from "../ports/system.js";

export class UpdatePlayerStatus {
  constructor(
    private readonly players: PlayerRepository,
    private readonly clock: Clock,
  ) {}

  async execute(playerId: string, status: AccountStatus): Promise<PublicPlayer> {
    const updated = await this.players.updateStatus(playerId, status, this.clock.now());
    if (!updated) throw new PlayerNotFoundError(playerId);
    return toPublicPlayer(updated);
  }
}
