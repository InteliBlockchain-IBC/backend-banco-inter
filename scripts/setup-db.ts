import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/database/migrate.js";
import { seedDemo } from "../src/database/seed.js";

/**
 * Prepara o banco em um passo: aplica as migrations e, conforme SEED_DEMO,
 * grava a massa de demonstração. É o comando do serviço `setup` do
 * docker compose e de `npm run db:setup`.
 *
 * SEED_DEMO: `if-empty` (padrão) | `reset` | `off`.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL não configurada");

const seed = process.env.SEED_DEMO ?? "if-empty";
if (seed !== "if-empty" && seed !== "reset" && seed !== "off") {
  throw new Error("SEED_DEMO deve ser if-empty, reset ou off");
}

const applied = await migrate(connectionString, resolve(root, "migrations"));
console.log(
  `Migrações aplicadas: ${applied.length ? applied.join(", ") : "nenhuma"}`,
);

if (seed === "off") {
  console.log("Seed desativado (SEED_DEMO=off).");
} else {
  const result = await seedDemo(connectionString, { mode: seed });
  console.log(
    result.seeded
      ? `Seed de demonstração gravado (${result.offers} ofertas, modo ${seed}).`
      : "Banco já possui dados; seed ignorado (SEED_DEMO=reset recria).",
  );
}
