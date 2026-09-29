import type { FastifyInstance } from "fastify";
import { type OfferStatus, offerStatuses } from "../domain.js";
import { sendData, sendList } from "../http.js";
import type { MockStore } from "../mock/store.js";
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
      "Registra a intenção do tomador de aceitar. A API antecipa as checagens do contrato (oferta aberta, carteira tomadora, as duas partes cadastradas e limite suficiente). O aceite e a liquidação DvP acontecem na mesma transação on-chain.",
    path: "accept",
    summary: "Aceitar oferta (intenção)",
  },
  {
    action: "reject_offer",
    description:
      "Registra a intenção do tomador de recusar a oferta antes do vencimento. Estado final on-chain: rejected.",
    path: "reject",
    summary: "Rejeitar oferta (intenção)",
  },
  {
    action: "cancel_offer",
    description:
      "Registra a intenção do ofertante de retirar a oferta antes do aceite e do vencimento. Estado final on-chain: cancelled.",
    path: "cancel",
    summary: "Cancelar oferta (intenção)",
  },
] as const;

export async function registerOfferRoutes(
  app: FastifyInstance,
  { store }: { store: MockStore },
): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/api/offers",
    {
      schema: {
        description:
          "Ofertas confirmadas on-chain, mais recentes primeiro. Use wallet + role para a mesa de um banco e status=offered para as ofertas abertas.",
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
        store.listOffers(
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
      sendData(reply, store.getOffer(request.params.id)),
  );

  app.get<{ Params: { id: string } }>(
    "/api/offers/:id/events",
    {
      schema: {
        description:
          "Histórico on-chain da oferta em ordem de bloco e log: OfferCreated, OfferAccepted, OfferSettled, OfferRejected, OfferCancelled ou OfferExpired.",
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
      sendData(reply, store.offerEvents(request.params.id)),
  );

  app.post<{ Body: CreateBody; Headers: WalletHeader }>(
    "/api/offers",
    {
      schema: {
        body: createBody,
        description:
          "Registra a intenção de criar uma oferta direcionada e devolve contractCall para a carteira assinar. A oferta só aparece em GET /api/offers depois que o listener indexar OfferCreated. A API antecipa as checagens do contrato: ofertante e tomador cadastrados, partes diferentes e limite do tomador >= amountCents.",
        headers: walletHeaderSchema,
        operationId: "createOfferIntent",
        response: {
          202: intentResponse,
          ...errorResponses(400, 403, 422),
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
        store.createOfferIntent(
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
            ...errorResponses(400, 403, 404, 409, 422),
          },
          summary,
          tags: ["ofertas"],
        },
      },
      async (request, reply) =>
        sendData(
          reply,
          store.offerActionIntent(
            action,
            request.headers["x-wallet-address"],
            request.params.id,
          ),
          202,
        ),
    );
  }
}
