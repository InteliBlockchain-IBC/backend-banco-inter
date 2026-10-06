import type { FastifyInstance } from "fastify";
import { sendData } from "../reply.js";
import type { DataStore } from "../../repositories/repository.js";
import { dataEnvelope, errorResponses } from "../schemas.js";

export async function registerChainRoutes(
  app: FastifyInstance,
  { store }: { store: DataStore },
): Promise<void> {
  app.get(
    "/api/deployment",
    {
      schema: {
        description:
          "Endereços sintéticos de demonstração. Não usar para construir ou enviar transações reais na Sepolia.",
        operationId: "getDeployment",
        response: {
          200: dataEnvelope({ $ref: "Deployment#" }),
          ...errorResponses(),
        },
        summary: "Endereços fictícios",
        tags: ["rede"],
      },
    },
    async (_request, reply) =>
      sendData(reply, store.source, await store.deployment()),
  );

  app.get(
    "/api/sync-status",
    {
      schema: {
        description:
          "Cursor fictício da instância mock; não representa logs indexados nem disponibilidade de listener.",
        operationId: "getSyncStatus",
        response: {
          200: dataEnvelope({ $ref: "SyncStatus#" }),
          ...errorResponses(),
        },
        summary: "Cursor simulado",
        tags: ["rede"],
      },
    },
    async (_request, reply) =>
      sendData(reply, store.source, await store.syncStatus()),
  );
}
