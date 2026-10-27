import { originChecksDisabled } from "./origin-policy.js";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Server, IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { and, eq } from "drizzle-orm";
import {
  agentMessageSchema,
  commandSchema,
  PROTOCOL_VERSION,
  RELAY_FEATURES,
} from "@exchange/protocol";
import { Services } from "./services.js";
import { requestIdentity } from "./security/audit.js";
import { point } from "./schema.js";
import { StreamRelay } from "./stream-relay.js";
import { encryptionSchema, envelopeSchema } from "./encrypted-envelope.js";
const MAX_BUFFER = 16 * 1024 * 1024;
/**
 * Agent close codes. The VS Code client stops for good only on AGENT_REFUSED;
 * everything else is transient and it reconnects. 1008 stays the browser's code.
 */
export const AGENT_REFUSED = 4001;
export const AGENT_INVALID_MESSAGE = 4400;
/** A refusal on the evidence (wrong key, unknown point), as opposed to a failure on the way. */
class Refused extends Error {}
function refuse(ws: WebSocket, path: string, reason: string) {
  ws.close(path === "/ws/agent" ? AGENT_REFUSED : 1008, reason);
}
function send(socket: WebSocket | undefined, value: unknown) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFER) {
    socket.close(1013, "Client too slow");
    return;
  }
  socket.send(JSON.stringify(value));
}
/**
 * The VS Code machine's public address, for display on its connection card. Behind
 * the local proxy (Caddy, possibly behind Cloudflare) the socket peer is loopback,
 * so the proxy's headers name the client; a direct connection uses the peer.
 * Display only: never used to authorise anything.
 */
