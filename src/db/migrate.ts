import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const MIGRATION_LOCK = 724182913;
const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

type AppliedMigration = { name: string; checksum: string };

/** Use one dedicated session for the advisory lock and every SQL file. */
export async function migrate(
  connectionString: string,
  directory: string,
): Promise<string[]> {
  if (!connectionString) throw new Error("DATABASE_URL não configurada");
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries.filter((entry) => entry.name.endsWith(".sql"));
  if (
    filenames.some(
      (entry) => !entry.isFile() || !MIGRATION_NAME.test(entry.name),
    )
  ) {
    throw new Error("Nome de migração inválido; esperado NNN_nome.sql");
  }
  const names = filenames.map((entry) => entry.name).sort();
  const positions = names.map((name) => name.slice(0, 3));
  if (new Set(positions).size !== positions.length) {
    throw new Error("Duas migrações possuem o mesmo número");
  }
  const scripts = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(directory, name), "utf8");
      if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql)) {
        throw new Error(`${name}: controle de transação pertence ao runner`);
      }
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  const client = new Client({ connectionString });
  await client.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<AppliedMigration>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const byName = new Map(applied.rows.map((row) => [row.name, row.checksum]));
    if (applied.rows.some((row) => !names.includes(row.name))) {
      throw new Error("Migração aplicada não encontrada no diretório");
    }
    const latestApplied = applied.rows
      .map((row) => row.name)
      .sort()
      .at(-1);
    for (const script of scripts) {
      const oldChecksum = byName.get(script.name);
      if (oldChecksum !== undefined && oldChecksum !== script.checksum) {
        throw new Error(
          `Migração ${script.name} alterada: checksum divergente`,
        );
      }
    }
    const outOfOrder = scripts.find(
      (script) =>
        !byName.has(script.name) &&
        latestApplied !== undefined &&
        script.name < latestApplied,
    );
    if (outOfOrder)
      throw new Error(`Migração ${outOfOrder.name} fora de ordem`);
    const completed: string[] = [];
    for (const script of scripts) {
      if (byName.has(script.name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(script.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [script.name, script.checksum],
        );
        await client.query("COMMIT");
        completed.push(script.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return completed;
  } finally {
    try {
      if (locked)
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    } finally {
      await client.end();
    }
  }
}
