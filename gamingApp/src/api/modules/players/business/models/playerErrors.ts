export type ConflictField = "email" | "username";

export class PlayerNotFoundError extends Error {
  constructor(playerId: string) {
    super(`Player ${playerId} was not found.`);
    this.name = "PlayerNotFoundError";
  }
}

export class PlayerConflictError extends Error {
  constructor(readonly field: ConflictField) {
    super(`A player with that ${field} already exists.`);
    this.name = "PlayerConflictError";
  }
}

export class RegionNotFoundError extends Error {
  constructor(country: string) {
    super(`No active region contains country ${country}.`);
    this.name = "RegionNotFoundError";
  }
}
