export class MatchForClosureNotFoundError extends Error {
  constructor(matchId: string) {
    super(`Match ${matchId} was not found.`);
    this.name = "MatchForClosureNotFoundError";
  }
}

export class MatchClosureConflictError extends Error {
  constructor(
    readonly matchId: string,
    readonly currentStatus: string,
  ) {
    super(`Match ${matchId} cannot be closed from status ${currentStatus}.`);
    this.name = "MatchClosureConflictError";
  }
}

export class MatchClosureParticipantsError extends Error {
  constructor(readonly reason: string) {
    super(`The declared match results are invalid: ${reason}.`);
    this.name = "MatchClosureParticipantsError";
  }
}

export class MatchCloseUnavailableError extends Error {
  constructor(
    readonly matchId: string,
    cause: Error,
  ) {
    super(`Match ${matchId} could not be moved to the closing state.`, { cause });
    this.name = "MatchCloseUnavailableError";
  }
}
