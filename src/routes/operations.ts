import type { FastifyInstance } from "fastify";
import { sendData, sendList } from "../http.js";
import type { DataStore } from "../store.js";
import {
  dataEnvelope,
  errorResponses,
  listEnvelope,
  paginationProperties,
  patterns,
  txHashParams,
} from "../schemas.js";

const listQuery = {
  additionalProperties: false,
  properties: {
    ...paginationProperties,
    wallet: {
      description: "Só operações em que a carteira é ofertante ou tomadora.",
      pattern: patterns.address,
      type: "string",
    },
  },
  type: "object",
} as const;

export async function registerOperationRoutes(
  app: FastifyInstance,
  { store }: { store: DataStore },
): Promise<void> {
  app.get<{ Querystring: { limit: number; offset: number; wallet?: string } }>(
    "/api/operations",
    {
      schema: {
        description:
          "Histórico de operações fictícias (fixtures ou simulação), mais recentes primeiro; hashes não provam liquidação real.",
        operationId: "listOperations",
        querystring: listQuery,
        response: { 200: listEnvelope("Operation"), ...errorResponses(400) },
        summary: "Listar operações liquidadas",
        tags: ["operações"],
      },
    },
    async (request, reply) => {
      const { limit, offset, wallet } = request.query;
      return sendList(
        reply,
        store.source,
        await store.listOperations(wallet === undefined ? {} : { wallet }, {
          limit,
          offset,
        }),
      );
    },
  );

  app.get<{ Params: { txHash: string } }>(
    "/api/operations/:txHash",
    {
      schema: {
        description:
          "Comprovante fictício por hash sintético, sem prova on-chain.",
        operationId: "getOperation",
        params: txHashParams,
        response: {
          200: dataEnvelope({ $ref: "Operation#" }),
          ...errorResponses(400, 404),
        },
        summary: "Detalhar operação",
        tags: ["operações"],
      },
    },
    async (request, reply) =>
      sendData(
        reply,
        store.source,
        await store.getOperation(request.params.txHash),
      ),
  );
}
