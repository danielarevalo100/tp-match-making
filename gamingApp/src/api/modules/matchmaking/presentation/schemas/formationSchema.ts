import { z } from "zod";

export const formMatchSchema = z
  .object({
    mode: z.string().trim().min(1).max(64),
    region: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .transform((value) => value.toUpperCase()),
  })
  .strict();

export const recoverFormationsSchema = z
  .object({ olderThanMs: z.number().int().min(0).max(3_600_000).optional() })
  .strict();
