import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error("Set DATABASE_URL in exchange-server/.env");
  const target = new URL(process.env.DATABASE_URL);
  console.log(
    `Migrating PostgreSQL at ${target.hostname}:${target.port || 5432}${target.pathname}`,
  );
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle/", import.meta.url)),
    });
    console.log("Migrations applied successfully.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const seen = new Set();
  function report(value) {
    if (!value || seen.has(value)) return;
    seen.add(value);
    const message = String(value.message || value).replace(
      /postgres(?:ql)?:\/\/[^\s]+/g,
      "[database URL]",
    );
    console.error(`${value.code ? value.code + ": " : ""}${message}`);
    if (value.cause) report(value.cause);
    if (value instanceof AggregateError)
      for (const nested of value.errors) report(nested);
  }
  console.error("Database migration failed:");
  report(error);
  console.error(
    "Check DATABASE_URL and run docker compose up -d --wait from exchange-server.",
  );
  process.exitCode = 1;
});
