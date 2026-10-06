import assert from "node:assert/strict";
import test from "node:test";
import { SYNC_STALE_AFTER_SECONDS } from "../src/mock/store.js";
import { mixedCase, mockWallets, setup } from "./support.js";

type Limit = {
  availableLimitCents: string;
  institution: { id: string; name: string } | null;
  isRegistered: boolean;
  wallet: string;
};
type Change = {
  changeKind: string;
  newLimitCents: string;
  offerId: string | null;
  previousLimitCents: string;
};

test("credit limits are listed with the largest limit first", async (t) => {
  const { app } = await setup(t);

  const limits = (
    await app.inject({ method: "GET", url: "/api/credit-limits" })
  ).json().data as Limit[];
  const values = limits.map((limit) => BigInt(limit.availableLimitCents));

  // Alfa opera duas carteiras: são cinco carteiras de quatro instituições.
  assert.equal(limits.length, 5);
  assert.equal(new Set(limits.map((limit) => limit.institution?.id)).size, 4);
  assert.deepEqual(
    values,
    [...values].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)),
  );
});

test("the borrower picker filter hides self, revoked and low-limit wallets", async (t) => {
  const { app } = await setup(t);

  const response = await app.inject({
    method: "GET",
    url: `/api/credit-limits?registered=true&minAvailableCents=9000000000&excludeWallet=${mixedCase(mockWallets.alfa)}`,
  });
  const wallets = (response.json().data as Limit[]).map(
    (limit) => limit.wallet,
  );

  assert.deepEqual(wallets, [mockWallets.beta]);
});

test("a revoked wallet keeps its limit but is not registered", async (t) => {
  const { app } = await setup(t);

  const delta = (
    await app.inject({
      method: "GET",
      url: `/api/credit-limits/${mockWallets.delta}`,
    })
  ).json().data as Limit;

  assert.equal(delta.isRegistered, false);
  assert.equal(delta.availableLimitCents, "5000000000");
});

test("limit history chains every change and ends at the current limit", async (t) => {
  const { app } = await setup(t);

  for (const wallet of Object.values(mockWallets)) {
    const current = (
      await app.inject({ method: "GET", url: `/api/credit-limits/${wallet}` })
    ).json().data as Limit;
    const history = (
      await app.inject({
        method: "GET",
        url: `/api/credit-limits/${wallet}/history`,
      })
    ).json().data as Change[];

    assert.equal(
      history[0]?.newLimitCents,
      current.availableLimitCents,
      wallet,
    );
    assert.equal(history.at(-1)?.previousLimitCents, "0", wallet);
    for (let i = 0; i < history.length - 1; i++) {
      assert.equal(
        history[i]?.previousLimitCents,
        history[i + 1]?.newLimitCents,
      );
    }
    for (const change of history) {
      assert.equal(
        change.offerId === null,
        change.changeKind === "admin_update",
      );
    }
  }
});

test("each settlement debits exactly the borrower limit", async (t) => {
  const { app } = await setup(t);
  const operations = (
    await app.inject({ method: "GET", url: "/api/operations" })
  ).json().data as Array<{
    amountCents: string;
    borrower: { wallet: string };
    offerId: string;
  }>;

  for (const operation of operations) {
    const history = (
      await app.inject({
        method: "GET",
        url: `/api/credit-limits/${operation.borrower.wallet}/history`,
      })
    ).json().data as Change[];
    const debit = history.find(
      (change) => change.offerId === operation.offerId,
    );
    assert.ok(debit);
    assert.equal(
      BigInt(debit.previousLimitCents) - BigInt(debit.newLimitCents),
      BigInt(operation.amountCents),
    );
  }
});

test("unknown wallets return 404", async (t) => {
  const { app } = await setup(t);

  for (const url of [
    `/api/credit-limits/0x${"99".repeat(20)}`,
    `/api/credit-limits/0x${"99".repeat(20)}/history`,
  ]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
  }
});

test("operations are receipts filtered by party", async (t) => {
  const { app } = await setup(t);

  const all = (
    await app.inject({ method: "GET", url: "/api/operations" })
  ).json();
  const gama = (
    await app.inject({
      method: "GET",
      url: `/api/operations?wallet=${mockWallets.gama}`,
    })
  ).json();
  const first = all.data[0];

  assert.equal(all.meta.total, 3);
  assert.equal(gama.meta.total, 2);
  assert.equal(first.positionTokenId, first.onchainOfferId);
  assert.equal(
    first.explorerUrl,
    `https://sepolia.etherscan.io/tx/${first.txHash}`,
  );
  for (const key of [
    "lender",
    "borrower",
    "amountCents",
    "rateCdiBps",
    "settledAt",
    "txHash",
  ]) {
    assert.ok(key in first, key);
  }
});

test("deployment exposes the three Sepolia contracts", async (t) => {
  const { app } = await setup(t);

  const deployment = (
    await app.inject({ method: "GET", url: "/api/deployment" })
  ).json().data;

  assert.equal(deployment.chainId, 11155111);
  assert.equal(deployment.network, "sepolia");
  for (const key of [
    "contractAddress",
    "brlTokenAddress",
    "positionTokenAddress",
  ]) {
    assert.match(deployment[key], /^0x[0-9a-f]{40}$/);
  }
});

test("sync status turns stale when the listener falls behind", async (t) => {
  const { app, clock } = await setup(t);
  const read = async () =>
    (await app.inject({ method: "GET", url: "/api/sync-status" })).json().data;

  const fresh = await read();
  clock.advance(SYNC_STALE_AFTER_SECONDS * 1000);
  const late = await read();

  assert.equal(fresh.stale, false);
  assert.ok(fresh.lagSeconds < SYNC_STALE_AFTER_SECONDS);
  assert.equal(late.stale, true);
});
