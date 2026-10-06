import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/database/migrate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL não configurada");
const applied = await migrate(connectionString, resolve(root, "migrations"));
console.log(
  `Migrações aplicadas: ${applied.length ? applied.join(", ") : "nenhuma"}`,
);
