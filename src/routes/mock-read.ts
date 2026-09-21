import type { FastifyInstance, FastifyReply } from "fastify";
import { createProblem, problemSchema } from "../problem.js";

export const MOCK_TRANSACTION_HASH = `0x${"0".repeat(63)}1`;

const meta = { source: "mock" } as const;
const offers = [
  { id: "mock-offer-001", label: "Oferta fictícia 001" },
] as const;
const operations = [
  { label: "Operação fictícia 001", txHash: MOCK_TRANSACTION_HASH },
] as const;
const creditLimits = [
  { institutionId: "mock-institution-001", label: "Instituição fictícia" },
] as const;

const closedQuerySchema = {
  additionalProperties: false,
  properties: {},
  type: "object",
} as const;
const offerParamsSchema = {
  additionalProperties: false,
  properties: { id: { minLength: 1, type: "string" } },
  required: ["id"],
  type: "object",
} as const;
const transactionParamsSchema = {
  additionalProperties: false,
  properties: { txHash: { pattern: "^0x[a-fA-F0-9]{64}$", type: "string" } },
  required: ["txHash"],
  type: "object",
} as const;

const metaSchema = {
  additionalProperties: false,
  properties: { source: { const: "mock", type: "string" } },
  required: ["source"],
  type: "object",
} as const;

const offerSchema = {
  additionalProperties: false,
  properties: { id: { type: "string" }, label: { type: "string" } },
  required: ["id", "label"],
  type: "object",
} as const;
const operationSchema = {
  additionalProperties: false,
  properties: { label: { type: "string" }, txHash: { type: "string" } },
  required: ["label", "txHash"],
  type: "object",
} as const;
const creditLimitSchema = {
  additionalProperties: false,
  properties: { institutionId: { type: "string" }, label: { type: "string" } },
  required: ["institutionId", "label"],
  type: "object",
} as const;

function mockEnvelope(dataSchema: unknown) {
  return {
    additionalProperties: false,
    properties: { data: dataSchema, meta: metaSchema },
    required: ["data", "meta"],
    type: "object",
  } as const;
}

const offerListResponse = mockEnvelope({ items: offerSchema, type: "array" });
const offerResponse = mockEnvelope(offerSchema);
const operationListResponse = mockEnvelope({
  items: operationSchema,
  type: "array",
});
const operationResponse = mockEnvelope(operationSchema);
const creditLimitListResponse = mockEnvelope({
  items: creditLimitSchema,
  type: "array",
});

function sendMock<T>(reply: FastifyReply, data: T) {
  return reply.header("x-data-source", "mock").send({ data, meta });
}

function notFound(reply: FastifyReply, requestId: string) {
  return reply
    .code(404)
    .type("application/problem+json")
    .send(
      createProblem(
        requestId,
        404,
        "Recurso não encontrado",
        "O recurso mock solicitado não existe.",
        "https://api.example.invalid/problems/not-found",
      ),
    );
}

export async function registerMockReadRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/offers",
    {
      schema: {
        querystring: closedQuerySchema,
        response: { 200: offerListResponse, 400: problemSchema },
        tags: ["mocks"],
      },
    },
    async (_request, reply) => sendMock(reply, offers),
  );
  app.get<{ Params: { id: string } }>(
    "/api/offers/:id",
    {
      schema: {
        params: offerParamsSchema,
        response: {
          200: offerResponse,
          400: problemSchema,
          404: problemSchema,
        },
        tags: ["mocks"],
      },
    },
    async (request, reply) => {
      const offer = offers.find((item) => item.id === request.params.id);
      return offer ? sendMock(reply, offer) : notFound(reply, request.id);
    },
  );
  app.get(
    "/api/operations",
    {
      schema: {
        querystring: closedQuerySchema,
        response: { 200: operationListResponse, 400: problemSchema },
        tags: ["mocks"],
      },
    },
    async (_request, reply) => sendMock(reply, operations),
  );
  app.get<{ Params: { txHash: string } }>(
    "/api/operations/:txHash",
    {
      schema: {
        params: transactionParamsSchema,
        response: {
          200: operationResponse,
          400: problemSchema,
          404: problemSchema,
        },
        tags: ["mocks"],
      },
    },
    async (request, reply) => {
      const operation = operations.find(
        (item) => item.txHash === request.params.txHash,
      );
      return operation
        ? sendMock(reply, operation)
        : notFound(reply, request.id);
    },
  );
  app.get(
    "/api/credit-limits",
    {
      schema: {
        querystring: closedQuerySchema,
        response: { 200: creditLimitListResponse, 400: problemSchema },
        tags: ["mocks"],
      },
    },
    async (_request, reply) => sendMock(reply, creditLimits),
  );
}
