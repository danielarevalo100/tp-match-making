import { MongoServerError } from "mongodb";

import type {
  HeldBoard,
  ReversalJournal,
  ReversalStatus,
  ReversalStep,
  SanctionRecord,
  SanctionStatus,
  SanctionType,
} from "../../business/models/sanction.js";

export type ReversalDocument = {
  attempts: number;
  completedAt: Date | null;
  completedSteps: ReversalStep[];
  heldBoards: HeldBoard[];
  lastError: string | null;
  revertedMatchIds: string[];
  status: ReversalStatus;
  updatedAt: Date;
};

/** `sanctions` document (see infra/mongo/init.js). `adminId` keeps the original field name. */
export type SanctionDocument = {
  _id: string;
  adminId: string;
  createdAt: Date;
  description?: string;
  endsAt: Date | null;
  matchIds?: string[];
  playerId: string;
  reason: string;
  reportId?: string | null;
  reversal?: ReversalDocument;
  startsAt: Date;
  status: SanctionStatus;
  type: SanctionType;
};

/**
 * Sanctions written before problem 8 (or by the problem 1 demo) void no match: they are read as a
 * reversal with nothing to do.
 */
function journalOf(document: SanctionDocument): ReversalJournal {
  const reversal = document.reversal;
  if (!reversal) {
    return {
      attempts: 0,
      completedAt: document.createdAt,
      completedSteps: [],
      heldBoards: [],
      lastError: null,
      revertedMatchIds: [],
      status: "completed",
      updatedAt: document.createdAt,
    };
  }
  return {
    attempts: reversal.attempts,
    completedAt: reversal.completedAt,
    completedSteps: [...reversal.completedSteps],
    heldBoards: reversal.heldBoards.map((board) => ({ ...board, playerIds: [...board.playerIds] })),
    lastError: reversal.lastError,
    revertedMatchIds: [...reversal.revertedMatchIds],
    status: reversal.status,
    updatedAt: reversal.updatedAt,
  };
}

export function toSanctionRecord(document: SanctionDocument): SanctionRecord {
  return {
    administratorId: document.adminId,
    createdAt: document.createdAt,
    description: document.description ?? null,
    endsAt: document.endsAt,
    id: document._id,
    matchIds: [...(document.matchIds ?? [])],
    playerId: document.playerId,
    reason: document.reason,
    reportId: document.reportId ?? null,
    reversal: journalOf(document),
    startsAt: document.startsAt,
    status: document.status,
    type: document.type,
  };
}

export function toSanctionDocument(record: SanctionRecord): SanctionDocument {
  return {
    _id: record.id,
    adminId: record.administratorId,
    createdAt: record.createdAt,
    ...(record.description === null ? {} : { description: record.description }),
    endsAt: record.endsAt,
    matchIds: [...record.matchIds],
    playerId: record.playerId,
    reason: record.reason,
    reportId: record.reportId,
    reversal: {
      attempts: record.reversal.attempts,
      completedAt: record.reversal.completedAt,
      completedSteps: [...record.reversal.completedSteps],
      heldBoards: record.reversal.heldBoards.map((board) => ({
        ...board,
        playerIds: [...board.playerIds],
      })),
      lastError: record.reversal.lastError,
      revertedMatchIds: [...record.reversal.revertedMatchIds],
      status: record.reversal.status,
      updatedAt: record.reversal.updatedAt,
    },
    startsAt: record.startsAt,
    status: record.status,
    type: record.type,
  };
}

export function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}
