import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { createProblem } from "./problem.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMockReadRoutes } from "./routes/mock-read.js";

export async function buildApp(
  options: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 16 * 1024,
    logger: options.logger ?? true,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
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
          clientError
            ? "A validação da requisição falhou."
            : "O servidor não conseguiu processar a requisição.",
          `https://api.example.invalid/problems/${clientError ? "validation-error" : "internal-error"}`,
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
          "https://api.example.invalid/problems/not-found",
        ),
      ),
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
        response: { 200: { additionalProperties: true, type: "object" } },
        tags: ["documentação"],
      },
    },
    async () => app.swagger(),
  );

  return app;
}
