import { z } from "zod";

import { accountStatuses } from "../../../domain/entities/player.js";

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9_-]+$/, "Username may contain lowercase letters, numbers, _ and -.");

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const countrySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const avatarUrlSchema = z.string().trim().url().max(2_048);

const birthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Birth date must use YYYY-MM-DD.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "Birth date must be a valid calendar date.")
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

export const registerPlayerSchema = z
  .object({
    avatarUrl: avatarUrlSchema.optional(),
    birthDate: birthDateSchema.optional(),
    country: countrySchema,
    email: emailSchema,
    password: z.string().min(8).max(128),
    username: usernameSchema,
  })
  .strict();

export const updatePlayerProfileSchema = z
  .object({
    avatarUrl: avatarUrlSchema.nullable().optional(),
    birthDate: birthDateSchema.nullable().optional(),
    country: countrySchema.optional(),
    email: emailSchema.optional(),
    username: usernameSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");

export const updatePlayerStatusSchema = z
  .object({ status: z.enum(accountStatuses) })
  .strict();

export const playerIdSchema = z.object({ playerId: z.string().uuid() }).strict();

export const listPlayersSchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
