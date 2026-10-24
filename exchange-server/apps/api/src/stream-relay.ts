import { encryptionSchema, envelopeSchema } from "./encrypted-envelope.js";
import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Services } from "./services.js";
import { point } from "./schema.js";
import { UnauthorizedException } from "@nestjs/common";

/** A refusal backed by evidence. Anything else is a failure to check, and the agent retries it. */
class Refused extends Error {}
const unauthorized = (error: unknown) => {
  throw error instanceof UnauthorizedException
    ? new Refused("Not signed in")
    : error;
};
const refusalCode = (path: string) =>
  path === "/ws/stream-agent" ? 4001 : 1008;

const tabId = z.string().min(1).max(200);
const position = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) };
const input = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("click"),
      ...position,
      button: z.enum(["left", "right"]),
      count: z.number().int().min(1).max(2),
    })
    .strict(),
  z.object({ action: z.literal("move"), ...position }).strict(),
  z
    .object({
      action: z.literal("scroll"),
      ...position,
      deltaX: z.number().min(-2000).max(2000),
      deltaY: z.number().min(-2000).max(2000),
    })
    .strict(),
  z
    .object({ action: z.literal("text"), text: z.string().min(1).max(4000) })
    .strict(),
  z
    .object({
      action: z.literal("key"),
      key: z.enum([
        "Backspace",
        "Tab",
        "Enter",
        "Escape",
        "Delete",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "a",
        "c",
        "v",
        "x",
        "z",
        "y",
      ]),
      modifiers: z.number().int().min(0).max(15),
    })
    .strict(),
  z
    .object({
      action: z.literal("navigate"),
      url: z
        .url()
        .max(4096)
        .refine((value) => {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        }),
    })
    .strict(),
  z.object({ action: z.enum(["reload", "back", "forward", "close"]) }).strict(),
]);
export const streamCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      type: z.literal("browser.command"),
      id: z.uuid(),
      action: z.literal("select"),
      tabId,
    })
    .strict(),
  z
    .object({
      type: z.literal("browser.command"),
      id: z.uuid(),
      action: z.literal("pause"),
    })
    .strict(),
  z
    .object({
      type: z.literal("browser.command"),
      id: z.uuid(),
      action: z.literal("input"),
      tabId,
      input,
    })
    .strict(),
]);
const stateSchema = z
  .object({
    type: z.literal("browser.state"),
    tabs: z
      .array(
        z
          .object({
            id: tabId,
            title: z.string().max(2000),
            url: z.string().max(16000),
            kind: z.enum(["chrome", "vscode"]).optional(),
          })
          .strict(),
      )
      .max(100),
    selected: tabId.nullable(),
    error: z.string().max(2000).optional(),
  })
  .strict();
const frameSchema = z
  .object({
    type: z.literal("browser.frame"),
    tabId,
    data: z
      .string()
      .min(4)
      .max(2_000_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    width: z.number().positive().max(32000),
    height: z.number().positive().max(32000),
  })
  .strict();
const resultSchema = z
  .object({
    type: z.literal("browser.result"),
    id: z.uuid(),
    ok: z.boolean(),
    error: z.string().max(2000).optional(),
  })
  .strict();
const send = (ws: WebSocket | undefined, value: unknown) => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (
    ((value as { type?: string; frame?: boolean })?.type === "browser.frame" ||
      (value as { frame?: boolean })?.frame === true) &&
    ws.bufferedAmount > 256_000
  )
    return;
  if (ws.bufferedAmount > 4_000_000) {
    ws.close(1013, "Client too slow");
    return;
  }
  ws.send(JSON.stringify(value));
};

