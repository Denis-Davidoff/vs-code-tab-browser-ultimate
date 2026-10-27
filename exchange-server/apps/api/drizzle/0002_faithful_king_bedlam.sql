CREATE TABLE "exchange_audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"user_id" text,
	"auth_session_id" text,
	"point_id" text,
	"connection_id" text,
	"ip" text,
	"peer_ip" text,
	"user_agent" text,
	"outcome" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "exchange_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"auth_session_id" text,
	"point_id" text NOT NULL,
	"kind" text NOT NULL,
	"device_id" text,
	"ip" text,
	"peer_ip" text,
	"user_agent" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" bigint,
	"end_reason" text
);
--> statement-breakpoint
CREATE INDEX "audit_user_created_idx" ON "exchange_audit_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_ip_created_idx" ON "exchange_audit_event" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "connection_user_started_idx" ON "exchange_connection" USING btree ("user_id","started_at");