import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Pool, PoolClient } from "pg";
import type { WebSocket } from "ws";

export function requestIdentity(
  request: Pick<IncomingMessage, "headers" | "socket">,
) {
  const peer = request.socket.remoteAddress?.replace(/^::ffff:/, "") ?? null;
  const trusted = (process.env.AUDIT_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((v) => v.trim());
  // Only a proxy explicitly trusted by the operator may supply the client IP.
  const forwarded = request.headers["x-forwarded-for"];
  const candidate =
    typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "";
  const ip =
    peer && trusted.includes(peer) && isIP(candidate) ? candidate : peer;
  const ua = request.headers["user-agent"];
  return {
    ip,
    peerIp: peer,
    userAgent: typeof ua === "string" ? ua.slice(0, 512) : null,
  };
}
export type AuditEvent = {
  event: string;
  userId?: string | null;
  authSessionId?: string | null;
  pointId?: string | null;
  connectionId?: string | null;
  ip?: string | null;
  peerIp?: string | null;
  userAgent?: string | null;
  outcome?: "success" | "denied" | "error";
  reason?: string;
};
export type Connection = ReturnType<typeof requestIdentity> & {
  id: string;
  userId: string;
  authSessionId?: string;
  pointId: string;
  kind: "agent" | "chat" | "media-agent" | "media";
  deviceId?: string;
  viewerId?: string;
  startedAt: Date;
  socket: WebSocket;
};
export class Audit {
  readonly requestContext = new AsyncLocalStorage<
    ReturnType<typeof requestIdentity>
  >();
  readonly connections = new Map<string, Connection>();
  private writes = new Set<Promise<unknown>>();
  private lock?: PoolClient;
  private heartbeat?: ReturnType<typeof setInterval>;
  private cleanup?: ReturnType<typeof setInterval>;
  constructor(readonly pool: Pool) {}
  async init() {
    this.lock = await this.pool.connect();
    const {
      rows: [guard],
    } = await this.lock.query(
      "SELECT pg_try_advisory_lock(hashtext(current_schema() || ':exchange-security-runtime')) AS acquired",
    );
    if (!guard.acquired) {
      this.lock.release();
      this.lock = undefined;
      throw new Error(
        "Only one Exchange API instance per database schema is supported",
      );
    }
    // A single API instance owns these live connections. A crash is not a logout.
    await this.pool.query(`UPDATE exchange_connection SET ended_at=last_seen_at,
      end_reason='server_restart',duration_ms=GREATEST(0,EXTRACT(EPOCH FROM (last_seen_at-started_at))*1000)::bigint WHERE ended_at IS NULL`);
    await this.prune();
    this.cleanup = setInterval(() => {
      this.background(this.prune());
    }, 3_600_000);
    this.cleanup.unref();
    this.heartbeat = setInterval(() => {
      const ids = [...this.connections.keys()];
      if (ids.length)
        this.background(
          this.pool.query(
            "UPDATE exchange_connection SET last_seen_at=now() WHERE id = ANY($1::text[])",
            [ids],
          ),
        );
    }, 30_000);
    this.heartbeat.unref();
  }
  private async prune() {
    const days = Number(process.env.AUDIT_RETENTION_DAYS ?? 90);
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw new Error("Invalid AUDIT_RETENTION_DAYS (1–3650)");
    await this.pool.query(
      "DELETE FROM exchange_audit_event WHERE created_at < now() - $1 * interval '1 day'",
      [days],
    );
    await this.pool.query(
      "DELETE FROM exchange_connection WHERE ended_at < now() - $1 * interval '1 day'",
      [days],
    );
    const ids = [...this.connections.keys()];
    if (ids.length)
      await this.pool.query(
        "UPDATE exchange_connection SET last_seen_at=now() WHERE id = ANY($1::text[])",
        [ids],
      );
  }
  background(write: Promise<unknown>) {
    const guarded = write.catch(() => {
      console.error(
        "Security journal write failed; check database availability",
      );
    });
    this.writes.add(guarded);
    void guarded.finally(() => this.writes.delete(guarded));
  }
  async record(value: AuditEvent) {
    // Deliberate allowlist: never persist request bodies, cookies, URLs or tokens.
    await this.pool.query(
      `INSERT INTO exchange_audit_event
      (id,event,user_id,auth_session_id,point_id,connection_id,ip,peer_ip,user_agent,outcome,reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        value.event,
        value.userId ?? null,
        value.authSessionId ?? null,
        value.pointId ?? null,
        value.connectionId ?? null,
        value.ip ?? null,
        value.peerIp ?? null,
        value.userAgent ?? null,
        value.outcome ?? "success",
        value.reason ?? null,
      ],
    );
  }
  async track(
    socket: WebSocket,
    request: IncomingMessage,
    info: Pick<
      Connection,
      "userId" | "pointId" | "kind" | "authSessionId" | "deviceId" | "viewerId"
    >,
  ) {
    const entry: Connection = {
      ...info,
      ...requestIdentity(request),
      id: randomUUID(),
      startedAt: new Date(),
      socket,
    };
    await this.pool.query(
      `INSERT INTO exchange_connection
      (id,user_id,auth_session_id,point_id,kind,device_id,ip,peer_ip,user_agent,viewer_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        entry.id,
        entry.userId,
        entry.authSessionId ?? null,
        entry.pointId,
        entry.kind,
        entry.deviceId ?? null,
        entry.ip,
        entry.peerIp,
        entry.userAgent,
        entry.viewerId ?? null,
      ],
    );
    this.connections.set(entry.id, entry);
    const finish = (code: number) => {
      if (!this.connections.delete(entry.id)) return;
      this.background(
        this.pool.query(
          `UPDATE exchange_connection SET ended_at=now(),last_seen_at=now(),
        end_reason=$2,duration_ms=GREATEST(0,EXTRACT(EPOCH FROM (now()-started_at))*1000)::bigint WHERE id=$1`,
          [entry.id, `close_${code}`],
        ),
      );
      this.background(
        this.record({
          ...entry,
          connectionId: entry.id,
          event: "connection.closed",
          reason: `close_${code}`,
        }),
      );
    };
    socket.once("close", finish);
    if (socket.readyState !== 1) finish(1006);
    this.background(
      this.record({
        ...entry,
        connectionId: entry.id,
        event: "connection.opened",
        reason: info.kind,
      }),
    );
    return entry;
  }
  async close() {
    if (this.cleanup) clearInterval(this.cleanup);
    if (this.heartbeat) clearInterval(this.heartbeat);
    await Promise.all(
      [...this.connections.values()].map(
        (connection) =>
          new Promise<void>((resolve) => {
            if (connection.socket.readyState === 3) {
              resolve();
              return;
            }
            connection.socket.once("close", () => resolve());
            connection.socket.terminate();
          }),
      ),
    );
    while (this.writes.size) await Promise.all([...this.writes]);
    if (this.lock) {
      await this.lock.query(
        "SELECT pg_advisory_unlock(hashtext(current_schema() || ':exchange-security-runtime'))",
      );
      this.lock.release();
      this.lock = undefined;
    }
  }
}
