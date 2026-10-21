import type { QueueTicket } from "../../business/models/queueTicket.js";

export function toQueueTicket(fields: Record<string, string>): QueueTicket | null {
  const { enqueuedAt, mmr, mode, playerId, region, ticketId } = fields;
  if (!enqueuedAt || !mmr || !mode || !playerId || !region || !ticketId) return null;
  return {
    enqueuedAt: Number(enqueuedAt),
    mmr: Number(mmr),
    mode,
    playerId,
    region,
    ticketId,
  };
}

export function flatToRecord(flat: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let index = 0; index + 1 < flat.length; index += 2) {
    record[flat[index] as string] = flat[index + 1] as string;
  }
  return record;
}
