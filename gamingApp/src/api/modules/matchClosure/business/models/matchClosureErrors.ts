import { AppError } from "../../../../../shared/errors.js";

export class MatchForClosureNotFoundError extends AppError {
  constructor(matchId: string) {
    super(404, "MATCH_NOT_FOUND", `Match ${matchId} was not found.`);
  }
}

export class MatchClosureConflictError extends AppError {
  constructor(
    readonly matchId: string,
    readonly currentStatus: string,
  ) {
    super(
      409,
      "MATCH_CLOSE_CONFLICT",
      `Match ${matchId} cannot be closed from status ${currentStatus}.`,
      { currentStatus, matchId },
    );
  }
}

export class MatchClosureParticipantsError extends AppError {
  constructor(readonly reason: string) {
    super(422, "INVALID_MATCH_RESULTS", `The declared match results are invalid: ${reason}.`, {
      reason,
    });
  }
}

export class MatchCloseUnavailableError extends AppError {
  constructor(
    readonly matchId: string,
    cause: Error,
  ) {
    super(
      503,
      "MATCH_CLOSE_UNAVAILABLE",
      `Match ${matchId} could not be moved to the closing state.`,
      { matchId },
    );
    this.cause = cause;
  }
}
