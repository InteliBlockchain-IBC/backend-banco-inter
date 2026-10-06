import assert from "node:assert/strict";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { API_VERSION, buildApp } from "../src/app.js";

export const documentedOperations = [
  "GET /health",
  "GET /ready",
  "GET /openapi.json",
  "GET /api/deployment",
  "GET /api/sync-status",
  "GET /api/offers",
  "POST /api/offers",
  "POST /api/mock/offers",
  "POST /api/mock/offers/{id}/accept",
  "POST /api/mock/offers/{id}/reject",
  "POST /api/mock/offers/{id}/cancel",
  "GET /api/offers/{id}",
  "GET /api/offers/{id}/events",
  "POST /api/offers/{id}/accept",
  "POST /api/offers/{id}/reject",
  "POST /api/offers/{id}/cancel",
  "GET /api/transaction-requests/{id}",
  "POST /api/transaction-requests/{id}/submission",
  "GET /api/operations",
  "GET /api/operations/{txHash}",
  "GET /api/credit-limits",
  "GET /api/credit-limits/{wallet}",
  "GET /api/credit-limits/{wallet}/history",
];

test("generated OpenAPI is valid and documents every route", async (t) => {
  const app = await buildApp({ logger: false, nodeEnv: "development" });
  t.after(() => app.close());
  await app.ready();

  const document = app.swagger();
  await SwaggerParser.validate(structuredClone(document));

  assert.equal(document.info.version, API_VERSION);
  const found: string[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "post"] as const) {
      const operation = item?.[method];
      if (operation === undefined) continue;
      found.push(`${method.toUpperCase()} ${path}`);
      assert.ok(operation.summary, `${method} ${path} sem summary`);
      assert.ok(operation.operationId, `${method} ${path} sem operationId`);
      assert.ok(operation.tags?.length, `${method} ${path} sem tag`);
    }
  }
  assert.deepEqual(found.sort(), [...documentedOperations].sort());
});

test("shared schemas are published as named components", async (t) => {
  const app = await buildApp({ logger: false, nodeEnv: "development" });
  t.after(() => app.close());
  await app.ready();

  const document = app.swagger() as {
    components?: { schemas?: object };
    paths?: Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;
  };
  const schemas = Object.keys(document.components?.schemas ?? {});

  for (const name of [
    "Problem",
    "Party",
    "Offer",
    "ChainEvent",
    "Operation",
    "CreditLimit",
    "CreditLimitChange",
    "TransactionRequest",
    "Deployment",
    "SyncStatus",
  ]) {
    assert.ok(schemas.includes(name), name);
  }

  const paths = document.paths ?? {};
  for (const [path, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (method === "parameters") {
        continue;
      }
      assert.ok(
        operation.responses?.["500"],
        `${method.toUpperCase()} ${path} não declara resposta 500`,
      );
    }
  }
});

test("the documentation UI is not part of the contract", async (t) => {
  const app = await buildApp({ logger: false, nodeEnv: "development" });
  t.after(() => app.close());
  await app.ready();

  const document = app.swagger();

  assert.equal(document.paths?.["/docs"], undefined);
  assert.equal(document.paths?.["/api/operations/{txHash}/track"], undefined);
});
