import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { InjectedFailureError, StorageError } from "../shared/errors.js";
import {
  MatchCloseUnavailableError,
  MatchClosureConflictError,
  MatchClosureParticipantsError,
  MatchForClosureNotFoundError,
} from "./modules/matchClosure/business/models/matchClosureErrors.js";
import {
  MatchNotLiveError,
  PlayerNotInMatchError,
} from "./modules/matchEvents/business/models/matchEventErrors.js";
import {
  AccountNotActiveError,
  AlreadyInMatchError,
  AlreadyInQueueError,
  FormationContendedError,
  ModeNotAvailableError,
  PlayerNotFoundError as QueuePlayerNotFoundError,
  PlayerSanctionedError,
  RegionNotFoundError as QueueRegionNotFoundError,
  TicketNotFoundError,
} from "./modules/matchmaking/business/models/matchmakingErrors.js";
import {
  PlayerConflictError,
  PlayerNotFoundError,
  RegionNotFoundError,
} from "./modules/players/business/models/playerErrors.js";

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "VALIDATION_ERROR",
      issues: error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path.join("."),
      })),
    });
    return;
  }

  if (error instanceof PlayerNotFoundError || error instanceof QueuePlayerNotFoundError) {
    response.status(404).json({ error: "PLAYER_NOT_FOUND", message: error.message });
    return;
  }

  if (error instanceof TicketNotFoundError) {
    response.status(404).json({ error: "TICKET_NOT_FOUND", message: error.message });
    return;
  }

  if (error instanceof PlayerConflictError) {
    response.status(409).json({
      error: "PLAYER_CONFLICT",
      field: error.field,
      message: error.message,
    });
    return;
  }

  if (error instanceof RegionNotFoundError || error instanceof QueueRegionNotFoundError) {
    response.status(422).json({ error: "REGION_NOT_FOUND", message: error.message });
    return;
  }

  if (error instanceof AccountNotActiveError) {
    response.status(422).json({
      error: "ACCOUNT_NOT_ACTIVE",
      accountStatus: error.accountStatus,
      message: error.message,
    });
    return;
  }

  if (error instanceof ModeNotAvailableError) {
    response.status(422).json({ error: "MODE_NOT_AVAILABLE", message: error.message });
    return;
  }

  if (error instanceof PlayerSanctionedError) {
    response.status(403).json({
      error: "PLAYER_SANCTIONED",
      endsAt: error.endsAt,
      message: error.message,
      sanctionId: error.sanctionId,
      sanctionType: error.sanctionType,
    });
    return;
  }

  if (error instanceof AlreadyInQueueError) {
    response.status(409).json({
      error: "ALREADY_IN_QUEUE",
      message: error.message,
      ticket: error.ticket,
    });
    return;
  }

  if (error instanceof AlreadyInMatchError) {
    response.status(409).json({
      error: "ALREADY_IN_MATCH",
      matchId: error.matchId,
      message: error.message,
    });
    return;
  }

  if (error instanceof FormationContendedError) {
    response.status(409).json({ error: "FORMATION_CONTENDED", message: error.message });
    return;
  }

  if (error instanceof MatchNotLiveError) {
    response.status(404).json({ error: "MATCH_NOT_LIVE", message: error.message });
    return;
  }

  if (error instanceof MatchForClosureNotFoundError) {
    response.status(404).json({ error: "MATCH_NOT_FOUND", message: error.message });
    return;
  }

  if (error instanceof MatchClosureConflictError) {
    response.status(409).json({
      currentStatus: error.currentStatus,
      error: "MATCH_CLOSE_CONFLICT",
      matchId: error.matchId,
      message: error.message,
    });
    return;
  }

  if (error instanceof MatchClosureParticipantsError) {
    response.status(422).json({
      error: "INVALID_MATCH_RESULTS",
      message: error.message,
      reason: error.reason,
    });
    return;
  }

  if (error instanceof MatchCloseUnavailableError) {
    response.status(503).json({
      error: "MATCH_CLOSE_UNAVAILABLE",
      matchId: error.matchId,
      message: error.message,
    });
    return;
  }

  if (error instanceof PlayerNotInMatchError) {
    response.status(422).json({
      error: "PLAYER_NOT_IN_MATCH",
      message: error.message,
      playerId: error.playerId,
    });
    return;
  }

  if (error instanceof InjectedFailureError) {
    response.status(500).json({ error: "INJECTED_FAILURE", step: error.step });
    return;
  }

  if (error instanceof StorageError) {
    console.error(error, error.cause);
    response.status(503).json({ error: "STORAGE_ERROR", engine: error.engine, step: error.step });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
};
