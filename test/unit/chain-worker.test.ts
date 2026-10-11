import assert from "node:assert/strict";
import test from "node:test";
import { chainWorkerConfigFromEnv } from "../../src/blockchain/config.js";
import type {
  ChainSyncOptions,
  ChainSyncResult,
} from "../../src/blockchain/sync.js";
import { MAX_BACKOFF_MS, runChainWorker } from "../../src/blockchain/worker.js";

const env = {
  BRL_TOKEN_ADDRESS: "0x00000000000000000000000000000000000000b1",
  CDI_POSITION_TOKEN_ADDRESS: "0x00000000000000000000000000000000000000d1",
  CREDIT_INTERBANK_OFFER_ADDRESS: "0x00000000000000000000000000000000000000c1",
  CREDIT_INTERBANK_OFFER_START_BLOCK: "100",
  DATABASE_URL: "postgresql://u:p@db.example.invalid/x",
  SEPOLIA_RPC_URL: "https://rpc.example.invalid/v2/chave-de-teste",
};

test("reads the listener configuration with defaults", () => {
  const config = chainWorkerConfigFromEnv(env);
  assert.equal(config.intervalMs, 15_000);
  assert.equal(config.options.confirmations, 12);
  assert.equal(config.options.startBlock, 100);
});

test("rejects invalid configuration at boot, naming only the variables", () => {
  const secret = "chave-secreta-de-teste";
  assert.throws(
    () =>
      chainWorkerConfigFromEnv({
        ...env,
        CHAIN_SYNC_CONFIRMATIONS: "-3",
        CHAIN_SYNC_INTERVAL_MS: "10",
        CREDIT_INTERBANK_OFFER_ADDRESS: "0x123",
        CREDIT_INTERBANK_OFFER_START_BLOCK: "abc",
        SEPOLIA_RPC_URL: `wss://rpc.example.invalid/${secret}`,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const key of [
        "CHAIN_SYNC_CONFIRMATIONS",
        "CHAIN_SYNC_INTERVAL_MS",
        "CREDIT_INTERBANK_OFFER_ADDRESS",
        "CREDIT_INTERBANK_OFFER_START_BLOCK",
        "SEPOLIA_RPC_URL",
      ])
        assert.match(error.message, new RegExp(key));
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.throws(
    () => chainWorkerConfigFromEnv({ ...env, DATABASE_URL: "" }),
    /DATABASE_URL não configurada/,
  );
});

const result = (caughtUp: boolean): ChainSyncResult => ({
  caughtUp,
  from: 1,
  indexed: 0,
  safeHead: 10,
  to: 1,
});

test("chains batches without waiting while behind, then waits", async () => {
  const controller = new AbortController();
  const outcomes = [false, false, true];
  const started: number[] = [];
  const begin = Date.now();
  await runChainWorker({
    intervalMs: 60_000,
    options: {} as ChainSyncOptions,
    signal: controller.signal,
    sync: async () => {
      started.push(Date.now() - begin);
      const caughtUp = outcomes.shift() ?? true;
      if (caughtUp) setTimeout(() => controller.abort(), 20);
      return result(caughtUp);
    },
    write: () => undefined,
  });
  assert.equal(started.length, 3);
  assert.ok((started[2] ?? Infinity) < 1_000, "backlog sem espera");
});

test("a failure is logged with its code and the worker keeps going", async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  let calls = 0;
  await runChainWorker({
    intervalMs: 1,
    options: {} as ChainSyncOptions,
    signal: controller.signal,
    sync: async () => {
      calls += 1;
      if (calls <= 2)
        throw Object.assign(
          new Error("URL: https://rpc.example.invalid/v2/chave-secreta"),
          { code: "ECONNRESET" },
        );
      controller.abort();
      return result(true);
    },
    write: (stream, line) => {
      if (stream === "stderr") lines.push(line);
    },
  });
  assert.equal(calls, 3);
  const logs = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    logs.map((log) => [log.code, log.consecutiveFailures, log.retryInMs]),
    [
      ["ECONNRESET", 1, 1],
      ["ECONNRESET", 2, 2],
    ],
  );
  assert.doesNotMatch(lines.join(""), /chave-secreta/);
  assert.ok(MAX_BACKOFF_MS >= 60_000);
});
