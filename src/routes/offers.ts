import type { FastifyInstance } from "fastify";
import { type OfferStatus, offerStatuses } from "../domain.js";
import { sendData, sendList } from "../http.js";
import type { DataStore } from "../store.js";
import { ApiProblem } from "../problem.js";
import {
  dataEnvelope,
  errorResponses,
  listEnvelope,
  offerIdParams,
  paginationProperties,
  patterns,
  walletHeaderSchema,
} from "../schemas.js";

const listQuery = {
  additionalProperties: false,
  properties: {
    ...paginationProperties,
    role: {
      default: "any",
      description:
        "Com wallet: lender (ofertadas por ela), borrower (dirigidas a ela) ou any.",
      enum: ["lender", "borrower", "any"],
      type: "string",
    },
    status: {
      description: "Filtra pelo status apresentado.",
      enum: [...offerStatuses],
      type: "string",
    },
    wallet: {
      description: "Só ofertas em que a carteira é parte.",
      pattern: patterns.address,
      type: "string",
    },
  },
  type: "object",
} as const;

const createBody = {
  additionalProperties: false,
  properties: {
    amountCents: {
      description:
        "Valor em centavos de BRLt, string decimal (100000000 = R$ 1.000.000,00).",
      pattern: patterns.positiveCents,
      type: "string",
    },
    borrowerWallet: {
      description: "Carteira cadastrada do banco tomador (oferta direcionada).",
      pattern: patterns.address,
      type: "string",
    },
    rateCdiBps: {
      description: "Percentual do CDI em pontos-base (10500 = 105% do CDI).",
      maximum: 100_000,
      minimum: 1,
      type: "integer",
    },
    termDays: {
      description: "Prazo do empréstimo em dias (1 = overnight).",
      maximum: 365,
      minimum: 1,
      type: "integer",
    },
    validitySeconds: {
      description:
        "Janela, em segundos, para o tomador aceitar ou rejeitar (60 a 86400).",
      maximum: 86_400,
      minimum: 60,
      type: "integer",
    },
  },
  required: [
    "borrowerWallet",
    "amountCents",
    "rateCdiBps",
    "termDays",
    "validitySeconds",
  ],
  type: "object",
} as const;

type ListQuery = {
  limit: number;
  offset: number;
  role: "lender" | "borrower" | "any";
  status?: OfferStatus;
  wallet?: string;
};
type CreateBody = {
  amountCents: string;
  borrowerWallet: string;
  rateCdiBps: number;
  termDays: number;
  validitySeconds: number;
};
type WalletHeader = { "x-wallet-address": string };

const intentResponse = dataEnvelope({ $ref: "TransactionRequest#" });

const actions = [
  {
    action: "accept_offer",
    description:
      "Em development/test, cria uma intenção fictícia para a carteira informada em X-Wallet-Address; compara essa carteira ao tomador da fixture e checa o limite mock. Não autentica nem liquida.",
    path: "accept",
    summary: "Aceitar oferta (intenção)",
  },
  {
    action: "reject_offer",
    description:
      "Em development/test, registra intenção fictícia de rejeitar; compara a carteira declarada ao tomador, sem alterar a oferta.",
    path: "reject",
    summary: "Rejeitar oferta (intenção)",
  },
  {
    action: "cancel_offer",
    description:
      "Em development/test, registra intenção fictícia de cancelar; compara a carteira declarada ao ofertante, sem alterar a oferta.",
    path: "cancel",
    summary: "Cancelar oferta (intenção)",
  },
] as const;

export async function registerOfferRoutes(
  app: FastifyInstance,
  { store, enableIntents }: { store: DataStore; enableIntents: boolean },
): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/api/offers",
    {
      schema: {
        description:
          "Ofertas fictícias da instância, mais recentes primeiro. Use wallet + role e status=offered para filtrar fixtures e ofertas simuladas.",
        operationId: "listOffers",
        querystring: listQuery,
        response: { 200: listEnvelope("Offer"), ...errorResponses(400) },
        summary: "Listar ofertas",
        tags: ["ofertas"],
      },
    },
    async (request, reply) => {
      const { limit, offset, role, status, wallet } = request.query;
      return sendList(
        reply,
        store.source,
        await store.listOffers(
          {
            role,
            ...(status === undefined ? {} : { status }),
            ...(wallet === undefined ? {} : { wallet }),
          },
          { limit, offset },
        ),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/offers/:id",
    {
      schema: {
        description: "Detalhe de uma oferta, com a liquidação quando houver.",
        operationId: "getOffer",
        params: offerIdParams,
        response: {
          200: dataEnvelope({ $ref: "Offer#" }),
          ...errorResponses(400, 404),
        },
        summary: "Detalhar oferta",
        tags: ["ofertas"],
      },
    },
    async (request, reply) =>
      sendData(reply, store.source, await store.getOffer(request.params.id)),
  );

  app.get<{ Params: { id: string } }>(
    "/api/offers/:id/events",
    {
      schema: {
        description:
          "Histórico sintético da oferta em ordem de bloco e log, sem indexação on-chain.",
        operationId: "listOfferEvents",
        params: offerIdParams,
        response: {
          200: dataEnvelope({ items: { $ref: "ChainEvent#" }, type: "array" }),
          ...errorResponses(400, 404),
        },
        summary: "Histórico da oferta",
        tags: ["ofertas"],
      },
    },
    async (request, reply) =>
      sendData(reply, store.source, await store.offerEvents(request.params.id)),
  );
  if (!enableIntents) return;

  app.post<{ Body: CreateBody; Headers: WalletHeader }>(
    "/api/offers",
    {
      schema: {
        body: createBody,
        description:
          "Em development/test, devolve uma intenção fictícia e contractCall com endereços sintéticos; X-Wallet-Address não autentica. A oferta não entra na lista. Nenhum listener existe para confirmar a transação.",
        headers: walletHeaderSchema,
        operationId: "createOfferIntent",
        response: {
          202: intentResponse,
          ...errorResponses(400, 403, 422, 503),
        },
        summary: "Criar oferta (intenção)",
        tags: ["ofertas"],
      },
      // O Ajv do Fastify converte número em string; aqui isso esconderia perda de
      // precisão (JSON number > 2^53), então amountCents precisa chegar como string.
      preValidation: async (request) => {
        const body = request.body;
        if (
          typeof body === "object" &&
          body !== null &&
          "amountCents" in body &&
          typeof body.amountCents !== "string"
        ) {
          throw new ApiProblem(
            400,
            "validation-error",
            "Requisição inválida",
            "A validação da requisição falhou: body/amountCents must be string.",
          );
        }
      },
    },
    async (request, reply) =>
      sendData(
        reply,
        store.source,
        await store.createOfferIntent(
          request.headers["x-wallet-address"],
          request.body,
        ),
        202,
      ),
  );

  for (const { action, description, path, summary } of actions) {
    app.post<{ Params: { id: string }; Headers: WalletHeader }>(
      `/api/offers/:id/${path}`,
      {
        schema: {
          description,
          headers: walletHeaderSchema,
          operationId: `${path}OfferIntent`,
          params: offerIdParams,
          response: {
            202: intentResponse,
            ...errorResponses(400, 403, 404, 409, 422, 503),
          },
          summary,
          tags: ["ofertas"],
        },
      },
      async (request, reply) =>
        sendData(
          reply,
          store.source,
          await store.offerActionIntent(
            action,
            request.headers["x-wallet-address"],
            request.params.id,
          ),
          202,
        ),
    );
  }
}
