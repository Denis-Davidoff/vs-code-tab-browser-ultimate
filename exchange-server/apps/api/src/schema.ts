import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  index,
} from "drizzle-orm/pg-core";
const dates = () => ({
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  ...dates(),
});
export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  ...dates(),
});
export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  ...dates(),
});
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  ...dates(),
});
export const point = pgTable("exchange_point", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  encryption: text("encryption"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  verified: boolean("verified").default(true),
  failedVerificationCount: integer("failed_verification_count").default(0),
  lockedUntil: timestamp("locked_until"),
});

// Security history survives workspace/account deletion until retention expiry.
export const auditEvent = pgTable(
  "exchange_audit_event",
  {
    id: text("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    event: text("event").notNull(),
    userId: text("user_id"),
    authSessionId: text("auth_session_id"),
    pointId: text("point_id"),
    connectionId: text("connection_id"),
    ip: text("ip"),
    peerIp: text("peer_ip"),
    userAgent: text("user_agent"),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
  },
  (table) => [
    index("audit_user_created_idx").on(table.userId, table.createdAt),
    index("audit_ip_created_idx").on(table.ip, table.createdAt),
  ],
);
export const securityConnection = pgTable(
  "exchange_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    authSessionId: text("auth_session_id"),
    pointId: text("point_id").notNull(),
    kind: text("kind").notNull(),
    deviceId: text("device_id"),
    viewerId: text("viewer_id"),
    ip: text("ip"),
    peerIp: text("peer_ip"),
    userAgent: text("user_agent"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    endReason: text("end_reason"),
  },
  (table) => [
    index("connection_user_started_idx").on(table.userId, table.startedAt),
  ],
);
