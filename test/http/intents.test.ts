import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { REQUEST_TTL_MS } from "../../src/repositories/in-memory/in-memory-repository.js";
import {
  hashOf,
  mixedCase,
  mockOfferId,
  mockWallets,
  offers,
  setup,
} from "../support.js";

const PROBLEMS = "https://api.example.invalid/problems/";

const validOffer = {
  amountCents: "100000000",
  borrowerWallet: mockWallets.beta,
  rateCdiBps: 10_500,
  termDays: 1,
  validitySeconds: 3_600,
};

function createOffer(
  app: FastifyInstance,
  wallet: string | undefined,
  body: Record<string, unknown> = validOffer,
) {
  return app.inject({
    headers: wallet === undefined ? {} : { "x-wallet-address": wallet },
    method: "POST",
    payload: body,
    url: "/api/offers",
  });
}

function offerAction(
  app: FastifyInstance,
  action: "accept" | "reject" | "cancel",
  offer: number,
  wallet: string,
) {
  return app.inject({
    headers: { "x-wallet-address": wallet },
    method: "POST",
    url: `/api/offers/${mockOfferId(offer)}/${action}`,
  });
}

function submit(
  app: FastifyInstance,
  id: string,
  wallet: string,
  txHash: string,
) {
  return app.inject({
    headers: { "x-wallet-address": wallet },
    method: "POST",
    payload: { txHash },
    url: `/api/transaction-requests/${id}/submission`,
  });
}

test("creating an offer returns a pending intent with a ready contract call", async (t) => {
  const { app } = await setup(t);

  const response = await createOffer(app, mixedCase(mockWallets.alfa), {
    ...validOffer,
    borrowerWallet: mixedCase(mockWallets.beta),
  });
  const intent = response.json().data;

  assert.equal(response.statusCode, 202);
  assert.equal(response.headers["x-data-source"], "mock");
  assert.equal(intent.action, "create_offer");
  assert.equal(intent.status, "pending");
  assert.equal(intent.requesterWallet, mockWallets.alfa);
  assert.equal(intent.offerId, null);
  assert.equal(intent.txHash, null);
  assert.deepEqual(intent.params, validOffer);
  assert.deepEqual(intent.contractCall, {
    args: [mockWallets.beta, "100000000", "10500", "1", "3600"],
    chainId: 11155111,
    contractAddress: `0x${"0c".repeat(20)}`,
    functionName: "createOffer",
  });
  assert.equal(
    Date.parse(intent.expiresAt) - Date.parse(intent.createdAt),
    REQUEST_TTL_MS,
  );
});

test("creating an offer does not add it to the list before the listener sees it", async (t) => {
  const { app } = await setup(t);

  await createOffer(app, mockWallets.alfa);
  const list = await app.inject({ method: "GET", url: "/api/offers" });

  assert.equal(list.json().meta.total, 9);
});

test("creating an offer requires the wallet header", async (t) => {
  const { app } = await setup(t);

  const response = await createOffer(app, undefined);

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().detail, "A validação da requisição falhou.");
});

