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
