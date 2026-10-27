import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";

export function databaseSchema(value = "public") {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value) || value.startsWith("pg_"))
    throw new Error("DATABASE_SCHEMA must be a simple PostgreSQL schema name");
  return value;
}

// Keep the historical migrations intact for existing local installations.
// New deployments can place both tables and their migration journal in one schema.
export async function migrationFolder(source, schema) {
  databaseSchema(schema);
  if (schema === "public") return { path: source, cleanup: async () => {} };
  const path = await mkdtemp(join(tmpdir(), "exchange-migrations-"));
  const cleanup = () => rm(path, { recursive: true, force: true });
  try {
    await cp(source, path, { recursive: true });
    for (const file of await readdir(path)) {
      if (!file.endsWith(".sql")) continue;
      const sql = await readFile(join(path, file), "utf8");
      await writeFile(
        join(path, file),
        sql.replaceAll('"public".', `"${schema}".`),
      );
    }
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// Drizzle's standard migrator issues CREATE SCHEMA even for an existing schema,
// which requires CREATE on the entire database. A shared database deployment
// instead uses a schema provisioned by its DBA and needs only schema ownership.
export async function migrateExistingSchema(client, folder, schema) {
  databaseSchema(schema);
  const journal = `"${schema}"."__drizzle_migrations"`;
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `exchange-migrations:${schema}`,
    ]);
    await client.query(`CREATE TABLE IF NOT EXISTS ${journal} (
      id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`);
    const applied = await client.query(
      `SELECT created_at FROM ${journal} ORDER BY created_at DESC LIMIT 1`,
    );
    const last = Number(applied.rows[0]?.created_at ?? -1);
    for (const migration of migrations) {
      if (migration.folderMillis <= last) continue;
      for (const statement of migration.sql) await client.query(statement);
      await client.query(
        `INSERT INTO ${journal} (hash, created_at) VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
