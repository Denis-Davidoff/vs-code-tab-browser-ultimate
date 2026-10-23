import { originChecksDisabled } from "./origin-policy.js";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import * as schema from "./schema.js";
@Injectable()
export class Services {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  readonly db = drizzle(this.pool, { schema });
  readonly auth = betterAuth({
    appName: "AI Browser",
    plugins: [twoFactor({ issuer: "AI Browser" })],
    database: drizzleAdapter(this.db, { provider: "pg", schema }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:3000"],
    advanced: {
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
  async owner(headers: IncomingHttpHeaders) {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(headers),
    });
    if (!session) throw new UnauthorizedException();
    return session.user.id;
  }
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
