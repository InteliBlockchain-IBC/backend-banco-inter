import assert from "node:assert/strict";
import test from "node:test";
import { chainWorkerConfigFromEnv } from "../../src/blockchain/config.js";
import type {
  ChainSyncOptions,
  ChainSyncResult,
} from "../../src/blockchain/sync.js";
import {
  MAX_BACKOFF_MS,
  retryDelay,
  runChainWorker,
} from "../../src/blockchain/worker.js";

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

test("configuration boundaries", () => {
  const ok = (extra: Record<string, string>) =>
    chainWorkerConfigFromEnv({ ...env, ...extra });
  assert.equal(ok({ CHAIN_SYNC_CONFIRMATIONS: "0" }).options.confirmations, 0);
  assert.equal(
    ok({ CREDIT_INTERBANK_OFFER_START_BLOCK: "0" }).options.startBlock,
    0,
  );
  assert.equal(ok({ CHAIN_SYNC_INTERVAL_MS: "1000" }).intervalMs, 1000);
  assert.equal(
    ok({ CREDIT_INTERBANK_OFFER_START_BLOCK: " 123 " }).options.startBlock,
    123,
  );
  assert.equal(
    ok({ SEPOLIA_RPC_URL: "http://127.0.0.1:8545" }).options.rpcUrl,
    "http://127.0.0.1:8545",
  );
  // Endereço com checksum EIP-55 válido também é aceito.
  ok({
    CREDIT_INTERBANK_OFFER_ADDRESS:
      "0x2401d88D300dD2CEdB83337bba9Ba29E7269079A",
  });
  for (const [key, value] of [
    ["CHAIN_SYNC_INTERVAL_MS", "999"],
    ["CHAIN_SYNC_CONFIRMATIONS", "1.5"],
    ["CHAIN_SYNC_CONFIRMATIONS", "doze"],
    ["CREDIT_INTERBANK_OFFER_START_BLOCK", "-1"],
    ["CREDIT_INTERBANK_OFFER_START_BLOCK", "1e6"],
    ["BRL_TOKEN_ADDRESS", "0xZZ00000000000000000000000000000000000000"],
    ["CDI_POSITION_TOKEN_ADDRESS", "não é endereço"],
    ["SEPOLIA_RPC_URL", "rpc.example.invalid"],
  ] as const)
    assert.throws(
      () => ok({ [key]: value }),
      new RegExp(key),
      `${key}=${value}`,
    );
});

test("missing configuration lists every required variable at once", () => {
  assert.throws(
    () => chainWorkerConfigFromEnv({}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const key of Object.keys(env))
        assert.match(error.message, new RegExp(`${key} não configurada`));
      return true;
    },
  );
});

test("backoff doubles and is capped", () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((failures) => retryDelay(15_000, failures)),
    [15_000, 30_000, 60_000, 120_000],
  );
  assert.equal(retryDelay(15_000, 50), MAX_BACKOFF_MS);
  assert.equal(retryDelay(15_000, 0), 15_000);
  assert.equal(retryDelay(10 * MAX_BACKOFF_MS, 1), MAX_BACKOFF_MS);
});

test("a success resets the consecutive failure count", async () => {
  const controller = new AbortController();
  const outcomes: Array<"fail" | "ok"> = ["fail", "fail", "ok", "fail"];
  const failures: number[] = [];
  await runChainWorker({
    intervalMs: 1,
    options: {} as ChainSyncOptions,
    signal: controller.signal,
    sync: async () => {
      const next = outcomes.shift();
      if (next === undefined) {
        controller.abort();
        return result(true);
      }
      if (next === "fail") throw "falha sem Error";
      return result(true);
    },
    write: (stream, line) => {
      if (stream === "stderr")
        failures.push(JSON.parse(line).consecutiveFailures);
    },
  });
  assert.deepEqual(failures, [1, 2, 1]);
});

test("aborting stops the worker during the wait and before the first pass", async () => {
  const controller = new AbortController();
  let calls = 0;
  const started = Date.now();
  const running = runChainWorker({
    intervalMs: 60_000,
    options: {} as ChainSyncOptions,
    signal: controller.signal,
    sync: async () => {
      calls += 1;
      return result(true);
    },
    write: () => undefined,
  });
  setTimeout(() => controller.abort(), 30);
  await running;
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5_000);

  const aborted = new AbortController();
  aborted.abort();
  await runChainWorker({
    intervalMs: 1,
    options: {} as ChainSyncOptions,
    signal: aborted.signal,
    sync: async () => {
      calls += 1;
      return result(true);
    },
  });
  assert.equal(calls, 1);
});

test("successful passes are logged as info lines with the batch result", async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  await runChainWorker({
    intervalMs: 1,
    options: {} as ChainSyncOptions,
    signal: controller.signal,
    sync: async () => {
      controller.abort();
      return { ...result(true), indexed: 3 };
    },
    write: (stream, line) => lines.push(`${stream}:${line}`),
  });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.startsWith("stdout:"));
  assert.deepEqual(JSON.parse(lines[0]?.slice(7) ?? "{}"), {
    level: "info",
    ...result(true),
    indexed: 3,
  });
});
