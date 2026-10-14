import { PlayerConflictError, RegionNotFoundError } from "../../domain/errors/player-errors.js";
import { toPublicPlayer, type Player, type PublicPlayer } from "../../domain/entities/player.js";
import type { CatalogRepository } from "../../domain/repositories/catalog-repository.js";
import type { PlayerRepository } from "../../domain/repositories/player-repository.js";
import type { Clock, IdGenerator, PasswordHasher } from "../ports/system.js";

export type RegisterPlayerInput = {
  avatarUrl?: string | undefined;
  birthDate?: Date | undefined;
  country: string;
  email: string;
  password: string;
  username: string;
};

export class RegisterPlayer {
  constructor(
    private readonly players: PlayerRepository,
    private readonly catalogs: CatalogRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(input: RegisterPlayerInput): Promise<PublicPlayer> {
    const username = input.username.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    const country = input.country.trim().toUpperCase();

    const [existingUsername, existingEmail, region, gameModes] = await Promise.all([
      this.players.findByUsername(username),
      this.players.findByEmail(email),
      this.catalogs.findActiveRegionByCountry(country),
      this.catalogs.listActiveGameModes(),
    ]);

    if (existingUsername) throw new PlayerConflictError("username");
    if (existingEmail) throw new PlayerConflictError("email");
    if (!region) throw new RegionNotFoundError(country);

    const now = this.clock.now();
    const ratings = Object.fromEntries(
      gameModes.map((mode) => [
        mode.id,
        { gamesPlayed: 0, mmr: mode.initialRating, updatedAt: now },
      ]),
    );

    const player: Player = {
      accountStatus: "active",
      country,
      email,
      id: this.idGenerator.generate(),
      level: 1,
      passwordHash: await this.passwordHasher.hash(input.password),
      ratings,
      region,
      registeredAt: now,
      updatedAt: now,
      username,
      ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
      ...(input.birthDate === undefined ? {} : { birthDate: input.birthDate }),
    };

    await this.players.create(player);
    return toPublicPlayer(player);
  }
}
