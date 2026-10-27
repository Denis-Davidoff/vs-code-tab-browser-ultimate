import { z } from "zod";
export const PROTOCOL_VERSION = 1;
/**
 * Features a relay announces in its `ready`. `patch`: it carries `chat.patch`
 * and `chat.resync`, so an agent may send patches of the view between whole
 * snapshots (and number its snapshots). An agent seeing no list sends whole
 * snapshots only, so a newer agent works with an older relay.
 */
export const RELAY_FEATURES = ["patch"] as const;
export const createPointSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();
const uiMessageSchema = z.object({type:z.string().min(1).max(80)}).passthrough();
export const commandSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal('chat.pin'),id:z.uuid(),chatId:z.string().min(1).max(100)}).strict(),
  z.object({type:z.literal('chat.command'),id:z.uuid(),chatId:z.string().min(1).max(100),message:uiMessageSchema,attachments:z.array(z.record(z.string(),z.unknown())).max(8).optional()}).strict(),
  z
    .object({
      type: z.literal("chat.send"),
      id: z.uuid(),
      chatId: z.string().min(1).max(200),
      text: z
        .string()
        .min(1)
        .max(64000)
        .refine((text) => text.trim().length > 0),
    })
    .strict(),
  // The website lost the thread of patches and asks for a whole snapshot.
  z.object({type:z.literal("chat.resync"),id:z.uuid(),chatId:z.string().min(1).max(200)}).strict(),
  z
    .object({
      type: z.literal("chat.stop"),
      id: z.uuid(),
      chatId: z.string().min(1).max(200),
    })
    .strict(),
]);
export type RemoteCommand = z.infer<typeof commandSchema>;
export interface ExchangePoint {
  id: string;
  name: string;
  createdAt: string;
}

export const snapshotSchema = z
  .object({
    type: z.literal("chat.snapshot"),
    uiVersion: z.literal(1).optional(),
    epoch: z.string().min(1).max(64).optional(),
    rev: z.number().int().nonnegative().optional(),
    view: z.record(z.string(),z.unknown()).optional(),
    chatId: z.string().min(1).max(200),
    running: z.boolean(),
    messages: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            role: z.enum(["user", "assistant", "system"]),
            text: z.string().max(64000),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const agentMessageSchema = z.discriminatedUnion("type", [
  snapshotSchema,
  // The view's changes since snapshot or patch `base` (see the extension's core/sync.ts); never cached.
  z.object({type:z.literal("chat.patch"),chatId:z.string().min(1).max(200),epoch:z.string().min(1).max(64),base:z.number().int().nonnegative(),rev:z.number().int().positive(),patch:z.record(z.string(),z.unknown()),top:z.record(z.string(),z.unknown())}).strict(),
  z.object({type:z.literal("chat.event"),chatId:z.string().min(1).max(100),message:uiMessageSchema}).strict(),
  z
    .object({
      type: z.literal("command.result"),
      id: z.uuid(),
      ok: z.boolean(),
      error: z.string().max(1000).optional(),
    })
    .strict(),
]);
export type ChatSnapshot = z.infer<typeof snapshotSchema>;
