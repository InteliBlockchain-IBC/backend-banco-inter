import type { FastifyInstance } from "fastify";
import { problemSchema } from "../errors.js";
import type { Repository } from "../../repositories/repository.js";

const healthResponse = {
  additionalProperties: false,
  properties: { status: { const: "ok", type: "string" } },
  required: ["status"],
  type: "object",
} as const;

const readyResponse = {
  additionalProperties: false,
  properties: {
    dependencies: {
      items: {
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          status: { const: "up", type: "string" },
        },
        required: ["name", "status"],
        type: "object",
      },
      type: "array",
    },
    status: { const: "ready", type: "string" },
  },
  required: ["status", "dependencies"],
  type: "object",
} as const;

export async function registerHealthRoutes(
  app: FastifyInstance,
  { repository }: { repository: Repository },
): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        description: "Liveness: o processo está de pé.",
        operationId: "getHealth",
        response: { 200: healthResponse, 500: problemSchema },
        summary: "Liveness",
        tags: ["saúde"],
      },
    },
    async () => ({ status: "ok" }),
  );
  app.get(
    "/ready",
    {
      schema: {
        description:
          "Readiness: com PostgreSQL configurado, executa SELECT 1 e responde 503 se o banco não responder. Com o repositório em memória, não há dependências.",
        operationId: "getReady",
        response: {
          200: readyResponse,
          500: problemSchema,
          503: problemSchema,
        },
        summary: "Readiness",
        tags: ["saúde"],
      },
    },
    async () => {
      await repository.check();
      return {
        dependencies:
          repository.source === "postgres"
            ? [{ name: "postgres", status: "up" as const }]
            : [],
        status: "ready" as const,
      };
    },
  );
}
