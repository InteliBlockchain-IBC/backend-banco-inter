import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createProblem, problemSchema } from "./problem.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMockReadRoutes } from "./routes/mock-read.js";

export type NodeEnv = "development" | "production" | "test";

export type BuildAppOptions = Readonly<{
  logger?: boolean;
  nodeEnv?: NodeEnv;
}>;

/**
 * Cabeçalhos aplicados a toda resposta. A CSP permite `'unsafe-inline'` em script
 * e style porque a interface de documentação em `/docs` depende disso; as rotas
 * de `/api/*` não carregam script algum, então a diretiva não abre superfície ali.
 */
const securityHeaders = {
  "content-security-policy":
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

type ProblemSpec = Readonly<{ detail: string; title: string; type: string }>;

const CLIENT_ERROR_FLOOR = 400;
const SERVER_ERROR = 500;

function applySecurityHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(securityHeaders)) {
    reply.header(name, value);
  }
}

const internalError: ProblemSpec = {
  detail: "O servidor não conseguiu processar a requisição.",
  title: "Erro interno do servidor",
  type: "internal-error",
};

const unclassifiedClientError: ProblemSpec = {
  detail: "A requisição não pôde ser processada.",
  title: "Requisição inválida",
  type: "client-error",
};

/**
 * Um rótulo por status, para que a resposta diga a causa real. Um corpo grande
 * demais não é falha de validação, e o título anterior afirmava que era.
 */
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
  if (status >= SERVER_ERROR) {
    return internalError;
  }
  return unclassifiedClientError;
}

function classifyStatus(error: FastifyError, validation: boolean): number {
  if (validation) {
    return CLIENT_ERROR_FLOOR;
  }
  const declared = error.statusCode;
  if (
    typeof declared === "number" &&
    declared >= CLIENT_ERROR_FLOOR &&
    declared < SERVER_ERROR
  ) {
    return declared;
  }
  return SERVER_ERROR;
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
        `https://api.example.invalid/problems/${spec.type}`,
      ),
    );
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  // Padrão seguro: fora de `development` o stack nunca entra no log.
  const nodeEnv = options.nodeEnv ?? "production";
  const logStackTrace = nodeEnv === "development";

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
      // Este caminho não passa pelo hook `onSend`; sem a chamada explícita, a
      // resposta sairia sem os cabeçalhos de segurança que o resto do serviço usa.
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
                  // A querystring pode carregar segredo; o log guarda só o caminho.
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

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const validationError =
      "validation" in error && error.validation !== undefined;
    const status = classifyStatus(error, validationError);
    const clientError = status < SERVER_ERROR;

    const fields: Record<string, unknown> = {
      code: error.code,
      correlationId: request.id,
      statusCode: status,
      type: error.name,
    };
    if (logStackTrace && error.stack !== undefined) {
      fields.stack = error.stack;
    }
    // 4xx é erro do cliente e vai para `warn`; `error` fica reservado a 5xx.
    request.log[clientError ? "warn" : "error"](fields, "falha na requisição");

    return sendProblem(reply, request.id, status);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, request.id, 404),
  );

  await app.register(swagger, {
    openapi: {
      info: { title: "API do Backend Banco Inter", version: "0.1.0" },
      openapi: "3.0.3",
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(registerHealthRoutes);
  await app.register(registerMockReadRoutes);
  app.get(
    "/openapi.json",
    {
      schema: {
        response: {
          200: { additionalProperties: true, type: "object" },
          500: problemSchema,
        },
        tags: ["documentação"],
      },
    },
    async () => app.swagger(),
  );

  return app;
}
