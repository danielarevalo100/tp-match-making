import { z } from "zod";

import { finishReasons, playerResults } from "../../business/models/matchClosure.js";

const maxTsMs = 8_640_000_000_000_000;

export const finishMatchParamsSchema = z.object({ matchId: z.string().uuid() }).strict();

export const finishMatchSchema = z
  .object({
    closureId: z.string().uuid(),
    eventId: z.string().uuid(),
    reason: z.enum(finishReasons),
    results: z
      .array(
        z
          .object({
            playerId: z.string().uuid(),
            result: z.enum(playerResults),
          })
          .strict(),
      )
      .min(2)
      .max(256),
    tsMs: z.number().int().min(1).max(maxTsMs),
  })
  .strict();
