import assert from "node:assert/strict";
import test from "node:test";
import { syncChain } from "../../src/blockchain/sync.js";
import {
  connect,
  counts,
  FakeChain,
  happyPath,
  isolatedDatabase,
  rejectsWith,
  skip,
  txHash,
} from "../db/chain-support.js";
import { readApi, startApi } from "./api-process.js";
import { rpcOptions } from "./rpc-server.js";

const TIMEOUT_MS = 30_000;
const EMPTY = {
  cursor: null,
  events: "0",
  history: "0",
  offers: "0",
  settlements: "0",
} as const;

test("an HTTP RPC error rolls back the batch and the next pass recovers", {
  skip,
  timeout: TIMEOUT_MS,
}, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  chain.failBlock = 104n;
  const options = await rpcOptions(t, databaseUrl, chain);
  const db = await connect(t, databaseUrl);
  await assert.rejects(syncChain(options), /chave-secreta-de-teste/);
  assert.deepEqual(await counts(db), EMPTY);
  const { baseUrl } = await startApi(t, databaseUrl);
  const response = await fetch(`${baseUrl}/api/offers`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 503);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/problem\+json/,
  );
  const text = await response.text();
  assert.match(JSON.parse(text).type, /deployment-not-configured$/);
  assert.doesNotMatch(
    text,
    /chave-secreta|rpc\.example|postgresql|SELECT|INSERT/,
  );

  chain.failBlock = undefined;
  await syncChain(options);
  const operation = await readApi<{ amountCents: string }>(
    baseUrl,
    `/api/operations/${txHash(4)}`,
  );
  assert.equal(operation.amountCents, "30000");
  assert.deepEqual(await counts(db), {
    cursor: "104",
    events: "6",
    history: "2",
    offers: "1",
    settlements: "1",
  });
});

test("an HTTP RPC from another chain creates no deployment or projection", {
  skip,
  timeout: TIMEOUT_MS,
}, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  chain.chainId = 1;
  const options = await rpcOptions(t, databaseUrl, chain);
  await rejectsWith(syncChain(options), "CHAIN_MISMATCH");
  const db = await connect(t, databaseUrl);
  assert.deepEqual(await counts(db), EMPTY);
  const { rows } = await db.query(
    "SELECT count(*) AS deployments FROM contract_deployments",
  );
  assert.deepEqual(rows, [{ deployments: "0" }]);
});

test("shutdown aborts an in-flight HTTP RPC read and leaves no partial batch", {
  skip,
  timeout: TIMEOUT_MS,
}, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const options = await rpcOptions(t, databaseUrl, chain, async (method) => {
    if (method === "eth_getLogs") {
      entered.resolve();
      await release.promise;
    }
  });
  const rejected = assert.rejects(
    syncChain({ ...options, signal: controller.signal }),
    /abort|cancel|shutdown/i,
  );
  try {
    await entered.promise;
    controller.abort(new Error("integration shutdown"));
    await rejected;
  } finally {
    controller.abort();
    release.resolve();
  }
  const db = await connect(t, databaseUrl);
  assert.deepEqual(await counts(db), EMPTY);
});
