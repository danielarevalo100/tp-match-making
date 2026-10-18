export class MatchNotLiveError extends Error {
  constructor(matchId: string) {
    super(`There is no live match ${matchId}.`);
    this.name = "MatchNotLiveError";
  }
}

export class PlayerNotInMatchError extends Error {
  constructor(
    readonly matchId: string,
    readonly playerId: string,
  ) {
    super(`Player ${playerId} is not part of match ${matchId}.`);
    this.name = "PlayerNotInMatchError";
  }
}
