import type { FastifyInstance } from "fastify";
import { sendData } from "../reply.js";
import type { DataStore } from "../../repositories/repository.js";
import {
  dataEnvelope,
  errorResponses,
  patterns,
  requestIdParams,
  walletHeaderSchema,
} from "../schemas.js";

const submissionBody = {
  additionalProperties: false,
  properties: {
    txHash: {
      description: "Hash devolvido pela carteira depois de assinar e enviar.",
      pattern: patterns.txHash,
      type: "string",
    },
  },
  required: ["txHash"],
  type: "object",
} as const;

export async function registerTransactionRequestRoutes(
  app: FastifyInstance,
  { store, enableIntents }: { store: DataStore; enableIntents: boolean },
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/api/transaction-requests/:id",
    {
      schema: {
        description:
          "Estado de uma intenção fictícia. Nesta versão ela não chega a confirmed/failed porque não há listener.",
        operationId: "getTransactionRequest",
        params: requestIdParams,
        response: {
          200: dataEnvelope({ $ref: "TransactionRequest#" }),
          ...errorResponses(400, 404),
        },
        summary: "Consultar intenção",
        tags: ["intenções"],
      },
    },
    async (request, reply) =>
      sendData(
        reply,
        store.source,
        await store.getTransactionRequest(request.params.id),
      ),
  );
  if (!enableIntents) return;

  app.post<{
    Body: { txHash: string };
    Headers: { "x-wallet-address": string };
    Params: { id: string };
  }>(
    "/api/transaction-requests/:id/submission",
    {
      schema: {
        body: submissionBody,
        description:
          "Registra um hash autodeclarado para uma intenção pending. X-Wallet-Address é comparado à carteira também autodeclarada na criação; não prova assinatura nem transmissão.",
        headers: walletHeaderSchema,
        operationId: "submitTransaction",
        params: requestIdParams,
        response: {
          200: dataEnvelope({ $ref: "TransactionRequest#" }),
          ...errorResponses(400, 403, 404, 409),
        },
        summary: "Informar hash da transação",
        tags: ["intenções"],
      },
    },
    async (request, reply) =>
      sendData(
        reply,
        store.source,
        await store.submitTransaction(
          request.params.id,
          request.headers["x-wallet-address"],
          request.body.txHash,
        ),
      ),
  );
}
