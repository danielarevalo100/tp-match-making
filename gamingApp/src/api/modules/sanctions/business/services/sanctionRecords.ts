import type { SanctionInput, SanctionRecord, SanctionView } from "../models/sanction.js";
import { SanctionConflictError } from "../models/sanctionErrors.js";

/** Sanción nueva, en vigor desde `startsAt` (o ahora) y con la reversión pendiente. */
export function newSanction(input: SanctionInput, now: Date): SanctionRecord {
  return {
    administratorId: input.administratorId,
    createdAt: now,
    description: input.description,
    endsAt: input.endsAt,
    id: input.sanctionId,
    matchIds: [...input.matchIds],
    playerId: input.playerId,
    reason: input.reason,
    reportId: input.reportId,
    reversal: {
      attempts: 0,
      completedAt: null,
      completedSteps: [],
      heldBoards: [],
      lastError: null,
      revertedMatchIds: [],
      status: "pending",
      updatedAt: now,
    },
    startsAt: input.startsAt ?? now,
    status: "active",
    type: input.type,
  };
}

/** Un reintento tiene que describir la misma sanción; si no, el id se está reusando por error. */
export function assertSameSanction(record: SanctionRecord, input: SanctionInput): void {
  const sortedIds = (ids: readonly string[]): string => JSON.stringify([...ids].sort());
  const same =
    record.playerId === input.playerId &&
    record.administratorId === input.administratorId &&
    record.type === input.type &&
    record.reportId === input.reportId &&
    (record.endsAt?.getTime() ?? null) === (input.endsAt?.getTime() ?? null) &&
    sortedIds(record.matchIds) === sortedIds(input.matchIds);
  if (!same) throw new SanctionConflictError(record.id);
}

/** Cómo queda el registro al completar la reversión (si no se pudo releer de Mongo). */
export function completedCopy(record: SanctionRecord): SanctionRecord {
  return {
    ...record,
    reversal: {
      ...record.reversal,
      completedAt: new Date(),
      completedSteps: ["queue", "hold", "leaderboard"],
      lastError: null,
      revertedMatchIds: [...record.matchIds],
      status: "completed",
    },
  };
}

/** Respuesta de la API: la sanción y el avance de la reversión. */
export function toView(record: SanctionRecord): SanctionView {
  const reverted = new Set(record.reversal.revertedMatchIds);
  return {
    administratorId: record.administratorId,
    createdAt: record.createdAt,
    description: record.description,
    endsAt: record.endsAt,
    matchIds: record.matchIds,
    playerId: record.playerId,
    reason: record.reason,
    reportId: record.reportId,
    reversal: {
      attempts: record.reversal.attempts,
      completedAt: record.reversal.completedAt,
      completedSteps: record.reversal.completedSteps,
      lastError: record.reversal.lastError,
      pendingMatchIds: record.matchIds.filter((matchId) => !reverted.has(matchId)),
      revertedMatchIds: record.reversal.revertedMatchIds,
      status: record.reversal.status,
    },
    sanctionId: record.id,
    startsAt: record.startsAt,
    status: record.status,
    type: record.type,
  };
}
