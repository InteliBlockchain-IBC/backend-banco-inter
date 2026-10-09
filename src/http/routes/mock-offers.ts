import type { FastifyInstance } from "fastify";
import { sendData } from "../reply.js";
import type { Repository } from "../../repositories/repository.js";
import { ApiProblem } from "../errors.js";
import {
  dataEnvelope,
  errorResponses,
  offerIdParams,
  operationSchema,
  patterns,
} from "../schemas.js";

const createBody = {
  additionalProperties: false,
  properties: {
    lenderWallet: { pattern: patterns.address, type: "string" },
    borrowerWallet: { pattern: patterns.address, type: "string" },
    amountCents: {
      pattern: patterns.positiveCents,
      type: "string",
      description: "Centavos decimais positivos até uint256.",
    },
    rateCdiBps: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    termDays: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    validitySeconds: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
  required: [
    "lenderWallet",
    "borrowerWallet",
    "amountCents",
    "rateCdiBps",
    "termDays",
    "validitySeconds",
  ],
  type: "object",
} as const;

const simulatedResponse = dataEnvelope({
  additionalProperties: false,
  properties: {
    offer: { $ref: "Offer#" },
    operation: { ...operationSchema, nullable: true },
  },
  required: ["offer", "operation"],
  type: "object",
});

type CreateBody = {
  amountCents: string;
  borrowerWallet: string;
  lenderWallet: string;
  rateCdiBps: number;
  termDays: number;
  validitySeconds: number;
};

export async function registerSimulatedOfferRoutes(
  app: FastifyInstance,
  { repository }: { repository: Repository },
): Promise<void> {
  app.post<{ Body: CreateBody }>(
    "/api/mock/offers",
    {
      schema: {
        body: createBody,
        description:
          "Cria uma oferta e um evento sintéticos na fonte de dados ativa (PostgreSQL ou memória). lenderWallet não autentica ninguém; não envia transação nem transfere ativos.",
        operationId: "simulateOffer",
        response: { 201: simulatedResponse, ...errorResponses(400, 422, 503) },
        summary: "Simular criação de oferta",
        tags: ["simulação"],
      },
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
            "body/amountCents must be string.",
          );
        }
      },
    },
    async (request, reply) =>
      sendData(
        reply,
        repository.source,
        await repository.createSimulatedOffer(request.body),
        201,
      ),
  );

  for (const action of ["accept", "reject", "cancel"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/mock/offers/:id/${action}`,
      {
        schema: {
          description: `Simula ${action} de uma oferta e grava a transição na fonte de dados ativa; não verifica identidade nem assina ou envia transações. Hashes e eventos são fictícios.`,
          operationId: `simulate${action[0]?.toUpperCase()}${action.slice(1)}Offer`,
          params: offerIdParams,
          response: {
            200: simulatedResponse,
            ...errorResponses(400, 404, 409, 422),
          },
          summary: `Simular ${action} de oferta`,
          tags: ["simulação"],
        },
      },
      async (request, reply) =>
        sendData(
          reply,
          repository.source,
          await repository.simulatedOfferAction(request.params.id, action),
        ),
    );
  }
}
