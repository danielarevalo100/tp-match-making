import { z } from "zod";

import { defaultProfileMatches, maxProfileMatches } from "../../business/models/playerProfile.js";
import { sanctionTypes } from "../../business/models/sanction.js";

// Bounds the work of one reversal: every match holds and republishes its players atomically.
const maxMatchesPerSanction = 100;

const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const sanctionParamsSchema = z.object({ sanctionId: z.string().uuid() }).strict();

export const createSanctionSchema = z
  .object({
    administratorId: z.string().uuid(),
    description: z.string().trim().min(1).max(2_000).optional(),
    /** null or absent: permanent. */
    endsAt: isoDate.nullable().optional(),
    matchIds: z
      .array(z.string().uuid())
      .min(1)
      .max(maxMatchesPerSanction)
      .refine((ids) => new Set(ids).size === ids.length, "matchIds must not repeat a match"),
    playerId: z.string().uuid(),
    reason: z.string().trim().min(1).max(200).default("cheating"),
    reportId: z.string().uuid().nullable().optional(),
    sanctionId: z.string().uuid(),
    startsAt: isoDate.optional(),
    type: z.enum(sanctionTypes),
  })
  .strict()
  .refine(
    (body) => !body.endsAt || !body.startsAt || body.endsAt.getTime() > body.startsAt.getTime(),
    { message: "endsAt must be after startsAt", path: ["endsAt"] },
  );

export const profileParamsSchema = z.object({ playerId: z.string().uuid() }).strict();

export const profileQuerySchema = z
  .object({
    matches: z.coerce.number().int().min(1).max(maxProfileMatches).default(defaultProfileMatches),
  })
  .strict();
