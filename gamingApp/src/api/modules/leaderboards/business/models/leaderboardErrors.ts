export type LeaderboardMissingPart = "mode" | "region" | "season";

export class LeaderboardNotFoundError extends Error {
  constructor(
    readonly missing: LeaderboardMissingPart,
    readonly id: string,
  ) {
    super(`There is no leaderboard for ${missing} ${id}.`);
    this.name = "LeaderboardNotFoundError";
  }
}

export class ModeNotRankedError extends Error {
  constructor(readonly mode: string) {
    super(`Game mode ${mode} is not ranked, so it has no leaderboard.`);
    this.name = "ModeNotRankedError";
  }
}

export class LeaderboardRebuildInProgressError extends Error {
  constructor(
    readonly seasonId: string,
    readonly mode: string,
  ) {
    super(`The ${mode} leaderboard of season ${seasonId} is being rebuilt; retry shortly.`);
    this.name = "LeaderboardRebuildInProgressError";
  }
}

export class PlayerNotRankedError extends Error {
  constructor(readonly playerId: string) {
    super(`Player ${playerId} is not ranked in this leaderboard.`);
    this.name = "PlayerNotRankedError";
  }
}