export function clientAddress(request: IncomingMessage): string | undefined {
  const peer = request.socket.remoteAddress?.replace(/^::ffff:/, "");
  const proxied = !peer || peer === "127.0.0.1" || peer === "::1";
  const header = (name: string) => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
  };
  const found = proxied
    ? (header("cf-connecting-ip") ??
      header("x-real-ip") ??
      header("x-forwarded-for"))
    : peer;
  const clean = found?.replace(/^::ffff:/, "");
  return clean && /^[0-9a-fA-F.:]{2,45}$/.test(clean) ? clean : undefined;
}
@Injectable()
export class Relay {
  private readonly agents = new Map<string, WebSocket>();
  private readonly agentAddresses = new Map<string, string>();
  private readonly viewers = new Map<string, Set<WebSocket>>();
  private readonly viewerPresence = new WeakSet<WebSocket>();
  private readonly snapshots = new Map<string, unknown>();
  private readonly pending = new Map<
    string,
    { viewer: WebSocket; pointId: string; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly sessions = new Map<WebSocket, () => Promise<void>>();
  private server?: WebSocketServer;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly streams: StreamRelay;
  constructor(@Inject(Services) private readonly services: Services) {
    this.streams = new StreamRelay(services);
  }
  address(id: string) {
    return this.online(id) ? this.agentAddresses.get(id) : undefined;
  }
  online(id: string) {
    return this.agents.get(id)?.readyState === WebSocket.OPEN;
  }
  attach(http: Server) {
    const server = (this.server = new WebSocketServer({
      noServer: true,
      maxPayload: 12 * 1024 * 1024,
    }));
    const alive = new WeakSet<WebSocket>();
    server.on("connection", (socket) => {
      alive.add(socket);
      socket.on("pong", () => alive.add(socket));
      socket.on("error", () => socket.terminate());
    });
    this.heartbeat = setInterval(() => {
      for (const check of this.sessions.values()) {
        void check();
      }
      for (const socket of server.clients) {
        if (!alive.has(socket)) {
          socket.terminate();
          continue;
        }
        alive.delete(socket);
        socket.ping();
      }
    }, 30000);
    http.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/ws/stream-agent" || path === "/ws/stream-browser") {
        if (
          !originChecksDisabled() &&
          path === "/ws/stream-browser" &&
          request.headers.origin !== process.env.WEB_ORIGIN
        ) {
          socket.destroy();
          return;
        }
        this.streams.upgrade(request, socket, head, path);
        return;
      }
      if (path !== "/ws/agent" && path !== "/ws/browser") {
        socket.destroy();
        return;
      }
      if (
        !originChecksDisabled() &&
        path === "/ws/browser" &&
        request.headers.origin !== process.env.WEB_ORIGIN
      ) {
        socket.destroy();
        return;
      }
      server.handleUpgrade(request, socket, head, (ws) => {
        server.emit("connection", ws, request);
        const timeout = setTimeout(
          () => ws.close(1008, "Authentication timeout"),
          5000,
        );
        ws.once("message", (raw) => {
          clearTimeout(timeout);
          void this.authenticate(ws, request, path, raw.toString()).catch(
            (error) => {
              this.services.audit.background(
                this.services.audit.record({
                  ...requestIdentity(request),
                  event: "connection.denied",
                  outcome: error instanceof Refused ? "denied" : "error",
                  reason: path === "/ws/agent" ? "agent_auth" : "viewer_auth",
                }),
              );
              return (
                // A database or session-store failure is transient: 1011 lets the client retry.
                error instanceof Refused
                  ? refuse(ws, path, "Authentication failed")
                  : ws.close(1011, "Authentication unavailable")
              );
            },
          );
        });
      });
    });
  }
  private async authenticate(
    ws: WebSocket,
    request: IncomingMessage,
    path: string,
    raw: string,
  ) {
    let hello;
    try {
      hello = JSON.parse(raw);
    } catch {
      throw new Refused("Invalid handshake");
    }
    if (
      !hello ||
      typeof hello !== "object" ||
      hello.type !== "auth" ||
      hello.version !== PROTOCOL_VERSION ||
      typeof hello.pointId !== "string"
    )
      throw new Refused("Invalid handshake");
    let authSessionId: string | undefined;
    let userId: string | undefined, keyHash: string | undefined;
    if (path === "/ws/agent") {
      if (typeof hello.key !== "string" || hello.key.length > 200)
        throw new Refused("Invalid key");
      keyHash = createHash("sha256").update(hello.key).digest("hex");
    } else
      userId = await this.services
        .identity(request.headers)
        .then((identity) => {
          authSessionId = identity.sessionId;
          return identity.userId;
        })
        .catch((error) => {
          throw error instanceof UnauthorizedException
            ? new Refused("Not signed in")
            : error;
        });
    const viewerId =
      typeof hello.viewerId === "string" &&
      /^[a-zA-Z0-9-]{1,100}$/.test(hello.viewerId)
        ? hello.viewerId
        : "legacy";
    const permitted = async () => {
      if (
        userId &&
        !(await this.services.plugins.viewer(
          userId,
          authSessionId!,
          hello.pointId,
          viewerId,
        ))
      )
        return [];
      return this.services.db
        .select({
          id: point.id,
          userId: point.userId,
          encryption: point.encryption,
        })
        .from(point)
        .where(
          and(
            eq(point.id, hello.pointId),
            userId ? eq(point.userId, userId) : eq(point.keyHash, keyHash!),
          ),
        );
    };
    const [record] = await permitted();
    if (!record) throw new Refused("Unknown point");
    const ownerId = record.userId;
    const deviceId =
      typeof hello.deviceId === "string" &&
      /^[a-f0-9]{64}$/.test(hello.deviceId)
        ? hello.deviceId
        : `legacy:${hello.pointId}`;
    if (path === "/ws/agent") {
      try {
        await this.services.plugins.agent(ownerId, deviceId, hello.pointId);
      } catch (error) {
        if (this.services.plugins.isDenied(error))
          throw new Refused("Device quota or subscription unavailable");
        throw error;
      }
    }
    let encryption = record.encryption ?? null;
    if (path === "/ws/agent") {
      if (hello.encryption === undefined && encryption)
        throw new Refused("Encrypted client required");
      const next = hello.encryption
        ? JSON.stringify(encryptionSchema.parse(hello.encryption))
        : null;
      if (next !== encryption) {
        this.streams.disconnectPoint(hello.pointId);
        for (const viewer of this.viewers.get(hello.pointId) ?? [])
          viewer.close(1008, "Workspace protection changed. Reload.");
        await this.services.db
          .update(point)
          .set({ encryption: next })
          .where(eq(point.id, hello.pointId));
        encryption = next;
      }
    } else if (Boolean(encryption) !== (hello.encrypted === true))
      throw new Refused("Unlock workspace first");
    if (ws.readyState !== WebSocket.OPEN) return;
    const id = hello.pointId as string;
    await this.services.audit.track(ws, request, {
      userId: ownerId,
      pointId: id,
      authSessionId,
      kind: path === "/ws/agent" ? "agent" : "chat",
      viewerId: userId ? viewerId : undefined,
      deviceId: path === "/ws/agent" ? deviceId : undefined,
    });
    if (ws.readyState !== WebSocket.OPEN) return;
    if (
      userId &&
      (await this.services.identity(request.headers)).sessionId !==
        authSessionId
    )
      throw new Refused("Session revoked");
    if (
      userId &&
      !(await this.services.plugins.viewer(
        userId,
        authSessionId!,
        id,
        viewerId,
      ))
    ) {
      ws.close(1008, "Viewer disconnected");
      return;
    }
    if (path === "/ws/agent") {
      this.agents.get(id)?.close(AGENT_REFUSED, "Connection replaced");
      this.snapshots.delete(id);
      this.agents.set(id, ws);
      const address = clientAddress(request);
      if (address) this.agentAddresses.set(id, address);
      else this.agentAddresses.delete(id);
      if (
        Array.isArray(hello.features) &&
        hello.features.includes("chat-viewers")
      )
        this.viewerPresence.add(ws);
      this.broadcast(id, { type: "presence", online: true });
    } else {
      const viewers = this.viewers.get(id) ?? new Set<WebSocket>();
      viewers.add(ws);
      this.viewers.set(id, viewers);
    }
    if (path === "/ws/browser") {
      this.sessions.set(ws, async () => {
        try {
          await this.services.owner(request.headers);
          if (
            !(await this.services.plugins.viewer(
              userId!,
              authSessionId!,
              id,
              viewerId,
            ))
          )
            ws.close(1008, "Viewer disconnected");
        } catch {
          ws.close(1008, "Session expired");
        }
      });
    }
    send(ws, {
      type: "ready",
      version: PROTOCOL_VERSION,
      features: RELAY_FEATURES,
      online: this.online(id),
      encryption: encryption ? JSON.parse(encryption) : null,
    });
    if (path === "/ws/browser" && this.snapshots.has(id))
      send(ws, this.snapshots.get(id));
    this.notifyChatViewers(id);
    let processing = Promise.resolve(),
      queued = 0;
    ws.on("message", (raw) => {
      if (ws.bufferedAmount > MAX_BUFFER) {
        ws.close(1013, "Client too slow");
        return;
      }
      if (++queued > 32) {
        ws.close(1013, "Too many queued messages");
        return;
      }
      processing = processing
        .then(async () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const [currentPoint] = await permitted();
          if (
            !currentPoint ||
            (currentPoint.encryption ?? null) !== encryption
          ) {
            refuse(ws, path, "Access revoked");
            return;
          }
          const value = JSON.parse(raw.toString());
          if (encryption) {
            const packet = envelopeSchema.parse(value);
            if (packet.epoch !== JSON.parse(encryption).epoch)
              throw new Error("Encryption changed");
            if (path === "/ws/agent") {
              if (this.agents.get(id) === ws) this.broadcast(id, packet);
            } else {
              await this.services.owner(request.headers);
              const target = this.agents.get(id);
              if (target) send(target, packet);
            }
            return;
          }
          if (value.type === "secure") throw new Error("Unexpected encryption");
          if (path === "/ws/agent") {
            if (this.agents.get(id) !== ws) return;
            const event = agentMessageSchema.parse(value);
            if (event.type === "chat.snapshot") {
              this.snapshots.set(id, event);
              this.broadcast(id, event);
            } else if (
              event.type === "chat.event" ||
              event.type === "chat.patch"
            ) {
              // A patch applies on top of the snapshot cached above; it is never cached itself.
              this.broadcast(id, event);
            } else {
              const item = this.pending.get(event.id);
              if (item?.pointId === id) {
                clearTimeout(item.timer);
                this.pending.delete(event.id);
                send(item.viewer, event);
              }
            }
          } else {
            await this.services.owner(request.headers);
            const command = commandSchema.parse(value),
              agent = this.agents.get(id);
            if (!agent || agent.readyState !== WebSocket.OPEN) {
              send(ws, {
                type: "command.result",
                id: command.id,
                ok: false,
                error: "VS Code is offline",
              });
              return;
            }
            if (this.pending.size >= 1000) {
              send(ws, {
                type: "command.result",
                id: command.id,
                ok: false,
                error: "Server busy",
              });
              return;
            }
            if (this.pending.has(command.id)) {
              send(ws, {
                type: "command.result",
                id: command.id,
                ok: false,
                error: "Command already pending",
              });
              return;
            }
            const timer = setTimeout(() => {
              this.pending.delete(command.id);
              send(ws, {
                type: "command.result",
                id: command.id,
                ok: false,
                error:
                  "No acknowledgement. Execution status unknown; check chat before retrying.",
              });
            }, 30000);
            this.pending.set(command.id, { viewer: ws, pointId: id, timer });
            send(agent, command);
          }
        })
        .catch(() =>
          path === "/ws/agent"
            ? ws.close(AGENT_INVALID_MESSAGE, "Invalid message")
            : ws.close(1008, "Invalid message or expired session"),
        )
        .finally(() => {
          queued--;
        });
    });
    ws.on("close", () => {
      this.sessions.delete(ws);
      if (this.agents.get(id) === ws) {
        this.agents.delete(id);
        this.agentAddresses.delete(id);
        this.snapshots.delete(id);
        this.broadcast(id, { type: "presence", online: false });
      }
      const viewers = this.viewers.get(id);
      viewers?.delete(ws);
      if (viewers?.size === 0) this.viewers.delete(id);
      if (path === "/ws/browser") this.notifyChatViewers(id);
      for (const [commandId, item] of this.pending)
        if (item.viewer === ws) {
          clearTimeout(item.timer);
          this.pending.delete(commandId);
        }
    });
  }
  private broadcast(id: string, event: unknown) {
    for (const viewer of this.viewers.get(id) ?? []) send(viewer, event);
  }
  private notifyChatViewers(id: string) {
    const agent = this.agents.get(id);
    if (!agent || !this.viewerPresence.has(agent)) return;
    const count = [...(this.viewers.get(id) ?? [])].filter(
      (viewer) => viewer.readyState === WebSocket.OPEN,
    ).length;
    send(agent, { type: "chat.viewers", count });
  }
  disconnectPoint(id: string) {
    this.streams.disconnectPoint(id);
    this.agents.get(id)?.close(AGENT_REFUSED, "Key revoked");
    this.agents.delete(id);
    this.snapshots.delete(id);
    for (const [commandId, item] of this.pending)
      if (item.pointId === id) {
        clearTimeout(item.timer);
        this.pending.delete(commandId);
      }
    for (const viewer of this.viewers.get(id) ?? [])
      viewer.close(1008, "Point access changed");
    this.viewers.delete(id);
  }
  onApplicationShutdown() {
    this.streams.dispose();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const item of this.pending.values()) clearTimeout(item.timer);
    for (const socket of this.server?.clients ?? []) socket.terminate();
    this.server?.close();
  }
}
