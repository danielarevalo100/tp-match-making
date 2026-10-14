import { toPublicPlayer, type PublicPlayer } from "../../domain/entities/player.js";
import type { PlayerRepository } from "../../domain/repositories/player-repository.js";

export type ListPlayersInput = {
  cursor: string | null;
  limit: number;
};

export type PublicPlayerPage = {
  items: readonly PublicPlayer[];
  nextCursor: string | null;
};

export class ListPlayers {
  constructor(private readonly players: PlayerRepository) {}

  async execute(input: ListPlayersInput): Promise<PublicPlayerPage> {
    const page = await this.players.list(input.cursor, input.limit);
    return {
      items: page.items.map(toPublicPlayer),
      nextCursor: page.nextCursor,
    };
  }
}
