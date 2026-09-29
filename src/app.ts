import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { MockStore } from "./mock/store.js";
import { ApiProblem, createProblem, PROBLEM_BASE_URI } from "./problem.js";
import { registerChainRoutes } from "./routes/chain.js";
import { registerCreditLimitRoutes } from "./routes/credit-limits.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerOfferRoutes } from "./routes/offers.js";
import { registerOperationRoutes } from "./routes/operations.js";
import { registerTransactionRequestRoutes } from "./routes/transaction-requests.js";
import { sharedSchemas } from "./schemas.js";

export const API_VERSION = "0.2.0";

export type BuildOptions = {
  logger?: boolean;
  /** Relógio injetável; os testes usam para controlar vencimentos. */
  now?: () => Date;
  /** Gerador de ids das intenções; o export de docs usa um determinístico. */
  newId?: () => string;
};

const tags = [
  {
    description:
      "Ofertas confirmadas on-chain e intenções de criar, aceitar, rejeitar e cancelar.",
    name: "ofertas",
  },
  {
    description:
      "Ciclo de uma intenção: pending até o frontend informar o hash, depois submitted até o listener confirmar.",
    name: "intenções",
  },
  {
    description: "Histórico de liquidações DvP (comprovantes).",
    name: "operações",
  },
  {
    description: "Limites de crédito por carteira e seu histórico.",
    name: "limites",
  },
  { description: "Contratos implantados e estado do listener.", name: "rede" },
  { description: "Liveness e readiness do processo.", name: "saúde" },
  {
    description: "Contrato OpenAPI servido pela aplicação.",
    name: "documentação",
  },
];

export async function buildApp(
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date());
  const store = new MockStore(now, options.newId);
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 16 * 1024,
    logger: options.logger ?? true,
  });

  for (const schema of sharedSchemas) app.addSchema(schema);

  app.setErrorHandler((error: FastifyError | ApiProblem, request, reply) => {
    if (error instanceof ApiProblem) {
      request.log.info({ problem: error.slug }, "requisição recusada");
      return reply
        .code(error.status)
        .type("application/problem+json")
        .send(
          createProblem(
            request.id,
            error.status,
            error.title,
            error.message,
            `${PROBLEM_BASE_URI}${error.slug}`,
          ),
        );
    }

    request.log.error({ err: error }, "falha na requisição");

    const validationError =
      "validation" in error && error.validation !== undefined;
    const clientStatus =
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : undefined;
    const status = validationError ? 400 : (clientStatus ?? 500);
    const clientError = status < 500;
    return reply
      .code(status)
      .type("application/problem+json")
      .send(
        createProblem(
          request.id,
          status,
          clientError ? "Requisição inválida" : "Erro interno do servidor",
          validationError
            ? `A validação da requisição falhou: ${error.message}.`
            : clientError
              ? "A validação da requisição falhou."
              : "O servidor não conseguiu processar a requisição.",
          `${PROBLEM_BASE_URI}${clientError ? "validation-error" : "internal-error"}`,
        ),
      );
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .type("application/problem+json")
      .send(
        createProblem(
          request.id,
          404,
          "Recurso não encontrado",
          "O recurso solicitado não existe.",
          `${PROBLEM_BASE_URI}not-found`,
        ),
      ),
  );

  await app.register(swagger, {
    openapi: {
      info: {
        description:
          "API da PoC de crédito interfinanceiro overnight (Banco Inter x Inteli Blockchain). Nesta versão todas as respostas de /api/* são fictícias (x-data-source: mock). A API nunca assina transações: ela registra intenções e devolve contractCall para a carteira do operador. Guia completo em docs/api.md.",
        license: { name: "MIT" },
        title: "API do Backend Banco Inter",
        version: API_VERSION,
      },
      openapi: "3.0.3",
      servers: [{ description: "Local", url: "http://127.0.0.1:3000" }],
      tags,
    },
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, index) =>
        typeof json.$id === "string" ? json.$id : `def-${index}`,
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(registerHealthRoutes);
  await app.register(registerChainRoutes, { store });
  await app.register(registerOfferRoutes, { store });
  await app.register(registerTransactionRequestRoutes, { store });
  await app.register(registerOperationRoutes, { store });
  await app.register(registerCreditLimitRoutes, { store });
  app.get(
    "/openapi.json",
    {
      schema: {
        description: "Documento OpenAPI 3.0 desta versão.",
        operationId: "getOpenApi",
        response: { 200: { additionalProperties: true, type: "object" } },
        summary: "Contrato OpenAPI",
        tags: ["documentação"],
      },
    },
    async () => app.swagger(),
  );

  return app;
}
