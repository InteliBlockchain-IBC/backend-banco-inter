import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { MOCK_TRANSACTION_HASH } from "../src/routes/mock-read.js";

test("health reports a live process", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("readiness lists no unconfigured dependencies", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/ready" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { dependencies: [], status: "ready" });
});

test("mock offers are labelled in headers and bodies", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/offers" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-data-source"], "mock");
  assert.equal(response.json().meta.source, "mock");
});

test("every mock list route is labelled in headers and bodies", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  for (const url of ["/api/operations", "/api/credit-limits"]) {
    const response = await app.inject({ method: "GET", url });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-data-source"], "mock");
    assert.equal(response.json().meta.source, "mock");
  }
});

test("error responses on mock routes carry no mock marker", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const missingOffer = await app.inject({
    method: "GET",
    url: "/api/offers/no-such-offer",
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

test("a missing mock offer uses Problem Details", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/offers/no-such-offer",
  });

  assert.equal(response.statusCode, 404);
  assert.match(
    response.headers["content-type"] ?? "",
    /^application\/problem\+json/,
  );
  assert.equal(response.json().status, 404);
  assert.equal(typeof response.json().correlationId, "string");
});

test("unknown query fields are rejected instead of removed", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

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

test("mock operation details accept only an Ethereum-shaped hash", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const valid = await app.inject({
    method: "GET",
    url: `/api/operations/${MOCK_TRANSACTION_HASH}`,
  });
  const invalid = await app.inject({
    method: "GET",
    url: "/api/operations/not-a-hash",
  });

  assert.equal(valid.statusCode, 200);
  assert.equal(valid.json().meta.source, "mock");
  assert.equal(invalid.statusCode, 400);
});

test("a malformed body reports a truthful client error, not a server fault", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({
    headers: { "content-type": "application/json" },
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

test("the served OpenAPI document keeps the contract version", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/openapi.json" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().info.version, "0.1.0");
});

test("the human-readable documentation is served", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/docs" });

  assert.equal(response.statusCode, 200);
});

test("a malformed URL is answered with Problem Details", async (t) => {
  const app = await buildApp({ logger: true });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/api/offers/%ZZ",
  });

  assert.equal(response.statusCode, 400);
  assert.match(
    response.headers["content-type"] ?? "",
    /^application\/problem\+json/,
  );
  assert.equal(typeof response.json().correlationId, "string");
  assert.doesNotMatch(response.body, /FST_ERR_BAD_URL/);
});

test("every response carries the security headers", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  // A URL malformada passa pelo `frameworkErrors`, que não aciona o hook `onSend`:
  // era o único caminho que saía sem os cabeçalhos.
  for (const url of [
    "/health",
    "/api/offers",
    "/api/offers/no-such-offer",
    "/api/offers/%ZZ",
  ]) {
    const response = await app.inject({ method: "GET", url });

    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.match(
      String(response.headers["content-security-policy"]),
      /frame-ancestors 'none'/,
    );
  }
});

test("an oversized body is reported as a size problem, not a validation one", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({
    headers: { "content-type": "application/json" },
    method: "POST",
    payload: JSON.stringify({ pad: "x".repeat(20_000) }),
    url: "/api/offers",
  });

  assert.equal(response.statusCode, 413);
  assert.match(
    response.headers["content-type"] ?? "",
    /^application\/problem\+json/,
  );
  // Um corpo grande demais não é falha de validação, e antes era rotulado como se fosse.
  assert.equal(
    response.json().type,
    "https://api.example.invalid/problems/payload-too-large",
  );
});

test("an internal fault answers with the declared 500 envelope", async (t) => {
  const app = await buildApp({ logger: true });
  app.get("/falha-interna-de-teste", async () => {
    throw new Error("falha interna injetada pelo teste");
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/falha-interna-de-teste",
  });

  assert.equal(response.statusCode, 500);
  assert.match(
    response.headers["content-type"] ?? "",
    /^application\/problem\+json/,
  );
  assert.equal(
    response.json().type,
    "https://api.example.invalid/problems/internal-error",
  );
  assert.equal(typeof response.json().correlationId, "string");
  assert.doesNotMatch(
    response.body,
    /falha interna injetada pelo teste|stack|node_modules/,
  );
});
