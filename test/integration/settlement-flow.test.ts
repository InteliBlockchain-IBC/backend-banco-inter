import assert from "node:assert/strict";
import test from "node:test";
import { syncChain } from "../../src/blockchain/sync.js";
import {
  BORROWER,
  connect,
  counts,
  FakeChain,
  happyPath,
  isolatedDatabase,
  LENDER,
  skip,
  txHash,
} from "../db/chain-support.js";
import { readApi, startApi } from "./api-process.js";
import { rpcOptions } from "./rpc-server.js";

type Offer = Readonly<{
  amountCents: string;
  createTxHash: string;
  id: string;
  onchainOfferId: string;
  settlement: { txHash: string } | null;
  status: string;
}>;
type Operation = Readonly<{
  amountCents: string;
  blockHash: string;
  blockNumber: number;
  borrower: { wallet: string };
  lender: { wallet: string };
  offerId: string;
  rateCdiBps: number;
  settledAt: string;
  termDays: number;
}>;
type CreditLimit = Readonly<{ availableLimitCents: string }>;
type LimitChange = Readonly<{
  changeKind: string;
  newLimitCents: string;
  previousLimitCents: string;
}>;
type Event = Readonly<{ eventName: string }>;
type SyncStatus = Readonly<{
  lastProcessedBlock: number;
  lastProcessedBlockHash: string;
}>;
// Data fixa futura: o processo usa seu relógio real, não o relógio das fixtures.
const EXPIRES_AT = 4_102_444_800n;
const TIMEOUT_MS = 30_000;

test("RPC HTTP -> PostgreSQL -> API exposes an offer before its confirmed settlement", {
  skip,
  timeout: TIMEOUT_MS,
}, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain, EXPIRES_AT);
  chain.head = 115n; // Só até 103 passou das 12 confirmações.
  const options = await rpcOptions(t, databaseUrl, chain);
  await syncChain(options);
  const { baseUrl } = await startApi(t, databaseUrl);
  const [offered] = await readApi<Offer[]>(baseUrl, "/api/offers");
  assert.ok(offered);
  assert.equal(offered.status, "offered");
  assert.equal(offered.settlement, null);
  assert.equal(offered.amountCents, "30000");
  assert.equal(offered.createTxHash, txHash(3));
  assert.deepEqual(await readApi(baseUrl, "/api/operations"), []);
  const before = await readApi<CreditLimit>(
    baseUrl,
    `/api/credit-limits/${BORROWER}`,
  );
  assert.equal(before.availableLimitCents, "100000");

  chain.head = 116n;
  await syncChain(options);
  const settled = await readApi<Offer>(baseUrl, `/api/offers/${offered.id}`);
  assert.equal(settled.status, "settled");
  assert.equal(settled.settlement?.txHash, txHash(4));
  const operation = await readApi<Operation>(
    baseUrl,
    `/api/operations/${txHash(4)}`,
  );
  assert.equal(operation.offerId, offered.id);
  assert.equal(operation.amountCents, "30000");
  assert.equal(operation.rateCdiBps, 10250);
  assert.equal(operation.termDays, 1);
  assert.equal(operation.lender.wallet, LENDER);
  assert.equal(operation.borrower.wallet, BORROWER);
  assert.equal(operation.blockNumber, 104);
  assert.equal(operation.blockHash, `0x${"0".repeat(62)}68`);
  assert.equal(operation.settledAt, "2026-09-21T14:34:08.000Z");
  const events = await readApi<Event[]>(
    baseUrl,
    `/api/offers/${offered.id}/events`,
  );
  assert.deepEqual(
    events.map((event) => event.eventName),
    ["OfferCreated", "OfferAccepted", "OfferSettled"],
  );
  const after = await readApi<CreditLimit>(
    baseUrl,
    `/api/credit-limits/${BORROWER}`,
  );
  assert.equal(after.availableLimitCents, "70000");
  const history = await readApi<LimitChange[]>(
    baseUrl,
    `/api/credit-limits/${BORROWER}/history`,
  );
  assert.deepEqual(
    history.map((entry) => [
      entry.changeKind,
      entry.previousLimitCents,
      entry.newLimitCents,
    ]),
    [
      ["settlement", "100000", "70000"],
      ["admin_update", "0", "100000"],
    ],
  );
});

