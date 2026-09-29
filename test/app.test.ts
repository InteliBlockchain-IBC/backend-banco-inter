import assert from "node:assert/strict";
import test from "node:test";
import { API_VERSION, buildApp } from "../src/app.js";
import { hashOf, mockOfferId, mockWallets, offers, setup } from "./support.js";

test("health reports a live process", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("readiness lists no unconfigured dependencies", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({ method: "GET", url: "/ready" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { dependencies: [], status: "ready" });
});

test("every successful /api response is labelled mock in headers and bodies", async (t) => {
  const { app } = await setup(t);
  const settledTx = (
    await app.inject({ method: "GET", url: "/api/operations" })
  ).json().data[0].txHash;

  for (const url of [
    "/api/offers",
    `/api/offers/${mockOfferId(offers.openAlfaToBeta)}`,
    `/api/offers/${mockOfferId(offers.openAlfaToBeta)}/events`,
    "/api/operations",
    `/api/operations/${settledTx}`,
    "/api/credit-limits",
    `/api/credit-limits/${mockWallets.alfa}`,
    `/api/credit-limits/${mockWallets.alfa}/history`,
    "/api/deployment",
    "/api/sync-status",
  ]) {
    const response = await app.inject({ method: "GET", url });

    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers["x-data-source"], "mock", url);
    assert.equal(response.json().meta.source, "mock", url);
  }
});

test("error responses carry no mock marker", async (t) => {
  const { app } = await setup(t);

  const missingOffer = await app.inject({
    method: "GET",
    url: `/api/offers/${mockOfferId(999)}`,
  });
  const unknownQueryField = await app.inject({
    method: "GET",
    url: "/api/offers?unexpected=true",
  });

  assert.equal(missingOffer.statusCode, 404);
  assert.equal(unknownQueryField.statusCode, 400);

  for (const response of [missingOffer, unknownQueryField]) {
    assert.equal(response.headers["x-data-source"], undefined);
    assert.equal(response.json().meta, undefined);
  }
});

test("a missing offer uses Problem Details", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({
    method: "GET",
    url: `/api/offers/${mockOfferId(999)}`,
  });

  assert.equal(response.statusCode, 404);
  assert.match(
    response.headers["content-type"] ?? "",
    /^application\/problem\+json/,
  );
  assert.equal(response.json().status, 404);
  assert.equal(
    response.json().type,
    "https://api.example.invalid/problems/not-found",
  );
  assert.equal(typeof response.json().correlationId, "string");
});

test("unknown routes use Problem Details", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({ method: "GET", url: "/api/nothing" });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().title, "Recurso não encontrado");
});

test("unknown query fields are rejected instead of removed", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({
    method: "GET",
    url: "/api/offers?unexpected=true",
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.json().type,
    "https://api.example.invalid/problems/validation-error",
  );
});

test("path parameters are validated before lookup", async (t) => {
  const { app } = await setup(t);

  for (const url of [
    "/api/offers/not-a-uuid",
    "/api/operations/not-a-hash",
    "/api/credit-limits/0x123",
    "/api/transaction-requests/42",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 400, url);
  }
});

test("a malformed body reports a truthful client error, not a server fault", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({
    headers: {
      "content-type": "application/json",
      "x-wallet-address": mockWallets.alfa,
    },
    method: "POST",
    payload: "{ not json",
    url: "/api/offers",
  });

  assert.equal(response.statusCode, 400);
  assert.match(
    response.headers["content-type"] ?? "",
    /^application\/problem\+json/,
  );
  assert.equal(response.json().status, 400);
  assert.equal(
    response.json().type,
    "https://api.example.invalid/problems/validation-error",
  );
  assert.equal(typeof response.json().correlationId, "string");
  assert.doesNotMatch(response.body, /FST_ERR|Unexpected token|SyntaxError/);
});

test("an unexpected failure is a generic 500 without internals", async (t) => {
  const { app } = await setup(t);
  app.get("/boom", async () => {
    throw new Error("segredo interno");
  });

  const response = await app.inject({ method: "GET", url: "/boom" });

  assert.equal(response.statusCode, 500);
  assert.equal(
    response.json().type,
    "https://api.example.invalid/problems/internal-error",
  );
  assert.doesNotMatch(response.body, /segredo interno/);
});

test("the served OpenAPI document carries the contract version", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({ method: "GET", url: "/openapi.json" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().info.version, API_VERSION);
});

test("the human-readable documentation is served", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({ method: "GET", url: "/docs" });

  assert.equal(response.statusCode, 200);
});

test("hash lookups are case-insensitive", async (t) => {
  const { app } = await setup(t);
  const tx: string = (
    await app.inject({ method: "GET", url: "/api/operations" })
  ).json().data[0].txHash;

  const response = await app.inject({
    method: "GET",
    url: `/api/operations/0x${tx.slice(2).toUpperCase()}`,
  });
  const missing = await app.inject({
    method: "GET",
    url: `/api/operations/${hashOf("ee")}`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.txHash, tx);
  assert.equal(missing.statusCode, 404);
});

test("a malformed URL is answered with Problem Details and security headers", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/offers/%ZZ" });

  assert.equal(response.statusCode, 400);
  assert.match(
    response.headers["content-type"] ?? "",
    /^application\/problem\+json/,
  );
  assert.equal(typeof response.json().correlationId, "string");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
});

test("every response carries the security headers", async (t) => {
  const { app } = await setup(t);

  for (const url of [
    "/health",
    "/api/offers",
    `/api/offers/${mockOfferId(999)}`,
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.headers["x-content-type-options"], "nosniff", url);
    assert.equal(response.headers["x-frame-options"], "DENY", url);
    assert.equal(response.headers["referrer-policy"], "no-referrer", url);
    assert.match(
      String(response.headers["content-security-policy"]),
      /frame-ancestors 'none'/,
    );
  }
});

test("an oversized body is reported as a size problem", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({
    headers: { "content-type": "application/json" },
    method: "POST",
    payload: JSON.stringify({ pad: "x".repeat(20_000) }),
    url: "/api/offers",
  });

  assert.equal(response.statusCode, 413);
  assert.equal(
    response.json().type,
    "https://api.example.invalid/problems/payload-too-large",
  );
});