/** Independent authenticated media transport. No frame history, no queue of stale images. */
export class StreamRelay {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 3_000_000,
  });
  private readonly agents = new Map<string, WebSocket>();
  private readonly viewers = new Map<string, Set<WebSocket>>();
  private readonly watching = new WeakSet<WebSocket>();
  private readonly states = new Map<string, unknown>();
  private readonly checks = new Map<WebSocket, () => Promise<boolean>>();
  private readonly pending = new Map<
    string,
    { viewer: WebSocket; pointId: string; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly alive = new WeakSet<WebSocket>();
  private readonly paths = new WeakMap<WebSocket, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly services: Services) {
    this.timer = setInterval(() => {
      for (const [ws, check] of this.checks) {
        if (!this.alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
        void check()
          .then((ok) => {
            if (!ok)
              ws.close(
                this.paths.get(ws) === "/ws/stream-browser" ? 1008 : 4001,
                "Access revoked",
              );
          })
          .catch((error) =>
            error instanceof Refused
              ? ws.close(
                  this.paths.get(ws) === "/ws/stream-browser" ? 1008 : 4001,
                  error.message,
                )
              : ws.close(1011, "Authentication unavailable"),
          );
      }
    }, 10000);
  }
  upgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
    path: string,
  ): void {
    this.server.handleUpgrade(request, socket, head, (ws) => {
      this.alive.add(ws);
      ws.on("pong", () => this.alive.add(ws));
      ws.on("error", () => ws.terminate());
      const timer = setTimeout(
        () => ws.close(1008, "Authentication timeout"),
        5000,
      );
      ws.once("message", (raw) => {
        clearTimeout(timer);
        this.paths.set(ws, path);
        void this.authenticate(ws, request, path, raw.toString()).catch(
          (error) =>
            error instanceof Refused
              ? ws.close(refusalCode(path), error.message)
              : ws.close(1011, "Authentication unavailable"),
        );
      });
    });
  }
  private notify(id: string): void {
    const count = [...(this.viewers.get(id) ?? [])].filter(ws => ws.readyState === WebSocket.OPEN && this.watching.has(ws)).length;
    const message = {
      type: "browser.viewers",
      active: count > 0,
      count,
    };
    send(this.agents.get(id), message);
    for (const viewer of this.viewers.get(id) ?? []) send(viewer, message);
  }
  private async authenticate(
    ws: WebSocket,
    request: IncomingMessage,
    path: string,
    raw: string,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Refused("Invalid handshake");
    }
    const result = z
      .object({
        type: z.literal("auth"),
        version: z.literal(1),
        pointId: z.uuid(),
        key: z.string().max(200).optional(),
        encryption: encryptionSchema.nullable().optional(),
        encrypted: z.boolean().optional(),
      })
      .strict()
      .safeParse(parsed);
    if (!result.success) throw new Refused("Invalid handshake");
    const hello = result.data;
    const agent = path === "/ws/stream-agent";
    const owner = agent
      ? undefined
      : await this.services.owner(request.headers).catch(unauthorized);
    if (agent && !hello.key) throw new Refused("Key required");
    const hash = agent
      ? createHash("sha256").update(hello.key!).digest("hex")
      : undefined;
    const permitted = async () => {
      if (
        !agent &&
        (await this.services.owner(request.headers).catch(unauthorized)) !==
          owner
      )
        return false;
      return (
        (
          await this.services.db
            .select({ id: point.id })
            .from(point)
            .where(
              and(
                eq(point.id, hello.pointId),
                owner ? eq(point.userId, owner) : eq(point.keyHash, hash!),
              ),
            )
        ).length > 0
      );
    };
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!(await permitted())) throw new Refused("Access denied");
    const id = hello.pointId;
    const [record] = await this.services.db
      .select({ encryption: point.encryption })
      .from(point)
      .where(eq(point.id, id));
    const encryption = record?.encryption ?? null;
    if (
      agent
        ? JSON.stringify(hello.encryption ?? null) !==
          JSON.stringify(encryption ? JSON.parse(encryption) : null)
        : Boolean(encryption) !== (hello.encrypted === true)
    ) {
      ws.close(agent ? 1011 : 1008, "Workspace encryption changed. Reload.");
      return;
    }
    this.checks.set(ws, permitted);
    if (agent) {
      this.agents.get(id)?.close(4001, "Connection replaced");
      this.agents.set(id, ws);
      this.states.delete(id);
    } else {
      const viewers = this.viewers.get(id) ?? new Set<WebSocket>();
      viewers.add(ws);
      this.viewers.set(id, viewers);
    }
    send(ws, {
      type: "ready",
      version: 1,
      online: this.agents.has(id),
      encryption: encryption ? JSON.parse(encryption) : null,
    });
    if (agent) {
      this.notify(id);
      for (const viewer of this.viewers.get(id) ?? [])
        send(viewer, { type: "browser.presence", online: true });
    } else if (this.states.has(id)) send(ws, this.states.get(id));
    let processing = Promise.resolve(),
      queued = 0;
    ws.on("message", (raw) => {
      if (encryption) {
        let value;
        try {
          value = JSON.parse(raw.toString());
        } catch {
          ws.close(1008, "Invalid encrypted packet");
          return;
        }
        if (agent || value.type !== "browser.watch") {
          if (++queued > 512) {
            ws.close(1013, "Too many packets");
            return;
          }
          processing = processing
            .then(async () => {
              if (!(await permitted())) throw new Error("Access revoked");
              const packet = envelopeSchema.parse(value);
              if (packet.epoch !== JSON.parse(encryption).epoch)
                throw new Error("Encryption changed");
              if (agent) {
                if (this.agents.get(id) !== ws) return;
                for (const viewer of this.viewers.get(id) ?? [])
                  send(viewer, packet);
              } else send(this.agents.get(id), packet);
            })
            .catch(() => ws.close(1008, "Invalid encrypted packet"))
            .finally(() => queued--);
          return;
        }
      }

      if (agent) {
        if (this.agents.get(id) !== ws) return;
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === "browser.frame") {
            const frame = frameSchema.parse(message);
            for (const viewer of this.viewers.get(id) ?? [])
              if (this.watching.has(viewer)) send(viewer, frame);
          } else if (message.type === "browser.state") {
            const state = stateSchema.parse(message);
            this.states.set(id, state);
            for (const viewer of this.viewers.get(id) ?? [])
              send(viewer, state);
          } else if (message.type === "browser.result") {
            const result = resultSchema.parse(message),
              pending = this.pending.get(result.id);
            if (pending?.pointId === id) {
              clearTimeout(pending.timer);
              this.pending.delete(result.id);
              send(pending.viewer, result);
            }
          } else if (message.type === "browser.error") {
            const error = z.string().max(2000).parse(message.error);
            for (const viewer of this.viewers.get(id) ?? [])
              send(viewer, { type: "browser.error", error });
          } else throw new Error("Invalid stream event");
        } catch {
          ws.close(4400, "Invalid stream event");
        }
        return;
      }
      if (++queued > 512) {
        ws.close(1013, "Too many commands");
        return;
      }
      processing = processing
        .then(async () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!(await permitted())) {
            ws.close(4001, "Access revoked");
            return;
          }
          const message = JSON.parse(raw.toString());
          if (message.type === "browser.watch") {
            const watch = z
              .object({ type: z.literal("browser.watch"), active: z.boolean() })
              .strict()
              .parse(message);
            if (watch.active) this.watching.add(ws);
            else this.watching.delete(ws);
            if (this.agents.has(id)) this.notify(id);
            return;
          }
          const command = streamCommandSchema.parse(message),
            target = this.agents.get(id);
          if (
            !this.watching.has(ws) ||
            !target ||
            target.readyState !== WebSocket.OPEN
          ) {
            send(ws, {
              type: "browser.result",
              id: command.id,
              ok: false,
              error: "Remote browser is offline",
            });
            return;
          }
          if (this.pending.has(command.id) || this.pending.size >= 256) {
            send(ws, {
              type: "browser.result",
              id: command.id,
              ok: false,
              error: "Wait for pending browser actions",
            });
            return;
          }
          const timer = setTimeout(() => {
            this.pending.delete(command.id);
            send(ws, {
              type: "browser.result",
              id: command.id,
              ok: false,
              error:
                "Browser action timed out. Check the page before retrying.",
            });
          }, 15000);
          this.pending.set(command.id, { viewer: ws, pointId: id, timer });
          send(target, command);
        })
        .catch(() => ws.close(1008, "Invalid browser command"))
        .finally(() => queued--);
    });
    ws.on("close", () => {
      this.checks.delete(ws);
      this.watching.delete(ws);
      const wasAgent = this.agents.get(id) === ws;
      if (wasAgent) {
        this.agents.delete(id);
        this.states.delete(id);
        for (const viewer of this.viewers.get(id) ?? [])
          send(viewer, { type: "browser.presence", online: false });
      }
      this.viewers.get(id)?.delete(ws);
      if (this.viewers.get(id)?.size === 0) this.viewers.delete(id);
      if (this.agents.has(id)) this.notify(id);
      for (const [key, item] of this.pending)
        if (item.viewer === ws || (wasAgent && item.pointId === id)) {
          clearTimeout(item.timer);
          this.pending.delete(key);
          if (item.viewer !== ws)
            send(item.viewer, {
              type: "browser.result",
              id: key,
              ok: false,
              error: "Browser disconnected",
            });
        }
    });
  }
  disconnectPoint(id: string): void {
    this.agents.get(id)?.close(4001, "Access revoked");
    for (const ws of this.viewers.get(id) ?? [])
      ws.close(4001, "Access revoked");
    this.states.delete(id);
  }
  dispose(): void {
    clearInterval(this.timer);
    for (const item of this.pending.values()) clearTimeout(item.timer);
    for (const ws of this.server.clients) ws.terminate();
    this.server.close();
  }
}