test("creating an offer rejects malformed or out-of-range fields", async (t) => {
  const { app } = await setup(t);

  for (const patch of [
    { amountCents: "0" },
    { amountCents: 100 },
    { amountCents: "1.5" },
    { rateCdiBps: 0 },
    { termDays: 0 },
    { validitySeconds: 30 },
    { borrowerWallet: "0x123" },
    { extra: true },
  ]) {
    const response = await createOffer(app, mockWallets.alfa, {
      ...validOffer,
      ...patch,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(patch));
  }
});

test("creating an offer mirrors the contract guards", async (t) => {
  const { app } = await setup(t);
  const cases = [
    {
      body: validOffer,
      status: 403,
      type: "not-registered-institution",
      wallet: mockWallets.delta,
    },
    {
      body: { ...validOffer, borrowerWallet: mockWallets.alfa },
      status: 422,
      type: "invalid-counterparty",
      wallet: mockWallets.alfa,
    },
    {
      body: { ...validOffer, borrowerWallet: mockWallets.delta },
      status: 422,
      type: "not-registered-institution",
      wallet: mockWallets.alfa,
    },
    {
      body: { ...validOffer, borrowerWallet: `0x${"99".repeat(20)}` },
      status: 422,
      type: "not-registered-institution",
      wallet: mockWallets.alfa,
    },
    {
      body: { ...validOffer, amountCents: "15000000001" },
      status: 422,
      type: "insufficient-limit",
      wallet: mockWallets.alfa,
    },
  ];

  for (const { body, status, type, wallet } of cases) {
    const response = await createOffer(app, wallet, body);
    assert.equal(response.statusCode, status, type);
    assert.equal(response.json().type, `${PROBLEMS}${type}`);
  }
});

test("an amount equal to the borrower limit is accepted", async (t) => {
  const { app } = await setup(t);

  const response = await createOffer(app, mockWallets.alfa, {
    ...validOffer,
    amountCents: "15000000000",
  });

  assert.equal(response.statusCode, 202);
});

test("intent accepts uint256 decimal width without arbitrary 30-digit truncation", async (t) => {
  const { app } = await setup(t);
  const large = await createOffer(app, mockWallets.alfa, {
    ...validOffer,
    amountCents: `1${"0".repeat(30)}`,
  });
  assert.equal(large.statusCode, 422);
  assert.match(large.json().type, /insufficient-limit$/);
  const overflow = await createOffer(app, mockWallets.alfa, {
    ...validOffer,
    amountCents: (1n << 256n).toString(),
  });
  assert.equal(overflow.statusCode, 400);
  assert.match(overflow.json().type, /invalid-amount$/);
});

test("intent memory is bounded and rejects further writes without adding offers", async (t) => {
  const { app } = await setup(t);
  for (let index = 0; index < 100; index++) {
    assert.equal((await createOffer(app, mockWallets.alfa)).statusCode, 202);
  }
  const full = await createOffer(app, mockWallets.alfa);
  assert.equal(full.statusCode, 503);
  assert.match(full.json().type, /request-store-full$/);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/offers" })).json().meta.total,
    9,
  );
});

test("only the borrower can accept or reject, only the lender can cancel", async (t) => {
  const { app } = await setup(t);

  const cases = [
    { action: "accept", status: 202, wallet: mockWallets.beta },
    { action: "reject", status: 202, wallet: mockWallets.beta },
    { action: "cancel", status: 202, wallet: mockWallets.alfa },
  ] as const;
  for (const { action, status, wallet } of cases) {
    const response = await offerAction(
      app,
      action,
      offers.openAlfaToBeta,
      wallet,
    );
    assert.equal(response.statusCode, status, action);
    const intent = response.json().data;
    assert.equal(intent.action, `${action}_offer`);
    assert.equal(intent.offerId, mockOfferId(offers.openAlfaToBeta));
    assert.equal(intent.params, null);
    assert.deepEqual(intent.contractCall.args, [String(offers.openAlfaToBeta)]);
    assert.equal(intent.contractCall.functionName, `${action}Offer`);
  }

  const wrong = [
    {
      action: "accept",
      type: "not-eligible-borrower",
      wallet: mockWallets.beta,
    },
    {
      action: "reject",
      type: "not-eligible-borrower",
      wallet: mockWallets.gama,
    },
    { action: "cancel", type: "not-offer-owner", wallet: mockWallets.alfa },
  ] as const;
  for (const { action, type, wallet } of wrong) {
    const response = await offerAction(
      app,
      action,
      offers.openGamaToAlfa,
      wallet,
    );
    assert.equal(response.statusCode, 403, action);
    assert.equal(response.json().type, `${PROBLEMS}${type}`);
  }
});

test("closed offers refuse new actions", async (t) => {
  const { app } = await setup(t);

  const settled = await offerAction(
    app,
    "accept",
    offers.settledAlfaToBeta,
    mockWallets.beta,
  );
  const cancelled = await offerAction(
    app,
    "cancel",
    offers.cancelled,
    mockWallets.beta,
  );
  const persistedExpiry = await offerAction(
    app,
    "reject",
    offers.expiredPersisted,
    mockWallets.beta,
  );
  const lazyExpiry = await offerAction(
    app,
    "accept",
    offers.expiredLazy,
    mockWallets.alfa,
  );

  assert.equal(settled.statusCode, 409);
  assert.equal(settled.json().type, `${PROBLEMS}invalid-offer-status`);
  assert.equal(cancelled.json().type, `${PROBLEMS}invalid-offer-status`);
  assert.equal(persistedExpiry.json().type, `${PROBLEMS}invalid-offer-status`);
  assert.equal(lazyExpiry.statusCode, 409);
  assert.equal(lazyExpiry.json().type, `${PROBLEMS}offer-expired`);
});

