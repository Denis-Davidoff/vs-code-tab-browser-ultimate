import { z } from "zod";
export const encryptionSchema = z
  .object({
    version: z.literal(1),
    salt: z.string().length(24),
    epoch: z.uuid(),
    check: z.string().max(200),
    iv: z.string().length(16),
  })
  .strict();
export const envelopeSchema = z
  .object({
    type: z.literal("secure"),
    version: z.literal(1),
    epoch: z.uuid(),
    sender: z.uuid(),
    seq: z.number().int().positive().safe(),
    frame: z.boolean(),
    iv: z.string().length(16),
    data: z
      .string()
      .min(16)
      .max(11_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
