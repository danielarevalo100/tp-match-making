import { z } from "zod";

import { matchEventTypes } from "../../business/models/matchEvent.js";

const maxDetailBytes = 2_048;
// Largest value a JavaScript Date can hold.
const maxTsMs = 8_640_000_000_000_000;

export const matchIdParamSchema = z.object({ matchId: z.string().uuid() }).strict();

export const recordEventSchema = z
  .object({
    detail: z
      .record(z.string(), z.unknown())
      .refine(
        (value) => Buffer.byteLength(JSON.stringify(value)) <= maxDetailBytes,
        `detail must be at most ${String(maxDetailBytes)} bytes of JSON.`,
      )
      .optional(),
    eventId: z.string().uuid(),
    playerId: z.string().uuid(),
    points: z.number().int().min(1).max(1_000).optional(),
    targetPlayerId: z.string().uuid().optional(),
    // Required (not defaulted to "now"): a retry must carry the same timestamp or it would be a
    // different row in the log.
    tsMs: z.number().int().min(1).max(maxTsMs),
    type: z.enum(matchEventTypes),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.type === "kill") {
      if (event.targetPlayerId === undefined) {
        context.addIssue({
          code: "custom",
          message: "A kill needs targetPlayerId.",
          path: ["targetPlayerId"],
        });
      } else if (event.targetPlayerId === event.playerId) {
        context.addIssue({
          code: "custom",
          message: "A player cannot kill themselves.",
          path: ["targetPlayerId"],
        });
      }
    } else if (event.targetPlayerId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "targetPlayerId is only valid for a kill.",
        path: ["targetPlayerId"],
      });
    }
    if (event.points !== undefined && event.type !== "objective") {
      context.addIssue({
        code: "custom",
        message: "points is only valid for an objective.",
        path: ["points"],
      });
    }
  });

export const listEventsSchema = z
  .object({
    fromTsMs: z.coerce.number().int().min(0).max(maxTsMs).optional(),
    limit: z.coerce.number().int().min(1).max(1_000).default(100),
    pageState: z
      .string()
      .regex(/^[0-9a-f]+$/)
      .max(1_024)
      .optional(),
    toTsMs: z.coerce.number().int().min(0).max(maxTsMs).optional(),
  })
  .strict();