test("a second intent for the same action waits for the first", async (t) => {
  const { app, clock } = await setup(t);

  const first = await offerAction(
    app,
    "accept",
    offers.openAlfaToBeta,
    mockWallets.beta,
  );
  const second = await offerAction(
    app,
    "accept",
    offers.openAlfaToBeta,
    mockWallets.beta,
  );

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().type, `${PROBLEMS}request-in-progress`);
  assert.match(second.json().detail, new RegExp(first.json().data.id));

  clock.advance(REQUEST_TTL_MS);
  const afterExpiry = await offerAction(
    app,
    "accept",
    offers.openAlfaToBeta,
    mockWallets.beta,
  );
  assert.equal(afterExpiry.statusCode, 202);
});

test("unknown offers return 404 before any other check", async (t) => {
  const { app } = await setup(t);

  const response = await offerAction(app, "accept", 999, mockWallets.beta);

  assert.equal(response.statusCode, 404);
});

test("the requester submits the signed hash once", async (t) => {
  const { app, clock } = await setup(t);
  const intent = (await createOffer(app, mockWallets.alfa)).json().data;
  clock.advance(30_000);

  const submitted = await submit(
    app,
    intent.id,
    mixedCase(mockWallets.alfa),
    mixedCase(hashOf("ab")),
  );
  const again = await submit(app, intent.id, mockWallets.alfa, hashOf("cd"));
  const read = await app.inject({
    method: "GET",
    url: `/api/transaction-requests/${intent.id}`,
  });

  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.json().data.status, "submitted");
  assert.equal(submitted.json().data.txHash, hashOf("ab"));
  assert.equal(submitted.json().data.submittedAt, clock.now().toISOString());
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().type, `${PROBLEMS}invalid-request-status`);
  assert.equal(read.json().data.status, "submitted");
});

test("submission is refused for another wallet, a reused hash or an expired intent", async (t) => {
  const { app, clock } = await setup(t);
  const first = (await createOffer(app, mockWallets.alfa)).json().data;
  const second = (await createOffer(app, mockWallets.alfa)).json().data;
  await submit(app, first.id, mockWallets.alfa, hashOf("ab"));

  const otherWallet = await submit(
    app,
    second.id,
    mockWallets.beta,
    hashOf("cd"),
  );
  const reused = await submit(app, second.id, mockWallets.alfa, hashOf("ab"));
  clock.advance(REQUEST_TTL_MS);
  const expired = await submit(app, second.id, mockWallets.alfa, hashOf("cd"));
  const read = await app.inject({
    method: "GET",
    url: `/api/transaction-requests/${second.id}`,
  });

  assert.equal(otherWallet.statusCode, 403);
  assert.equal(otherWallet.json().type, `${PROBLEMS}not-request-owner`);
  assert.equal(reused.statusCode, 409);
  assert.equal(reused.json().type, `${PROBLEMS}duplicate-transaction`);
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().type, `${PROBLEMS}request-expired`);
  assert.equal(read.json().data.status, "expired");
});

test("submission validates the hash and the intent id", async (t) => {
  const { app } = await setup(t);
  const intent = (await createOffer(app, mockWallets.alfa)).json().data;

  const badHash = await submit(app, intent.id, mockWallets.alfa, "0x1234");
  const unknown = await submit(
    app,
    "00000000-0000-4000-8000-000000000000",
    mockWallets.alfa,
    hashOf("ab"),
  );
  const unknownRead = await app.inject({
    method: "GET",
    url: "/api/transaction-requests/00000000-0000-4000-8000-000000000000",
  });

  assert.equal(badHash.statusCode, 400);
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknownRead.statusCode, 404);
});
