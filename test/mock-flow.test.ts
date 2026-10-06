import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { mockOfferId, mockWallets, setup } from "./support.js";

const body = {
  lenderWallet: mockWallets.alfa,
  borrowerWallet: mockWallets.beta,
  amountCents: "100000000",
  rateCdiBps: 10_500,
  termDays: 1,
  validitySeconds: 60,
};

test("simulated create and accept update GET offers, events, receipt and borrower limit atomically", async (t) => {
  const { app } = await setup(t);
  const create = await app.inject({
    method: "POST",
    url: "/api/mock/offers",
    payload: body,
  });
  assert.equal(create.statusCode, 201);
  assert.equal(create.headers["x-data-source"], "mock");
  assert.equal(create.json().meta.source, "mock");
  const offer = create.json().data.offer;
  assert.equal(offer.status, "offered");
  assert.equal(offer.onchainOfferId, "10");
  assert.equal(create.json().data.operation, null);
  const before = await app.inject({
    method: "GET",
    url: `/api/offers/${offer.id}/events`,
  });
  assert.deepEqual(
    before.json().data.map((event: { eventName: string }) => event.eventName),
    ["OfferCreated"],
  );

  const accept = await app.inject({
    method: "POST",
    url: `/api/mock/offers/${offer.id}/accept`,
  });
  assert.equal(accept.statusCode, 200);
  assert.equal(accept.json().data.offer.status, "settled");
  const operation = accept.json().data.operation;
  assert.equal(operation.offerId, offer.id);
  assert.equal(operation.positionTokenId, "10");
  assert.match(operation.txHash, /^0x[a-f0-9]{64}$/);
  const [detail, events, receipt, limit, history, listed] = await Promise.all([
    app.inject({ method: "GET", url: `/api/offers/${offer.id}` }),
    app.inject({ method: "GET", url: `/api/offers/${offer.id}/events` }),
    app.inject({ method: "GET", url: `/api/operations/${operation.txHash}` }),
    app.inject({
      method: "GET",
      url: `/api/credit-limits/${mockWallets.beta}`,
    }),
    app.inject({
      method: "GET",
      url: `/api/credit-limits/${mockWallets.beta}/history`,
    }),
    app.inject({ method: "GET", url: "/api/offers?status=settled" }),
  ]);
  assert.equal(detail.json().data.settlement.txHash, operation.txHash);
  assert.deepEqual(
    events.json().data.map((event: { eventName: string }) => event.eventName),
    ["OfferCreated", "OfferAccepted", "OfferSettled"],
  );
  assert.deepEqual(
    events
      .json()
      .data.slice(1)
      .map((event: { txHash: string }) => event.txHash),
    [operation.txHash, operation.txHash],
  );
  assert.equal(receipt.json().data.offerId, offer.id);
  assert.equal(limit.json().data.availableLimitCents, "14900000000");
  assert.equal(history.json().data[0].changeKind, "settlement");
  assert.ok(
    listed.json().data.some((item: { id: string }) => item.id === offer.id),
  );
  const repeat = await app.inject({
    method: "POST",
    url: `/api/mock/offers/${offer.id}/accept`,
  });
  assert.equal(repeat.statusCode, 409);
  assert.equal(
    (
      await app.inject({ method: "GET", url: `/api/offers/${offer.id}/events` })
    ).json().data.length,
    3,
  );
});

