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
      "institution_wallets",
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
  assert.deepEqual(history.rows.map((row) => row.name).sort(), [
    "001_initial_schema.sql",
    "002_institution_wallets.sql",
  ]);
  for (const row of history.rows) {
    assert.match(row.checksum, /^[a-f0-9]{64}$/);
  }

  const scratch = await mkdtemp(resolve(tmpdir(), "inter-migrations-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const name of [
    "001_initial_schema.sql",
    "002_institution_wallets.sql",
  ]) {
    await cp(resolve(migrationsDir, name), resolve(scratch, name));
  }
  await writeFile(
    resolve(scratch, "003_probe.sql"),
    "CREATE TABLE migration_probe (id integer PRIMARY KEY);\n",
  );
  await migrate(url.toString(), scratch);
  await writeFile(
    resolve(scratch, "004_invalid.sql"),
    "CREATE TABLE must_roll_back (id integer);\nSELECT * FROM table_that_does_not_exist;\n",
  );
  await assert.rejects(migrate(url.toString(), scratch));
  const rolledBack = await db.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  assert.deepEqual(
    rolledBack.rows.map((row) => row.name),
    ["001_initial_schema.sql", "002_institution_wallets.sql", "003_probe.sql"],
  );
  const absent = await db.query<{ table_name: string | null }>(
    "SELECT to_regclass('must_roll_back')::text AS table_name",
  );
  assert.equal(absent.rows[0]?.table_name, null);
  await writeFile(
    resolve(scratch, "004_invalid.sql"),
    "CREATE TABLE after_repair (id integer);\n",
  );
  await migrate(url.toString(), scratch);
  await writeFile(
    resolve(scratch, "003_probe.sql"),
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
    resolve(scratch, "003_probe.sql"),
    "CREATE TABLE migration_probe (id integer PRIMARY KEY);\n",
  );
  await assert.rejects(migrate(url.toString(), scratch), /fora de ordem/i);
  const outOfOrder = await db.query<{ name: string | null }>(
    "SELECT to_regclass('unexpected_preflight')::text AS name",
  );
  assert.equal(outOfOrder.rows[0]?.name, null);
});

test("002 moves wallet ownership out of the per-contract state without losing links", {
  skip:
    DATABASE_URL === undefined ? "TEST_DATABASE_URL is required" : undefined,
}, async (t) => {
  assert.ok(DATABASE_URL);
  const schema = `sprint3_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const url = new URL(DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const only001 = await mkdtemp(resolve(tmpdir(), "inter-001-"));
  t.after(() => rm(only001, { recursive: true, force: true }));
  await cp(
    resolve(ROOT, "migrations/001_initial_schema.sql"),
    resolve(only001, "001_initial_schema.sql"),
  );
  await migrate(url.toString(), only001);

  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  t.after(() => db.end());
  const bank = "b0000000-0000-4000-8000-000000000001";
  const wallet = `0x${"a1".repeat(20)}`;
  await db.query("INSERT INTO institutions (id, name) VALUES ($1, 'Banco')", [
    bank,
  ]);
  await db.query(
    `INSERT INTO contract_deployments VALUES
       (11155111, $1, $1, $1, 1, now()), (31337, $1, $1, $1, 1, now())`,
    [`0x${"0c".repeat(20)}`],
  );
  // Mesma carteira em dois deployments: o vínculo vira uma linha só.
  await db.query(
    `INSERT INTO contract_wallet_state (chain_id, contract_address,
       wallet_address, institution_id, is_registered)
     SELECT chain_id, contract_address, $1, $2, true FROM contract_deployments`,
    [wallet, bank],
  );

  assert.deepEqual(await migrate(url.toString(), resolve(ROOT, "migrations")), [
    "002_institution_wallets.sql",
  ]);
  const links = await db.query(
    "SELECT wallet_address, institution_id FROM institution_wallets",
  );
  assert.deepEqual(links.rows, [
    { institution_id: bank, wallet_address: wallet },
  ]);
  const column = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'contract_wallet_state'
        AND column_name = 'institution_id'`,
    [schema],
  );
  assert.equal(column.rowCount, 0);

  // Agora o mesmo banco aceita uma segunda carteira no mesmo contrato.
  const second = `0x${"a7".repeat(20)}`;
  await db.query(
    "INSERT INTO institution_wallets (wallet_address, institution_id) VALUES ($1, $2)",
    [second, bank],
  );
  await db.query(
    `INSERT INTO contract_wallet_state (chain_id, contract_address, wallet_address)
     VALUES (11155111, $1, $2)`,
    [`0x${"0c".repeat(20)}`, second],
  );
  await assert.rejects(
    db.query(
      "INSERT INTO institution_wallets (wallet_address, institution_id) VALUES ($1, $2)",
      [`0x${"A7".repeat(20)}`, bank],
    ),
    /check/i,
    "endereço fora do formato minúsculo é recusado",
  );
});
