import { originChecksDisabled } from "./origin-policy.js";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import { Audit } from "./security/audit.js";
import { Plugins } from "./plugins.js";
import * as schema from "./schema.js";
@Injectable()
export class Services {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  readonly db = drizzle(this.pool, { schema });
  readonly audit = new Audit(this.pool);
  readonly plugins = new Plugins();
  readonly auth = betterAuth({
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            const metadata = this.audit.requestContext.getStore();
            if (metadata?.ip) {
              const {
                rows: [previous],
              } = await this.pool.query(
                `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ip=$2)::int AS known FROM exchange_audit_event
              WHERE user_id=$1 AND event='auth.session.created'`,
                [session.userId, metadata.ip],
              );
              if (previous.total > 0 && previous.known === 0)
                await this.audit.record({
                  ...metadata,
                  event: "auth.new_ip",
                  userId: session.userId,
                  authSessionId: session.id,
                });
            }
            await this.audit.record({
              ...metadata,
              event: "auth.session.created",
              userId: session.userId,
              authSessionId: session.id,
            });
          },
        },
        delete: {
          after: async (session) => {
            this.audit.background(
              this.audit.record({
                event: "auth.session.ended",
                userId: session.userId,
                authSessionId: session.id,
              }),
            );
            for (const c of this.audit.connections.values())
              if (c.authSessionId === session.id)
                c.socket.close(1008, "Session revoked");
          },
        },
      },
    },
    appName: "AI Browser",
    plugins: [twoFactor({ issuer: "AI Browser" })],
    database: drizzleAdapter(this.db, { provider: "pg", schema }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:3000"],
    advanced: {
      ipAddress: { ipAddressHeaders: ["x-exchange-client-ip"] },
      disableOriginCheck: originChecksDisabled(),
      disableCSRFCheck: originChecksDisabled(),
    },
    emailAndPassword: { enabled: true },
    socialProviders:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {},
  });
  async identity(headers: IncomingHttpHeaders) {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(headers),
    });
    if (!session) throw new UnauthorizedException();
    return { userId: session.user.id, sessionId: session.session.id };
  }
  async owner(headers: IncomingHttpHeaders) {
    return (await this.identity(headers)).userId;
  }
  async onApplicationShutdown() {
    await this.plugins.close();
    await this.audit.close();
    await this.pool.end();
  }
}
