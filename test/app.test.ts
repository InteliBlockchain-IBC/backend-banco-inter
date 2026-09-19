import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

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

const mockHash = `0x${"0".repeat(63)}1`;

test("mock offers are labelled in headers and bodies", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/offers" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-data-source"], "mock");
  assert.equal(response.json().meta.source, "mock");
});

test("a missing mock offer uses Problem Details", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/offers/no-such-offer" });

  assert.equal(response.statusCode, 404);
  assert.match(response.headers["content-type"] ?? "", /^application\/problem\+json/);
  assert.equal(response.json().status, 404);
  assert.equal(typeof response.json().correlationId, "string");
});

test("unknown query fields are rejected instead of removed", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/offers?unexpected=true" });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().type, "https://api.example.invalid/problems/validation-error");
});

test("mock operation details accept only an Ethereum-shaped hash", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());

  const valid = await app.inject({ method: "GET", url: `/api/operations/${mockHash}` });
  const invalid = await app.inject({ method: "GET", url: "/api/operations/not-a-hash" });

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
  assert.match(response.headers["content-type"] ?? "", /^application\/problem\+json/);
  assert.equal(response.json().status, 400);
  assert.equal(response.json().type, "https://api.example.invalid/problems/validation-error");
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
