import type { FastifyInstance } from "fastify";
import { sendData } from "../http.js";
import type { MockStore } from "../mock/store.js";
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
  { store }: { store: MockStore },
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/api/transaction-requests/:id",
    {
      schema: {
        description:
          "Estado de uma intenção. O frontend pode consultar até ver confirmed ou failed (definidos pelo listener).",
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
      sendData(reply, store.getTransactionRequest(request.params.id)),
  );

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
          "Informa o hash da transação assinada. A intenção passa de pending para submitted. Só a carteira solicitante pode informar, uma única vez e antes de expiresAt.",
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
        store.submitTransaction(
          request.params.id,
          request.headers["x-wallet-address"],
          request.body.txHash,
        ),
      ),
  );
}
