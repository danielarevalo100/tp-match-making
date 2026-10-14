export const accountStatuses = ["active", "inactive", "closed"] as const;

export type AccountStatus = (typeof accountStatuses)[number];

export type PlayerRating = {
  gamesPlayed: number;
  mmr: number;
  updatedAt: Date;
};

export type Player = {
  accountStatus: AccountStatus;
  avatarUrl?: string;
  birthDate?: Date;
  country: string;
  email: string;
  id: string;
  level: number;
  passwordHash: string;
  ratings: Readonly<Record<string, PlayerRating>>;
  region: string;
  registeredAt: Date;
  updatedAt: Date;
  username: string;
};

export type PublicPlayer = Omit<Player, "passwordHash">;

export function toPublicPlayer(player: Player): PublicPlayer {
  const { passwordHash: _passwordHash, ...publicPlayer } = player;
  return publicPlayer;
}
