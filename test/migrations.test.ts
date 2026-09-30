import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { migrate } from "../src/db/migrate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATABASE_URL = process.env.TEST_DATABASE_URL;

test("migrations apply the schema once and serialize simultaneous runners", {
  skip:
    DATABASE_URL === undefined ? "TEST_DATABASE_URL is required" : undefined,
}, async (t) => {
  assert.ok(DATABASE_URL);
  const schema = `sprint2_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const url = new URL(DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const migrationsDir = resolve(ROOT, "migrations");

  await Promise.all([
    migrate(url.toString(), migrationsDir),
    migrate(url.toString(), migrationsDir),
  ]);
  await migrate(url.toString(), migrationsDir);
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  t.after(() => db.end());
  const tables = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
    [schema],
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    [
      "chain_events",
      "contract_deployments",
      "contract_wallet_state",
      "credit_limit_history",
      "institutions",
      "offers",
      "schema_migrations",
      "settlements",
      "sync_cursors",
      "transaction_requests",
    ],
  );
  const history = await db.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  assert.equal(history.rowCount, 1);
  assert.equal(history.rows[0]?.name, "001_initial_schema.sql");
  assert.match(history.rows[0]?.checksum ?? "", /^[a-f0-9]{64}$/);

  const scratch = await mkdtemp(resolve(tmpdir(), "inter-migrations-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await cp(
    resolve(migrationsDir, "001_initial_schema.sql"),
    resolve(scratch, "001_initial_schema.sql"),
  );
  await writeFile(
    resolve(scratch, "002_probe.sql"),
    "CREATE TABLE migration_probe (id integer PRIMARY KEY);\n",
  );
  await migrate(url.toString(), scratch);
  await writeFile(
    resolve(scratch, "003_invalid.sql"),
    "CREATE TABLE must_roll_back (id integer);\nSELECT * FROM table_that_does_not_exist;\n",
  );
  await assert.rejects(migrate(url.toString(), scratch));
  const rolledBack = await db.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  assert.deepEqual(
    rolledBack.rows.map((row) => row.name),
    ["001_initial_schema.sql", "002_probe.sql"],
  );
  const absent = await db.query<{ table_name: string | null }>(
    "SELECT to_regclass('must_roll_back')::text AS table_name",
  );
  assert.equal(absent.rows[0]?.table_name, null);
  await writeFile(
    resolve(scratch, "003_invalid.sql"),
    "CREATE TABLE after_repair (id integer);\n",
  );
  await migrate(url.toString(), scratch);
  await writeFile(
    resolve(scratch, "002_probe.sql"),
    "CREATE TABLE migration_probe (id bigint PRIMARY KEY);\n",
  );
  await assert.rejects(
    migrate(url.toString(), scratch),
    /checksum|alterada|modified/i,
  );
  await writeFile(
    resolve(scratch, "000_preflight.sql"),
    "CREATE TABLE unexpected_preflight (id integer);\n",
  );
  await assert.rejects(migrate(url.toString(), scratch), /checksum|alterada/i);
  const preflight = await db.query<{ name: string | null }>(
    "SELECT to_regclass('unexpected_preflight')::text AS name",
  );
  assert.equal(preflight.rows[0]?.name, null);
  await writeFile(
    resolve(scratch, "002_probe.sql"),
    "CREATE TABLE migration_probe (id integer PRIMARY KEY);\n",
  );
  await assert.rejects(migrate(url.toString(), scratch), /fora de ordem/i);
  const outOfOrder = await db.query<{ name: string | null }>(
    "SELECT to_regclass('unexpected_preflight')::text AS name",
  );
  assert.equal(outOfOrder.rows[0]?.name, null);
});