test("simulated reject and cancel are terminal and never debit a credit limit", async (t) => {
  const { app } = await setup(t);
  for (const [action, status, event] of [
    ["reject", "rejected", "OfferRejected"],
    ["cancel", "cancelled", "OfferCancelled"],
  ]) {
    const created = await app.inject({
      method: "POST",
      url: "/api/mock/offers",
      payload: body,
    });
    const id = created.json().data.offer.id;
    const result = await app.inject({
      method: "POST",
      url: `/api/mock/offers/${id}/${action}`,
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().data.offer.status, status);
    assert.equal(result.json().data.operation, null);
    const events = await app.inject({
      method: "GET",
      url: `/api/offers/${id}/events`,
    });
    assert.equal(events.json().data[1].eventName, event);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/mock/offers/${id}/accept`,
        })
      ).statusCode,
      409,
    );
  }
  const limit = await app.inject({
    method: "GET",
    url: `/api/credit-limits/${mockWallets.beta}`,
  });
  assert.equal(limit.json().data.availableLimitCents, "15000000000");
});

test("two competing simulated acceptances cannot debit the same borrower limit twice", async (t) => {
  const { app } = await setup(t);
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const response = await app.inject({
      method: "POST",
      url: "/api/mock/offers",
      payload: { ...body, amountCents: "15000000000" },
    });
    assert.equal(response.statusCode, 201);
    ids.push(response.json().data.offer.id);
  }
  const results = await Promise.all(
    ids.map((id) =>
      app.inject({ method: "POST", url: `/api/mock/offers/${id}/accept` }),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.statusCode).sort(),
    [200, 422],
  );
  const limit = await app.inject({
    method: "GET",
    url: `/api/credit-limits/${mockWallets.beta}`,
  });
  assert.equal(limit.json().data.availableLimitCents, "0");
  const events = await Promise.all(
    ids.map((id) =>
      app.inject({ method: "GET", url: `/api/offers/${id}/events` }),
    ),
  );
  assert.deepEqual(
    events.map((response) => response.json().data.length).sort(),
    [1, 3],
  );
});

test("failed and expired simulated actions leave the state and history unchanged", async (t) => {
  const { app, clock } = await setup(t);
  for (const patch of [
    { amountCents: 100 },
    { amountCents: "0" },
    { amountCents: "9".repeat(79) },
    { borrowerWallet: mockWallets.alfa },
    { borrowerWallet: mockWallets.delta },
    { lenderWallet: `0x${"00".repeat(20)}` },
    { amountCents: "15000000001" },
    { validitySeconds: Number.MAX_SAFE_INTEGER },
  ]) {
    const bad = await app.inject({
      method: "POST",
      url: "/api/mock/offers",
      payload: { ...body, ...patch },
    });
    assert.ok(bad.statusCode >= 400, JSON.stringify(patch));
  }
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/offers" })).json().meta.total,
    9,
  );
  const created = await app.inject({
    method: "POST",
    url: "/api/mock/offers",
    payload: body,
  });
  const id = created.json().data.offer.id;
  clock.advance(60_000);
  const expired = await app.inject({
    method: "POST",
    url: `/api/mock/offers/${id}/accept`,
  });
  assert.equal(expired.statusCode, 409);
  assert.equal(
    (await app.inject({ method: "GET", url: `/api/offers/${id}` })).json().data
      .status,
    "expired",
  );
  assert.equal(
    (
      await app.inject({ method: "GET", url: `/api/offers/${id}/events` })
    ).json().data.length,
    1,
  );
});

test("simulated offers have a hard per-instance cap and no effects on another app", async (t) => {
  const { app } = await setup(t);
  for (let index = 9; index < 100; index++) {
    const created = await app.inject({
      method: "POST",
      url: "/api/mock/offers",
      payload: body,
    });
    assert.equal(created.statusCode, 201, `offer ${index + 1}`);
  }
  const full = await app.inject({
    method: "POST",
    url: "/api/mock/offers",
    payload: body,
  });
  assert.equal(full.statusCode, 503);
  assert.match(full.json().type, /mock-store-full$/);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/offers?limit=100" })).json()
      .meta.total,
    100,
  );
  const other = await buildApp({ logger: false, nodeEnv: "test" });
  t.after(() => other.close());
  assert.equal(
    (await other.inject({ method: "GET", url: "/api/offers" })).json().meta
      .total,
    9,
  );
});

test("production and default app expose neither simulated writes nor unauthenticated intent writes", async (t) => {
  for (const nodeEnv of ["production", undefined] as const) {
    const app = await buildApp({
      logger: false,
      ...(nodeEnv ? { nodeEnv } : {}),
    });
    t.after(() => app.close());
    await app.ready();
    const document = app.swagger();
    for (const url of [
      "/api/mock/offers",
      `/api/mock/offers/${mockOfferId(8)}/accept`,
      `/api/mock/offers/${mockOfferId(8)}/reject`,
      `/api/mock/offers/${mockOfferId(8)}/cancel`,
      "/api/offers",
      `/api/offers/${mockOfferId(8)}/accept`,
      `/api/offers/${mockOfferId(8)}/reject`,
      `/api/offers/${mockOfferId(8)}/cancel`,
      `/api/transaction-requests/${mockOfferId(8)}/submission`,
    ]) {
      assert.equal(
        (await app.inject({ method: "POST", url, payload: body })).statusCode,
        404,
        url,
      );
    }
    assert.equal(document.paths?.["/api/mock/offers"], undefined);
    assert.equal(document.paths?.["/api/offers"]?.post, undefined);
    assert.equal(
      document.paths?.["/api/transaction-requests/{id}/submission"],
      undefined,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/offers" })).statusCode,
      200,
    );
  }
});
