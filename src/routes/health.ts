import type { FastifyInstance } from "fastify";
import { problemSchema } from "../problem.js";

const healthResponse = {
  additionalProperties: false,
  properties: { status: { const: "ok", type: "string" } },
  required: ["status"],
  type: "object",
} as const;

const readyResponse = {
  additionalProperties: false,
  properties: {
    dependencies: { items: {}, type: "array" },
    status: { const: "ready", type: "string" },
  },
  required: ["status", "dependencies"],
  type: "object",
} as const;

export async function registerHealthRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        response: { 200: healthResponse, 500: problemSchema },
        tags: ["saúde"],
      },
    },
    async () => ({ status: "ok" }),
  );
  app.get(
    "/ready",
    {
      schema: {
        response: { 200: readyResponse, 500: problemSchema },
        tags: ["saúde"],
      },
    },
    async () => ({ dependencies: [], status: "ready" }),
  );
}
