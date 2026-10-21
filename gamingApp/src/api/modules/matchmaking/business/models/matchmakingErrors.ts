import { AppError } from "../../../../../shared/errors.js";
import type { QueueTicket } from "./queueTicket.js";

export class PlayerNotFoundError extends AppError {
  constructor(playerId: string) {
    super(404, "PLAYER_NOT_FOUND", `Player ${playerId} was not found.`);
  }
}

export class AccountNotActiveError extends AppError {
  constructor(readonly accountStatus: string) {
    super(
      422,
      "ACCOUNT_NOT_ACTIVE",
      `The account is ${accountStatus}; only active accounts can join a queue.`,
      { accountStatus },
    );
  }
}

export class ModeNotAvailableError extends AppError {
  constructor(mode: string) {
    super(422, "MODE_NOT_AVAILABLE", `Game mode ${mode} does not exist or is not active.`);
  }
}

export class RegionNotFoundError extends AppError {
  constructor(region: string) {
    super(422, "REGION_NOT_FOUND", `Region ${region} does not exist or is not active.`);
  }
}

export class PlayerSanctionedError extends AppError {
  constructor(
    readonly sanctionId: string,
    readonly sanctionType: string,
    readonly endsAt: Date | null,
  ) {
    super(403, "PLAYER_SANCTIONED", "The player has a sanction in force and cannot join a queue.", {
      endsAt,
      sanctionId,
      sanctionType,
    });
  }
}

export class AlreadyInQueueError extends AppError {
  constructor(readonly ticket: QueueTicket) {
    const message = `The player is already in queue ${ticket.mode}/${ticket.region}.`;
    super(409, "ALREADY_IN_QUEUE", message, { ticket });
  }
}

export class AlreadyInMatchError extends AppError {
  constructor(readonly matchId: string) {
    super(409, "ALREADY_IN_MATCH", `The player is already in match ${matchId}.`, { matchId });
  }
}

export class TicketNotFoundError extends AppError {
  constructor(playerId: string) {
    super(404, "TICKET_NOT_FOUND", `Player ${playerId} is not in any queue.`);
  }
}

export class FormationContendedError extends AppError {
  constructor(mode: string, region: string) {
    super(
      409,
      "FORMATION_CONTENDED",
      `Could not reserve a group in ${mode}/${region}: players kept leaving the queue.`,
    );
  }
}
