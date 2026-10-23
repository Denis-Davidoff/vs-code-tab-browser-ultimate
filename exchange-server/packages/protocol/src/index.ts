import { z } from "zod";
export const PROTOCOL_VERSION = 1;
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
