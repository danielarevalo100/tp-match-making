import { z } from "zod";

const days = z.coerce.number().int().min(1).max(365).default(30);

const matchFixingFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  minBenefitRatio: z.coerce.number().min(0.5).max(1).default(1),
  minMatches: z.coerce.number().int().min(2).max(1_000).default(5),
  mode: z.string().trim().min(1).max(64).optional(),
};

const crossReportFields = {
  minReporters: z.coerce.number().int().min(2).max(50).default(3),
  windowMinutes: z.coerce.number().int().min(1).max(10_080).default(60),
};

export const matchFixingQuerySchema = z.object({ days, ...matchFixingFields }).strict();

export const crossReportsQuerySchema = z.object({ days, ...crossReportFields }).strict();

export const irregularBehaviorQuerySchema = z
  .object({ days, ...matchFixingFields, ...crossReportFields })
  .strict();

export const projectGraphSchema = z
  .object({
    afterId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100_000).default(10_000),
    since: z.iso
      .datetime()
      .transform((value) => new Date(value))
      .optional(),
  })
  .strict();
