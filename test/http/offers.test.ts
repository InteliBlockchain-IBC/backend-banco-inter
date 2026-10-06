import assert from "node:assert/strict";
import test from "node:test";
import {
  mixedCase,
  mockOfferId,
  mockWallets,
  offers,
  setup,
} from "../support.js";

type Offer = {
  amountCents: string;
  borrower: { institution: { name: string } | null; wallet: string };
  createdAt: string;
  expiresAt: string;
  id: string;
  lender: { wallet: string };
  onchainOfferId: string;
  onchainStatusCode: number;
  settlement: { positionTokenId: string; txHash: string } | null;
  status: string;
};

test("offers are listed newest first with pagination metadata", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({
    method: "GET",
    url: "/api/offers?limit=3&offset=1",
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.meta, {
    limit: 3,
    offset: 1,
    source: "mock",
    total: 9,
  });
  assert.equal(body.data.length, 3);
  const created = body.data.map((offer: Offer) => Date.parse(offer.createdAt));
  assert.deepEqual(
    created,
    [...created].sort((a, b) => b - a),
  );
});

test("the status filter returns only open offers", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({
    method: "GET",
    url: "/api/offers?status=offered",
  });
  const ids = response
    .json()
    .data.map((offer: Offer) => offer.id)
    .sort();

  assert.deepEqual(ids, [
    mockOfferId(offers.openAlfaToBeta),
    mockOfferId(offers.openGamaToAlfa),
  ]);
});

test("wallet and role narrow the list to one side of the desk", async (t) => {
  const { app } = await setup(t);
  const list = async (query: string) =>
    (await app.inject({ method: "GET", url: `/api/offers?${query}` })).json()
      .data as Offer[];

  const asLender = await list(
    `wallet=${mixedCase(mockWallets.alfa)}&role=lender`,
  );
  const asBorrower = await list(`wallet=${mockWallets.alfa}&role=borrower`);
  const any = await list(`wallet=${mockWallets.alfa}`);

  assert.ok(
    asLender.every((offer) => offer.lender.wallet === mockWallets.alfa),
  );
  assert.ok(
    asBorrower.every((offer) => offer.borrower.wallet === mockWallets.alfa),
  );
  assert.equal(asLender.length, 3);
  assert.equal(asBorrower.length, 3);
  assert.equal(any.length, asLender.length + asBorrower.length);
});

test("an offer past expiresAt shows expired but keeps the on-chain code", async (t) => {
  const { app } = await setup(t);

  const lazy = (
    await app.inject({
      method: "GET",
      url: `/api/offers/${mockOfferId(offers.expiredLazy)}`,
    })
  ).json().data as Offer;
  const persisted = (
    await app.inject({
      method: "GET",
      url: `/api/offers/${mockOfferId(offers.expiredPersisted)}`,
    })
  ).json().data as Offer;

  assert.equal(lazy.status, "expired");
  assert.equal(lazy.onchainStatusCode, 0);
  assert.equal(persisted.status, "expired");
  assert.equal(persisted.onchainStatusCode, 4);
});

test("an open offer turns expired when the clock passes expiresAt", async (t) => {
  const { app, clock } = await setup(t);
  const url = `/api/offers/${mockOfferId(offers.openAlfaToBeta)}`;

  assert.equal(
    (await app.inject({ method: "GET", url })).json().data.status,
    "offered",
  );
  clock.advance(2 * 60 * 60_000);
  assert.equal(
    (await app.inject({ method: "GET", url })).json().data.status,
    "expired",
  );
});

test("a settled offer carries its DvP settlement", async (t) => {
  const { app } = await setup(t);

  const offer = (
    await app.inject({
      method: "GET",
      url: `/api/offers/${mockOfferId(offers.settledAlfaToBeta)}`,
    })
  ).json().data as Offer;

  assert.equal(offer.status, "settled");
  assert.equal(offer.onchainStatusCode, 2);
  assert.ok(offer.settlement);
  assert.equal(offer.settlement.positionTokenId, offer.onchainOfferId);
  assert.equal(offer.borrower.institution?.name, "Banco Beta S.A. (fictício)");
});

test("open offers have no settlement", async (t) => {
  const { app } = await setup(t);

  const offer = (
    await app.inject({
      method: "GET",
      url: `/api/offers/${mockOfferId(offers.openAlfaToBeta)}`,
    })
  ).json().data as Offer;

  assert.equal(offer.settlement, null);
  assert.equal(offer.amountCents, "4000000000");
});

test("the offer history lists created, accepted and settled in log order", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({
    method: "GET",
    url: `/api/offers/${mockOfferId(offers.settledAlfaToBeta)}/events`,
  });
  const events = response.json().data as Array<{
    args: Record<string, string>;
    eventName: string;
    logIndex: number;
    txHash: string;
  }>;

  assert.deepEqual(
    events.map((event) => event.eventName),
    ["OfferCreated", "OfferAccepted", "OfferSettled"],
  );
  assert.equal(events[1]?.txHash, events[2]?.txHash);
  assert.deepEqual(
    events.slice(1).map((event) => event.logIndex),
    [0, 1],
  );
  assert.equal(events[2]?.args.positionTokenId, "1");
});

test("each final state has its closing event", async (t) => {
  const { app } = await setup(t);
  const lastEvent = async (n: number) => {
    const events = (
      await app.inject({
        method: "GET",
        url: `/api/offers/${mockOfferId(n)}/events`,
      })
    ).json().data as Array<{ eventName: string }>;
    return events.at(-1)?.eventName;
  };

  assert.equal(await lastEvent(offers.cancelled), "OfferCancelled");
  assert.equal(await lastEvent(offers.rejected), "OfferRejected");
  assert.equal(await lastEvent(offers.expiredPersisted), "OfferExpired");
  assert.equal(await lastEvent(offers.expiredLazy), "OfferCreated");
});

test("unknown offers return 404 on detail and history", async (t) => {
  const { app } = await setup(t);

  for (const url of [
    `/api/offers/${mockOfferId(999)}`,
    `/api/offers/${mockOfferId(999)}/events`,
  ]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
  }
});

test("list query values are validated", async (t) => {
  const { app } = await setup(t);

  for (const query of [
    "status=accepted",
    "limit=0",
    "limit=101",
    "offset=-1",
    "role=admin",
    "wallet=0x1",
  ]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/offers?${query}`,
    });
    assert.equal(response.statusCode, 400, query);
  }
});
