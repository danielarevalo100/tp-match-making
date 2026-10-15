import type { QueueTicket } from "./queueTicket.js";

export class PlayerNotFoundError extends Error {
  constructor(playerId: string) {
    super(`Player ${playerId} was not found.`);
    this.name = "PlayerNotFoundError";
  }
}

export class AccountNotActiveError extends Error {
  constructor(readonly accountStatus: string) {
    super(`The account is ${accountStatus}; only active accounts can join a queue.`);
    this.name = "AccountNotActiveError";
  }
}

export class ModeNotAvailableError extends Error {
  constructor(mode: string) {
    super(`Game mode ${mode} does not exist or is not active.`);
    this.name = "ModeNotAvailableError";
  }
}

export class RegionNotFoundError extends Error {
  constructor(region: string) {
    super(`Region ${region} does not exist or is not active.`);
    this.name = "RegionNotFoundError";
  }
}

export class PlayerSanctionedError extends Error {
  constructor(
    readonly sanctionId: string,
    readonly sanctionType: string,
    readonly endsAt: Date | null,
  ) {
    super("The player has a sanction in force and cannot join a queue.");
    this.name = "PlayerSanctionedError";
  }
}

export class AlreadyInQueueError extends Error {
  constructor(readonly ticket: QueueTicket) {
    super(`The player is already in queue ${ticket.mode}/${ticket.region}.`);
    this.name = "AlreadyInQueueError";
  }
}

export class AlreadyInMatchError extends Error {
  constructor(readonly matchId: string) {
    super(`The player is already in match ${matchId}.`);
    this.name = "AlreadyInMatchError";
  }
}

export class TicketNotFoundError extends Error {
  constructor(playerId: string) {
    super(`Player ${playerId} is not in any queue.`);
    this.name = "TicketNotFoundError";
  }
}
