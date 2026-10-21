export class SanctionPlayerNotFoundError extends Error {
  constructor(readonly playerId: string) {
    super(`Player ${playerId} was not found.`);
    this.name = "SanctionPlayerNotFoundError";
  }
}

export class AdministratorNotFoundError extends Error {
  constructor(readonly administratorId: string) {
    super(`Administrator ${administratorId} was not found.`);
    this.name = "AdministratorNotFoundError";
  }
}

export class AdministratorNotActiveError extends Error {
  constructor(readonly administratorId: string) {
    super(`Administrator ${administratorId} is not active and cannot sanction players.`);
    this.name = "AdministratorNotActiveError";
  }
}

export class InvalidSanctionReportError extends Error {
  constructor(
    readonly reportId: string,
    readonly reason: "not_found" | "other_player",
  ) {
    super(
      reason === "not_found"
        ? `Report ${reportId} was not found.`
        : `Report ${reportId} is about another player.`,
    );
    this.name = "InvalidSanctionReportError";
  }
}

export type MatchNotReversibleReason = "not_found" | "not_participant" | "not_scored";

export class MatchNotReversibleError extends Error {
  constructor(
    readonly matchId: string,
    readonly reason: MatchNotReversibleReason,
  ) {
    const detail: Record<MatchNotReversibleReason, string> = {
      not_found: "was not found",
      not_participant: "was not played by the sanctioned player",
      not_scored: "is not closed with its scoring applied (finish it first)",
    };
    super(`Match ${matchId} ${detail[reason]}.`);
    this.name = "MatchNotReversibleError";
  }
}

export class SanctionConflictError extends Error {
  constructor(readonly sanctionId: string) {
    super(`Sanction ${sanctionId} already exists with different data.`);
    this.name = "SanctionConflictError";
  }
}

export class SanctionNotFoundError extends Error {
  constructor(readonly sanctionId: string) {
    super(`Sanction ${sanctionId} was not found.`);
    this.name = "SanctionNotFoundError";
  }
}
