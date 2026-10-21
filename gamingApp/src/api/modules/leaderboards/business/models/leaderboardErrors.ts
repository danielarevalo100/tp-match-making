import { AppError } from "../../../../../shared/errors.js";

export type LeaderboardMissingPart = "mode" | "region" | "season";

export class LeaderboardNotFoundError extends AppError {
  constructor(
    readonly missing: LeaderboardMissingPart,
    readonly id: string,
  ) {
    super(404, "LEADERBOARD_NOT_FOUND", `There is no leaderboard for ${missing} ${id}.`, {
      id,
      missing,
    });
  }
}

export class ModeNotRankedError extends AppError {
  constructor(readonly mode: string) {
    super(422, "MODE_NOT_RANKED", `Game mode ${mode} is not ranked, so it has no leaderboard.`);
  }
}

export class PlayerNotRankedError extends AppError {
  constructor(readonly playerId: string) {
    super(404, "PLAYER_NOT_RANKED", `Player ${playerId} is not ranked in this leaderboard.`, {
      playerId,
    });
  }
}
