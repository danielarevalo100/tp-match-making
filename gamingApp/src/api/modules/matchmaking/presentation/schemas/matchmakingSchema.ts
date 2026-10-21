import { z } from "zod";

export const enqueueSchema = z
  .object({
    mode: z.string().trim().min(1).max(64),
    playerId: z.string().uuid(),
    region: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .transform((value) => value.toUpperCase())
      .optional(),
    ticketId: z.string().uuid().optional(),
  })
  .strict();

export const playerIdParamSchema = z.object({ playerId: z.string().uuid() }).strict();
