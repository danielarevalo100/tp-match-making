import { AppError } from "../../../../../shared/errors.js";

export type ConflictField = "email" | "username";

export class PlayerNotFoundError extends AppError {
  constructor(playerId: string) {
    super(404, "PLAYER_NOT_FOUND", `Player ${playerId} was not found.`);
  }
}

export class PlayerConflictError extends AppError {
  constructor(readonly field: ConflictField) {
    super(409, "PLAYER_CONFLICT", `A player with that ${field} already exists.`, { field });
  }
}

export class RegionNotFoundError extends AppError {
  constructor(country: string) {
    super(422, "REGION_NOT_FOUND", `No active region contains country ${country}.`);
  }
}
