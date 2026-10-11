import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { buildApp } from "../../src/app.js";
import { seedDemo } from "../../src/database/seed.js";
import { START } from "../support.js";
import {
  BORROWER,
  CONTRACT,
  connect,
  FakeChain,
  happyPath,
  isolatedDatabase,
  LENDER,
  options,
  SEPOLIA,
  skip,
  syncAll,
  txHash,
} from "./chain-support.js";

/**
 * A API lendo o que o listener gravou: o deployment real vira o ativo, as
 * leituras mostram hashes e blocos da chain, e nenhum comando sintético grava
 * nele.
 */

async function indexedApp(t: TestContext, seed = false) {
  const url = await isolatedDatabase(t);
  if (seed) await seedDemo(url, { mode: "reset", now: START });
  const chain = new FakeChain();
  happyPath(chain);
  await syncAll(options(url, chain));
  const app = await buildApp({
    databaseUrl: url,
    logger: false,
    nodeEnv: "test",
    now: () => new Date(),
  });
  t.after(() => app.close());
  return { app, chain, url };
}

test("reads expose the indexed offer, settlement, history and cursor", {
  skip,
}, async (t) => {
  const { app, chain } = await indexedApp(t);
  const get = async (url: string) => {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    assert.equal(response.headers["x-data-source"], "postgres");
    return response.json().data;
  };

  const deployment = await get("/api/deployment");
  assert.equal(deployment.contractAddress, CONTRACT);
  assert.equal(deployment.chainId, SEPOLIA);

  const sync = await get("/api/sync-status");
  assert.equal(sync.lastProcessedBlock, 104);
  assert.equal(sync.lastProcessedBlockHash, chain.blockHash(104n));
  assert.equal(sync.stale, false);

  const [offer] = await get("/api/offers");
  assert.equal(offer.status, "settled");
  assert.equal(offer.amountCents, "30000");
  assert.equal(offer.createTxHash, txHash(3));
  assert.equal(offer.settlement.txHash, txHash(4));
  assert.equal(offer.settlement.positionTokenId, "1");

  const events = await get(`/api/offers/${offer.id}/events`);
  assert.deepEqual(
    events.map((event: { eventName: string }) => event.eventName),
    ["OfferCreated", "OfferAccepted", "OfferSettled"],
  );

  const operation = await get(`/api/operations/${txHash(4)}`);
  assert.equal(operation.amountCents, "30000");
  assert.equal(operation.blockNumber, 104);
  assert.equal(operation.blockHash, chain.blockHash(104n));

  const limit = await get(`/api/credit-limits/${BORROWER}`);
  assert.equal(limit.availableLimitCents, "70000");
  const history = await get(`/api/credit-limits/${BORROWER}/history`);
  assert.equal(history.length, 2);
});

test("every simulated command is refused on the listener deployment", {
  skip,
}, async (t) => {
  const { app, url } = await indexedApp(t, true);
  const db = await connect(t, url);
  const before = await db.query(
    "SELECT (SELECT count(*) FROM chain_events) AS events, (SELECT count(*) FROM offers) AS offers",
  );
  const [offer] = (await app.inject({ url: "/api/offers" })).json().data;

  for (const action of ["accept", "reject", "cancel"]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/mock/offers/${offer.id}/${action}`,
    });
    assert.equal(response.statusCode, 409, action);
    assert.match(response.json().type, /simulation-unavailable$/);
  }
  const create = await app.inject({
    method: "POST",
    payload: {
      amountCents: "1000",
      borrowerWallet: BORROWER,
      lenderWallet: LENDER,
      rateCdiBps: 10_000,
      termDays: 1,
      validitySeconds: 3600,
    },
    url: "/api/mock/offers",
  });
  assert.equal(create.statusCode, 409);

  const after = await db.query(
    "SELECT (SELECT count(*) FROM chain_events) AS events, (SELECT count(*) FROM offers) AS offers",
  );
  assert.deepEqual(after.rows, before.rows);
});

test("signature intents still work on the listener deployment", {
  skip,
}, async (t) => {
  // Intenções não gravam fatos on-chain: só registram o que a carteira vai
  // assinar. Continuam liberadas no contrato real.
  const { app } = await indexedApp(t);
  const response = await app.inject({
    headers: { "x-wallet-address": LENDER },
    method: "POST",
    payload: {
      amountCents: "1000",
      borrowerWallet: BORROWER,
      rateCdiBps: 10_000,
      termDays: 1,
      validitySeconds: 3600,
    },
    url: "/api/offers",
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().data.contractCall.contractAddress, CONTRACT);
});

test("seed if-empty does not overwrite a database the listener already filled", {
  skip,
}, async (t) => {
  const { app, url } = await indexedApp(t);
  assert.deepEqual(await seedDemo(url, { mode: "if-empty", now: START }), {
    offers: 0,
    seeded: false,
  });
  const deployment = (await app.inject({ url: "/api/deployment" })).json().data;
  assert.equal(deployment.contractAddress, CONTRACT);
});

test("seed reset keeps the listener deployment active and its data intact", {
  skip,
}, async (t) => {
  const { app, url } = await indexedApp(t, true);
  await seedDemo(url, { mode: "reset", now: START });
  await seedDemo(url, { mode: "reset", now: START });
  const db = await connect(t, url);
  const { rows } = await db.query(
    "SELECT source, count(*) OVER () AS total FROM contract_deployments ORDER BY source",
  );
  assert.deepEqual(
    rows.map((row) => row.source),
    ["listener", "seed"],
  );
  const offers = (await app.inject({ url: "/api/offers" })).json();
  assert.equal(offers.meta.total, 1);
  assert.equal(offers.data[0].createTxHash, txHash(3));
});

test("migration 003 marks old deployments as seed and rejects unknown sources", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const db = await connect(t, url);
  await db.query(
    `INSERT INTO contract_deployments (chain_id, contract_address, brl_token_address, position_token_address, start_block)
     VALUES ($1, $2, $2, $2, 1)`,
    [SEPOLIA, CONTRACT],
  );
  const { rows } = await db.query("SELECT source FROM contract_deployments");
  assert.equal(rows[0]?.source, "seed");
  await assert.rejects(
    db.query("UPDATE contract_deployments SET source = 'oraculo'"),
    /check constraint/,
  );
});
