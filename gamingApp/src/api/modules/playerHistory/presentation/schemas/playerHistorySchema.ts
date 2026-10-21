import { z } from "zod";

export const playerHistoryParamsSchema = z.object({ playerId: z.string().uuid() }).strict();

export const projectHistorySchema = z
  .object({
    afterId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100_000).default(10_000),
    since: z.iso
      .datetime()
      .transform((value) => new Date(value))
      .optional(),
  })
  .strict();
