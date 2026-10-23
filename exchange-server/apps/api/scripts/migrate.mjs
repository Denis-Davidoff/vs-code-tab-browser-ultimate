import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  databaseSchema,
  migrationFolder,
  migrateExistingSchema,
} from "./migration-schema.mjs";

async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error("Set DATABASE_URL in exchange-server/.env");
  const target = new URL(process.env.DATABASE_URL);
  const schema = databaseSchema(process.env.DATABASE_SCHEMA);
  console.log(
    `Migrating PostgreSQL at ${target.hostname}:${target.port || 5432}${target.pathname}`,
  );
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  let folder;
  try {
    await client.connect();
    if (schema !== "public") {
      // A DBA must provision the schema and its dedicated role first. Never fall
      // back to public if the schema is absent or inaccessible.
      await client.query(`SET search_path TO "${schema}"`);
      const result = await client.query("SELECT current_schema() AS name");
      if (result.rows[0]?.name !== schema)
        throw new Error(`Schema ${schema} is missing or inaccessible`);
    }
    folder = await migrationFolder(
      fileURLToPath(new URL("../drizzle/", import.meta.url)),
      schema,
    );
    if (schema === "public")
      await migrate(drizzle(client), { migrationsFolder: folder.path });
    else await migrateExistingSchema(client, folder.path, schema);
    console.log("Migrations applied successfully.");
  } finally {
    await client.end();
    await folder?.cleanup();
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
