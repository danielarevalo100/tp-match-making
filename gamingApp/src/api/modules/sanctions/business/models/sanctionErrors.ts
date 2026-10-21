import { AppError } from "../../../../../shared/errors.js";

export class SanctionPlayerNotFoundError extends AppError {
  constructor(readonly playerId: string) {
    super(404, "PLAYER_NOT_FOUND", `Player ${playerId} was not found.`);
  }
}

export class AdministratorNotFoundError extends AppError {
  constructor(readonly administratorId: string) {
    super(404, "ADMINISTRATOR_NOT_FOUND", `Administrator ${administratorId} was not found.`, {
      administratorId,
    });
  }
}

export class AdministratorNotActiveError extends AppError {
  constructor(readonly administratorId: string) {
    super(
      422,
      "ADMINISTRATOR_NOT_ACTIVE",
      `Administrator ${administratorId} is not active and cannot sanction players.`,
      { administratorId },
    );
  }
}

export class InvalidSanctionReportError extends AppError {
  constructor(
    readonly reportId: string,
    readonly reason: "not_found" | "other_player",
  ) {
    super(
      422,
      "INVALID_SANCTION_REPORT",
      reason === "not_found"
        ? `Report ${reportId} was not found.`
        : `Report ${reportId} is about another player.`,
      { reason, reportId },
    );
  }
}

export type MatchNotReversibleReason = "not_found" | "not_participant" | "not_scored";

const notReversibleDetail: Record<MatchNotReversibleReason, string> = {
  not_found: "was not found",
  not_participant: "was not played by the sanctioned player",
  not_scored: "is not closed with its scoring applied (finish it first)",
};

export class MatchNotReversibleError extends AppError {
  constructor(
    readonly matchId: string,
    readonly reason: MatchNotReversibleReason,
  ) {
    super(422, "MATCH_NOT_REVERSIBLE", `Match ${matchId} ${notReversibleDetail[reason]}.`, {
      matchId,
      reason,
    });
  }
}

export class SanctionConflictError extends AppError {
  constructor(readonly sanctionId: string) {
    super(409, "SANCTION_CONFLICT", `Sanction ${sanctionId} already exists with different data.`, {
      sanctionId,
    });
  }
}

export class SanctionNotFoundError extends AppError {
  constructor(readonly sanctionId: string) {
    super(404, "SANCTION_NOT_FOUND", `Sanction ${sanctionId} was not found.`, { sanctionId });
  }
}
