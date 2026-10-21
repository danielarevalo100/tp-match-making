import { z } from "zod";

// Mode, season and region become part of Redis keys and MongoDB field paths, so only catalog-like
// identifiers are accepted.
const modeSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);
const seasonIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,32}$/);

export const leaderboardParamsSchema = z.object({ mode: modeSchema, seasonId: seasonIdSchema }).strict();

export const playerPositionParamsSchema = z
  .object({ mode: modeSchema, playerId: z.string().uuid(), seasonId: seasonIdSchema })
  .strict();

export const leaderboardQuerySchema = z
  .object({
    region: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{1,32}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
  })
  .strict();
