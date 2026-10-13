import assert from "node:assert/strict";
import test from "node:test";
import { createFixtures, mockWallets } from "../../src/demo/fixtures.js";
import { effectiveStatus } from "../../src/domain/types.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");

test("demo fixtures preserve a balanced composition across all offer states", () => {
  const data = createFixtures(NOW);
  const counts: Record<string, number> = {};
  for (const offer of data.offers) {
    const status = effectiveStatus(offer, NOW);
    counts[status] = (counts[status] ?? 0) + 1;
    assert.notEqual(offer.lender, offer.borrower, offer.id);
  }
  assert.equal(data.offers.length, 30);
  assert.equal(new Set(data.offers.map((offer) => offer.id)).size, 30);
  assert.equal(
    new Set(data.offers.map((offer) => offer.createdAt.getTime())).size,
    30,
  );
  assert.deepEqual(counts, {
    settled: 8,
    cancelled: 4,
    rejected: 4,
    expired: 4,
    offered: 10,
  });
});

test("every demo wallet participates on both sides after its registration", () => {
  const data = createFixtures(NOW);
  for (const wallet of Object.values(mockWallets)) {
    assert.ok(
      data.offers.some((offer) => offer.lender === wallet),
      wallet,
    );
    assert.ok(
      data.offers.some((offer) => offer.borrower === wallet),
      wallet,
    );
    const registration = data.chainEvents.find(
      (event) =>
        event.eventName === "InstitutionRegistered" &&
        event.args.wallet === wallet,
    );
    assert.ok(registration, wallet);
    for (const offer of data.offers.filter(
      (offer) => offer.lender === wallet || offer.borrower === wallet,
    )) {
      assert.ok(registration.blockTimestamp <= offer.createdAt, offer.id);
    }
  }
  const revocation = data.chainEvents.find(
    (event) =>
      event.eventName === "InstitutionRevoked" &&
      event.args.wallet === mockWallets.delta,
  );
  assert.ok(revocation);
  assert.equal(
    data.wallets.find((wallet) => wallet.wallet === mockWallets.delta)
      ?.isRegistered,
    false,
  );
  const deltaOffers = data.offers.filter(
    (offer) =>
      offer.lender === mockWallets.delta ||
      offer.borrower === mockWallets.delta,
  );
  assert.ok(
    deltaOffers.some((offer) => effectiveStatus(offer, NOW) === "offered"),
  );
  for (const offer of deltaOffers) {
    assert.ok(offer.createdAt < revocation.blockTimestamp, offer.id);
  }
});

test("every settlement has one receipt, one debit and matching DvP events", () => {
  const data = createFixtures(NOW);
  const settled = data.offers.filter(
    (offer) => effectiveStatus(offer, NOW) === "settled",
  );
  assert.equal(data.settlements.length, settled.length);
  assert.equal(
    data.creditLimitChanges.filter(
      (change) => change.changeKind === "settlement",
    ).length,
    settled.length,
  );
  for (const offer of data.offers) {
    const receipts = data.settlements.filter(
      (item) => item.offerId === offer.id,
    );
    const debits = data.creditLimitChanges.filter(
      (item) => item.changeKind === "settlement" && item.offerId === offer.id,
    );
    const isSettled = effectiveStatus(offer, NOW) === "settled";
    assert.equal(receipts.length, isSettled ? 1 : 0, offer.id);
    assert.equal(debits.length, isSettled ? 1 : 0, offer.id);
    if (!isSettled) continue;
    const receipt = receipts[0];
    const debit = debits[0];
    assert.ok(receipt);
    assert.ok(debit);
    assert.equal(debit.wallet, offer.borrower);
    assert.equal(
      debit.previousLimitCents - debit.newLimitCents,
      offer.amountCents,
    );
    assert.equal(debit.txHash, receipt.txHash);
    assert.equal(receipt.positionTokenId, offer.onchainOfferId);
    const events = data.chainEvents.filter(
      (event) => event.offerId === offer.id && event.txHash === receipt.txHash,
    );
    assert.deepEqual(
      events.map((event) => event.eventName),
      ["OfferAccepted", "OfferSettled"],
    );
    assert.equal(events[1]?.logIndex, debit.logIndex);
    assert.equal(events[1]?.args.amount, offer.amountCents.toString());
    assert.equal(
      events[1]?.blockTimestamp.getTime(),
      receipt.settledAt.getTime(),
    );
  }
  for (const wallet of data.wallets) {
    let limit = 0n;
    for (const change of data.creditLimitChanges.filter(
      (item) => item.wallet === wallet.wallet,
    )) {
      assert.equal(change.previousLimitCents, limit, wallet.wallet);
      assert.ok(change.newLimitCents >= 0n, wallet.wallet);
      limit = change.newLimitCents;
    }
    assert.equal(wallet.availableLimitCents, limit, wallet.wallet);
  }
});
