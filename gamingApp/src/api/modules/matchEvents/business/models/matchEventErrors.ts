import { AppError } from "../../../../../shared/errors.js";

export class MatchNotLiveError extends AppError {
  constructor(matchId: string) {
    super(404, "MATCH_NOT_LIVE", `There is no live match ${matchId}.`);
  }
}

export class PlayerNotInMatchError extends AppError {
  constructor(
    readonly matchId: string,
    readonly playerId: string,
  ) {
    super(422, "PLAYER_NOT_IN_MATCH", `Player ${playerId} is not part of match ${matchId}.`, {
      playerId,
    });
  }
}