test("a process restart and RPC replay preserve the receipt without a second debit", {
  skip,
  timeout: TIMEOUT_MS,
}, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  chain.duplicateLast();
  const options = await rpcOptions(t, databaseUrl, chain);
  await syncChain(options);
  const first = await startApi(t, databaseUrl);
  const operation = await readApi<Operation>(
    first.baseUrl,
    `/api/operations/${txHash(4)}`,
  );
  await first.stop();

  // Retomada normal: mantém o hash canônico e não relê o lote concluído.
  assert.deepEqual(await syncChain(options), {
    caughtUp: true,
    from: null,
    indexed: 0,
    safeHead: 104,
    to: null,
  });

  const db = await connect(t, databaseUrl);
  // Releitura deliberada testa também a guarda contra logs duplicados.
  await db.query(
    "UPDATE sync_cursors SET last_processed_block=100, last_processed_block_hash=NULL",
  );
  await syncChain(options);
  const second = await startApi(t, databaseUrl);
  assert.deepEqual(
    await readApi(second.baseUrl, `/api/operations/${txHash(4)}`),
    operation,
  );
  const limit = await readApi<CreditLimit>(
    second.baseUrl,
    `/api/credit-limits/${BORROWER}`,
  );
  assert.equal(limit.availableLimitCents, "70000");
  const cursor = await readApi<SyncStatus>(second.baseUrl, "/api/sync-status");
  assert.equal(cursor.lastProcessedBlock, 104);
  assert.equal(cursor.lastProcessedBlockHash, `0x${"0".repeat(62)}68`);
  assert.deepEqual(await counts(db), {
    cursor: "104",
    events: "6",
    history: "2",
    offers: "1",
    settlements: "1",
  });
});

test("a cancellation reaches HTTP without settlement or debit and rejects a later accept intent", {
  skip,
  timeout: TIMEOUT_MS,
}, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  chain.emit(105, 5, 0, "OfferCreated", {
    amount: 10000n,
    borrower: BORROWER,
    expiresAt: EXPIRES_AT,
    lender: LENDER,
    offerId: 2n,
    rateCDI: 10000n,
    term: 1n,
  });
  chain.emit(106, 6, 0, "OfferCancelled", {
    offerId: 2n,
    timestamp: 6n,
  });
  chain.head = 118n;
  const options = await rpcOptions(t, databaseUrl, chain);
  await syncChain(options);
  const { baseUrl } = await startApi(t, databaseUrl, "test");
  const offers = await readApi<Offer[]>(
    baseUrl,
    "/api/offers?status=cancelled",
  );
  assert.equal(offers.length, 1);
  const cancelled = offers[0];
  assert.ok(cancelled);
  assert.equal(cancelled.onchainOfferId, "2");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.settlement, null);
  const events = await readApi<Event[]>(
    baseUrl,
    `/api/offers/${cancelled.id}/events`,
  );
  assert.deepEqual(
    events.map((event) => event.eventName),
    ["OfferCreated", "OfferCancelled"],
  );
  const operations = await readApi<Operation[]>(baseUrl, "/api/operations");
  assert.equal(operations.length, 1);
  assert.ok(
    operations.every((operation) => operation.offerId !== cancelled.id),
  );
  const response = await fetch(`${baseUrl}/api/offers/${cancelled.id}/accept`, {
    headers: { "x-wallet-address": BORROWER },
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 409);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/problem\+json/,
  );
  assert.match((await response.json()).type, /invalid-offer-status$/);
  const limit = await readApi<CreditLimit>(
    baseUrl,
    `/api/credit-limits/${BORROWER}`,
  );
  assert.equal(limit.availableLimitCents, "70000");
  const db = await connect(t, databaseUrl);
  const { rows } = await db.query(
    "SELECT (SELECT count(*) FROM transaction_requests) AS intents, (SELECT count(*) FROM credit_limit_history) AS history",
  );
  assert.deepEqual(rows, [{ intents: "0", history: "2" }]);
});
