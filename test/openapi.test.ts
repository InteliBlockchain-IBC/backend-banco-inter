import assert from "node:assert/strict";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { buildApp } from "../src/app.js";

test("generated OpenAPI is valid and documents all executable API routes", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  await app.ready();

  const document = app.swagger();
  await SwaggerParser.validate(document);

  assert.equal(document.info.version, "0.1.0");
  for (const path of [
    "/health",
    "/ready",
    "/api/offers",
    "/api/offers/{id}",
    "/api/operations",
    "/api/operations/{txHash}",
    "/api/credit-limits",
  ]) {
    assert.ok(document.paths?.[path]);
  }

  const paths = (document.paths ?? {}) as Record<
    string,
    Record<string, { responses?: Record<string, unknown> }>
  >;
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
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  await app.ready();

  const document = app.swagger();

  assert.equal(document.paths?.["/docs"], undefined);
  assert.equal(document.paths?.["/api/operations/{txHash}/track"], undefined);
});
