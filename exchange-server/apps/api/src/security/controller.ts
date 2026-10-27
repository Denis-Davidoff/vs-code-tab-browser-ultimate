import {
  Controller,
  Get,
  Inject,
  Req,
  Query,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import type { Request } from "express";
import { Services } from "../services.js";

@Controller("api/security")
export class SecurityController {
  constructor(@Inject(Services) private readonly services: Services) {}
  private async scope(req: Request, admin?: string) {
    const identity = await this.services.identity(req.headers);
    if (admin === "true") {
      if (
        !(process.env.SECURITY_ADMIN_IDS ?? "")
          .split(",")
          .map((s) => s.trim())
          .includes(identity.userId)
      )
        throw new ForbiddenException();
      return null;
    }
    return identity.userId;
  }
  @Get("events") async events(
    @Req() req: Request,
    @Query("admin") admin?: string,
    @Query("before") before?: string,
  ) {
    const userId = await this.scope(req, admin);
    let cursor: { at: string; id: string } | null = null;
    if (before) {
      try {
        cursor = JSON.parse(Buffer.from(before, "base64url").toString());
      } catch {
        throw new BadRequestException("Invalid cursor");
      }
      if (
        !cursor ||
        typeof cursor.at !== "string" ||
        !Number.isFinite(Date.parse(cursor.at)) ||
        typeof cursor.id !== "string" ||
        cursor.id.length > 100
      )
        throw new BadRequestException("Invalid cursor");
    }
    const { rows } = await this.services.pool.query(
      `SELECT id,created_at,event,user_id,auth_session_id,point_id,connection_id,ip,peer_ip,user_agent,outcome,reason
      FROM exchange_audit_event WHERE ($1::text IS NULL OR user_id=$1)
      AND ($2::timestamptz IS NULL OR (created_at,id) < ($2::timestamptz,$3::text))
      ORDER BY created_at DESC,id DESC LIMIT 100`,
      [userId, cursor?.at ?? null, cursor?.id ?? null],
    );
    const last = rows.at(-1);
    return {
      items: rows,
      next:
        rows.length === 100 && last
          ? Buffer.from(
              JSON.stringify({
                at: last.created_at.toISOString(),
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }
  @Get("connections") async connections(
    @Req() req: Request,
    @Query("admin") admin?: string,
  ) {
    const userId = await this.scope(req, admin);
    const { rows } = await this.services.pool.query(
      `SELECT id,user_id,point_id,kind,device_id,ip,peer_ip,user_agent,
      started_at,last_seen_at,ended_at,end_reason,
      COALESCE(duration_ms,GREATEST(0,EXTRACT(EPOCH FROM (now()-started_at))*1000)::bigint)::text AS duration_ms
      FROM exchange_connection WHERE ($1::text IS NULL OR user_id=$1) ORDER BY started_at DESC LIMIT 100`,
      [userId],
    );
    return rows;
  }
  @Get("alerts") async alerts(
    @Req() req: Request,
    @Query("admin") admin?: string,
  ) {
    const userId = await this.scope(req, admin);
    const { rows } = await this.services.pool.query(
      `SELECT ip, count(*)::int AS attempts,max(created_at) AS last_at
      FROM exchange_audit_event WHERE outcome='denied' AND created_at > now()-interval '15 minutes'
      AND ($1::text IS NULL OR user_id=$1) GROUP BY ip HAVING count(*) >= 5 ORDER BY attempts DESC LIMIT 100`,
      [userId],
    );
    return { repeatedFailures: rows };
  }
  @Get("capabilities") async capabilities(@Req() req: Request) {
    const userId = await this.services.owner(req.headers);
    return {
      plugins: this.services.plugins.loaded,
      admin: (process.env.SECURITY_ADMIN_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .includes(userId),
    };
  }
}
