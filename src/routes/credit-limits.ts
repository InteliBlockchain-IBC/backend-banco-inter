import type { FastifyInstance } from "fastify";
import { sendData } from "../http.js";
import type { MockStore } from "../mock/store.js";
import {
  dataEnvelope,
  errorResponses,
  patterns,
  walletParams,
} from "../schemas.js";

const listQuery = {
  additionalProperties: false,
  properties: {
    excludeWallet: {
      description:
        "Remove uma carteira da lista (use a do próprio operador ao escolher o tomador).",
      pattern: patterns.address,
      type: "string",
    },
    minAvailableCents: {
      description:
        "Só carteiras com limite disponível maior ou igual (centavos, string decimal).",
      pattern: patterns.cents,
      type: "string",
    },
    registered: {
      description: "true: só carteiras marcadas como cadastradas nas fixtures.",
      type: "boolean",
    },
  },
  type: "object",
} as const;

type ListQuery = {
  excludeWallet?: string;
  minAvailableCents?: string;
  registered?: boolean;
};

export async function registerCreditLimitRoutes(
  app: FastifyInstance,
  { store }: { store: MockStore },
): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/api/credit-limits",
    {
      schema: {
        description:
          "Limites fictícios por carteira, maior primeiro. Para escolher tomador de uma simulação: registered=true, minAvailableCents=<valor> e excludeWallet=<carteira ofertante>.",
        operationId: "listCreditLimits",
        querystring: listQuery,
        response: {
          200: dataEnvelope({ items: { $ref: "CreditLimit#" }, type: "array" }),
          ...errorResponses(400),
        },
        summary: "Listar limites",
        tags: ["limites"],
      },
    },
    async (request, reply) =>
      sendData(reply, store.listCreditLimits(request.query)),
  );

  app.get<{ Params: { wallet: string } }>(
    "/api/credit-limits/:wallet",
    {
      schema: {
        description: "Limite fictício atual de uma carteira.",
        operationId: "getCreditLimit",
        params: walletParams,
        response: {
          200: dataEnvelope({ $ref: "CreditLimit#" }),
          ...errorResponses(400, 404),
        },
        summary: "Detalhar limite",
        tags: ["limites"],
      },
    },
    async (request, reply) =>
      sendData(reply, store.getCreditLimit(request.params.wallet)),
  );

  app.get<{ Params: { wallet: string } }>(
    "/api/credit-limits/:wallet/history",
    {
      schema: {
        description:
          "Histórico sintético de mudanças de limite, mais recentes primeiro: ajustes e débitos de liquidações fictícias.",
        operationId: "listCreditLimitHistory",
        params: walletParams,
        response: {
          200: dataEnvelope({
            items: { $ref: "CreditLimitChange#" },
            type: "array",
          }),
          ...errorResponses(400, 404),
        },
        summary: "Histórico de limite",
        tags: ["limites"],
      },
    },
    async (request, reply) =>
      sendData(reply, store.creditLimitHistory(request.params.wallet)),
  );
}
