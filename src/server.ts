import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";

export async function startServer(config: AppConfig): Promise<FastifyInstance> {
  const app = await buildApp({ nodeEnv: config.nodeEnv });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "encerrando");
    await app.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });

  return app;
}

/**
 * O processo sobe aqui. A promessa é exportada porque é o único caminho para um
 * teste em processo obter a instância: sem ela, `src/server.ts` nunca era
 * carregado e desaparecia do relatório de cobertura.
 */
export const started: Promise<FastifyInstance> = startServer(
  loadConfig(process.env),
);

await started;
