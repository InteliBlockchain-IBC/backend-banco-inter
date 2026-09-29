import type { FastifyInstance } from "fastify";
import { sendData } from "../http.js";
import type { MockStore } from "../mock/store.js";
import { dataEnvelope, errorResponses } from "../schemas.js";

export async function registerChainRoutes(
  app: FastifyInstance,
  { store }: { store: MockStore },
): Promise<void> {
  app.get(
    "/api/deployment",
    {
      schema: {
        description:
          "Rede e endereços dos contratos. O frontend usa para montar as chamadas e checar se a carteira está na rede certa.",
        operationId: "getDeployment",
        response: {
          200: dataEnvelope({ $ref: "Deployment#" }),
          ...errorResponses(),
        },
        summary: "Contratos implantados",
        tags: ["rede"],
      },
    },
    async (_request, reply) => sendData(reply, store.deployment()),
  );

  app.get(
    "/api/sync-status",
    {
      schema: {
        description:
          "Último bloco processado pelo listener e atraso em segundos. Quando stale for true, a interface deve avisar que os dados podem estar desatualizados.",
        operationId: "getSyncStatus",
        response: {
          200: dataEnvelope({ $ref: "SyncStatus#" }),
          ...errorResponses(),
        },
        summary: "Estado da sincronização",
        tags: ["rede"],
      },
    },
    async (_request, reply) => sendData(reply, store.syncStatus()),
  );
}
