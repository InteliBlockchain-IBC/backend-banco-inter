import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { MockStore } from "./mock/store.js";
import {
  ApiProblem,
  createProblem,
  problemSchema,
  PROBLEM_BASE_URI,
} from "./problem.js";
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
  nodeEnv?: "development" | "production" | "test";
  /** Relógio injetável; os testes usam para controlar vencimentos. */
  now?: () => Date;
  /** Gerador de ids das intenções; o export de docs usa um determinístico. */
  newId?: () => string;
};

const securityHeaders = {
  "content-security-policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

type ProblemSpec = Readonly<{ detail: string; title: string; type: string }>;

function applySecurityHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(securityHeaders)) {
    reply.header(name, value);
  }
}

function describeProblem(status: number): ProblemSpec {
  if (status === 400) {
    return {
      detail: "A validação da requisição falhou.",
      title: "Requisição inválida",
      type: "validation-error",
    };
  }
  if (status === 404) {
    return {
      detail: "O recurso solicitado não existe.",
      title: "Recurso não encontrado",
      type: "not-found",
    };
  }
  if (status === 413) {
    return {
      detail: "O corpo da requisição excede o limite aceito.",
      title: "Carga excessiva",
      type: "payload-too-large",
    };
  }
  if (status >= 500) {
    return {
      detail: "O servidor não conseguiu processar a requisição.",
      title: "Erro interno do servidor",
      type: "internal-error",
    };
  }
  return {
    detail: "A requisição não pôde ser processada.",
    title: "Requisição inválida",
    type: "client-error",
  };
}

function classifyStatus(error: FastifyError, validation: boolean): number {
  if (validation) return 400;
  return typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
    ? error.statusCode
    : 500;
}

function sendProblem(
  reply: FastifyReply,
  correlationId: string,
  status: number,
) {
  const spec = describeProblem(status);
  return reply
    .code(status)
    .type("application/problem+json")
    .send(
      createProblem(
        correlationId,
        status,
        spec.title,
        spec.detail,
        `${PROBLEM_BASE_URI}${spec.type}`,
      ),
    );
}

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
  const logStackTrace = options.nodeEnv === "development";
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 16 * 1024,
    connectionTimeout: 10_000,
    frameworkErrors: (
      error: FastifyError,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const status = classifyStatus(error, false);
      request.log.warn(
        { code: error.code, correlationId: request.id, statusCode: status },
        "requisição rejeitada antes do handler",
      );
      applySecurityHeaders(reply);
      return sendProblem(reply, request.id, status);
    },
    logger:
      options.logger === false
        ? false
        : {
            redact: {
              censor: "[redigido]",
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'res.headers["set-cookie"]',
              ],
            },
            serializers: {
              req(request: FastifyRequest) {
                return {
                  id: request.id,
                  method: request.method,
                  url: request.url.split("?")[0] ?? request.url,
                };
              },
            },
          },
    requestTimeout: 15_000,
  });

  app.addHook("onSend", async (_request, reply) => {
    applySecurityHeaders(reply);
  });

  for (const schema of sharedSchemas) app.addSchema(schema);

  app.setErrorHandler((error: FastifyError | ApiProblem, request, reply) => {
    if (error instanceof ApiProblem) {
      request.log.warn({ problem: error.slug }, "requisição recusada");
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

    const validationError =
      "validation" in error && error.validation !== undefined;
    const status = classifyStatus(error, validationError);
    const clientError = status < 500;
    const fields: Record<string, unknown> = {
      code: error.code,
      correlationId: request.id,
      statusCode: status,
      type: error.name,
    };
    if (logStackTrace && error.stack !== undefined) fields.stack = error.stack;
    request.log[clientError ? "warn" : "error"](fields, "falha na requisição");
    return sendProblem(reply, request.id, status);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, request.id, 404),
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
        response: {
          200: { additionalProperties: true, type: "object" },
          500: problemSchema,
        },
        summary: "Contrato OpenAPI",
        tags: ["documentação"],
      },
    },
    async () => app.swagger(),
  );

  return app;
}
