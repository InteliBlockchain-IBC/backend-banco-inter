import assert from "node:assert/strict";
import test from "node:test";
import {
  chainErrorLog,
  redactSecrets,
  safeChainErrorMessage,
  secretsFromEnv,
} from "../../src/blockchain/logging.js";
import { ChainSyncError } from "../../src/blockchain/sync.js";

const KEY = "a-chave-que-nao-pode-aparecer";

test("redacts an RPC URL and its API key from worker errors", () => {
  const message = safeChainErrorMessage(
    new Error(`RPC Request failed. URL: https://rpc.example.invalid/v2/${KEY}`),
    [],
  );
  assert.doesNotMatch(message, new RegExp(KEY));
  assert.match(message, /https:\/\/rpc\.example\.invalid\/\[redacted\]/);
});

test("keeps non-URL error details useful", () => {
  assert.equal(
    safeChainErrorMessage(new Error("timeout ao consultar o bloco"), []),
    "timeout ao consultar o bloco",
  );
});

test("redacts URLs of any scheme, including credentials", () => {
  const cases = [
    `falha wss://ws.example.invalid/v2/${KEY}`,
    `conexão postgresql://usuario:${KEY}@db.example.invalid:5432/banco`,
    `conexão postgres://${KEY}@db.example.invalid/banco`,
    `URL: https://usuario:${KEY}@rpc.example.invalid/x?token=${KEY}`,
  ];
  for (const text of cases) {
    const redacted = redactSecrets(text, []);
    assert.doesNotMatch(redacted, new RegExp(KEY), text);
    assert.doesNotMatch(redacted, /usuario/, text);
    assert.match(redacted, /\/\[redacted\]/, text);
  }
});

test("redacts exact secret values and their parts outside any URL", () => {
  const rpc = `https://rpc.example.invalid/v2/${KEY}`;
  const db = "postgresql://operador:senha-forte-123@db.example.invalid/x";
  const secrets = [rpc, db];
  const text = [
    `path /v2/${KEY} recusado`,
    "password authentication failed: senha-forte-123",
    'role "operador" does not exist',
  ].join(" | ");
  const redacted = redactSecrets(text, secrets);
  assert.doesNotMatch(redacted, new RegExp(KEY));
  assert.doesNotMatch(redacted, /senha-forte-123/);
  assert.doesNotMatch(redacted, /operador/);
  assert.match(redacted, /recusado/);
});

test("reads secret values from the environment", () => {
  assert.deepEqual(
    secretsFromEnv({
      DATABASE_URL: "postgresql://a:b@c/d",
      OTHER: "x",
      SEPOLIA_RPC_URL: "",
    }),
    ["postgresql://a:b@c/d"],
  );
});

test("structured error logs carry the sync error code", () => {
  const line = chainErrorLog(
    new ChainSyncError(
      "ORPHAN_OFFER_EVENT",
      `oferta 7 em https://x.invalid/${KEY}`,
    ),
    "falha",
    [],
  );
  assert.deepEqual(line, {
    code: "ORPHAN_OFFER_EVENT",
    error: "oferta 7 em https://x.invalid/[redacted]",
    level: "error",
    message: "falha",
  });
});
