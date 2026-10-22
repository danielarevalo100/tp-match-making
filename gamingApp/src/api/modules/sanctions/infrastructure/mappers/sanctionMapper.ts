import type {
  ReversalJournal,
  SanctionRecord,
  SanctionStatus,
  SanctionType,
} from "../../business/models/sanction.js";

/** Documento de `sanctions` (ver infra/mongo/init.js). `adminId` conserva el nombre original del campo. */
export type SanctionDocument = {
  _id: string;
  adminId: string;
  createdAt: Date;
  description?: string;
  endsAt: Date | null;
  matchIds?: readonly string[];
  playerId: string;
  reason: string;
  reportId?: string | null;
  reversal?: ReversalJournal;
  startsAt: Date;
  status: SanctionStatus;
  type: SanctionType;
};

export function toSanctionRecord(document: SanctionDocument): SanctionRecord {
  return {
    administratorId: document.adminId,
    createdAt: document.createdAt,
    description: document.description ?? null,
    endsAt: document.endsAt,
    id: document._id,
    matchIds: document.matchIds ?? [],
    playerId: document.playerId,
    reason: document.reason,
    reportId: document.reportId ?? null,
    // Las sanciones escritas antes del problema 8 (o por la demo del problema 1) no anulan
    // partidas: se leen como una reversión sin nada que hacer.
    reversal: document.reversal ?? {
      attempts: 0,
      completedAt: document.createdAt,
      completedSteps: [],
      heldBoards: [],
      lastError: null,
      revertedMatchIds: [],
      status: "completed",
      updatedAt: document.createdAt,
    },
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
    matchIds: record.matchIds,
    playerId: record.playerId,
    reason: record.reason,
    reportId: record.reportId,
    reversal: record.reversal,
    startsAt: record.startsAt,
    status: record.status,
    type: record.type,
  };
}
