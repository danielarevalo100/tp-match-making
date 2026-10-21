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

export type PlayerPage = {
  items: readonly Player[];
  nextCursor: string | null;
};

export type PublicPlayerPage = {
  items: readonly PublicPlayer[];
  nextCursor: string | null;
};

export type PlayerProfileChanges = {
  avatarUrl?: string | null;
  birthDate?: Date | null;
  country?: string;
  email?: string;
  region?: string;
  username?: string;
};

export type GameMode = {
  id: string;
  initialRating: number;
};

export function toPublicPlayer(player: Player): PublicPlayer {
  const { passwordHash: _passwordHash, ...publicPlayer } = player;
  return publicPlayer;
}
