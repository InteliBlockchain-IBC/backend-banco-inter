import { seedDemo } from "../src/database/seed.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL não configurada");
const mode = process.argv.includes("--reset") ? "reset" : "if-empty";
const result = await seedDemo(connectionString, { mode });
console.log(
  result.seeded
    ? `Seed de demonstração gravado (${result.offers} ofertas, modo ${mode}).`
    : "Banco já possui dados; seed ignorado. Use --reset para recriar.",
);
