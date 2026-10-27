import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { databaseSchema, migrationFolder } from "./migration-schema.mjs";

const source = fileURLToPath(new URL("../drizzle/", import.meta.url));

test("custom schema migrations keep all foreign keys out of public and preserve originals", async () => {
  const folder = await migrationFolder(source, "exchange");
  const journal = "meta/_journal.json";
  try {
    assert.equal(
      await readFile(join(folder.path, journal), "utf8"),
      await readFile(join(source, journal), "utf8"),
    );
    for (const file of await readdir(source)) {
      if (!file.endsWith(".sql")) continue;
      const original = await readFile(join(source, file), "utf8");
      const custom = await readFile(join(folder.path, file), "utf8");
      if (original.includes('"public"."user"'))
        assert.ok(custom.includes('"exchange"."user"'));
      assert.ok(!custom.includes('"public".'));
      assert.equal(custom.replaceAll('"exchange".', '"public".'), original);
    }
  } finally {
    await folder.cleanup();
  }
  await assert.rejects(access(folder.path));
});

test("default schema preserves existing migration paths and journal behavior", async () => {
  assert.equal(databaseSchema(), "public");
  const folder = await migrationFolder(source, "public");
  assert.equal(folder.path, source);
  await folder.cleanup();
  await access(source);
});

test("schema names cannot inject SQL or target PostgreSQL system schemas", () => {
  for (const value of [
    "",
    'exchange"; DROP SCHEMA public; --',
    "pg_catalog",
    "with.dot",
    "a".repeat(64),
  ])
    assert.throws(() => databaseSchema(value));
});
