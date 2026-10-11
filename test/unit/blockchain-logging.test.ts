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

test("handles thrown values that are not Error instances", () => {
  assert.equal(
    safeChainErrorMessage(
      `falhou em https://rpc.example.invalid/v2/${KEY}`,
      [],
    ),
    "falhou em https://rpc.example.invalid/[redacted]",
  );
  assert.equal(safeChainErrorMessage(undefined, []), "undefined");
  assert.equal(safeChainErrorMessage(42, []), "42");
  assert.doesNotMatch(
    safeChainErrorMessage({ toString: () => `wss://x.invalid/${KEY}` }, []),
    new RegExp(KEY),
  );
});

test("redacts a percent-encoded password in both encoded and decoded form", () => {
  const db = "postgresql://operador:p%40ss-word-longa@db.example.invalid/x";
  const text = "auth p%40ss-word-longa | auth p@ss-word-longa";
  const redacted = redactSecrets(text, [db]);
  assert.doesNotMatch(redacted, /ss-word-longa/);
});

test("keeps host and port, including IPv6, and trailing punctuation", () => {
  assert.equal(
    redactSecrets(`(https://rpc.example.invalid:8545/v2/${KEY}).`, []),
    "(https://rpc.example.invalid:8545/[redacted]).",
  );
  assert.equal(
    redactSecrets(`em http://[::1]:8545/${KEY}`, []),
    "em http://[::1]:8545/[redacted]",
  );
  assert.equal(
    redactSecrets(`HTTPS://RPC.EXAMPLE.INVALID/v2/${KEY}`, []),
    "https://rpc.example.invalid/[redacted]",
  );
});

test("redacts every occurrence and secrets with regex characters", () => {
  const secret = "token+com.(regex)*chars?";
  const text = `a ${secret} b ${secret} c https://x.invalid/${KEY} https://y.invalid/${KEY}`;
  const redacted = redactSecrets(text, [secret]);
  assert.doesNotMatch(redacted, /regex/);
  assert.doesNotMatch(redacted, new RegExp(KEY));
  assert.equal(redacted.match(/\[redacted\]/g)?.length, 4);
});

test("short URL parts are not redacted on their own", () => {
  // "v2", "u" e "db" sozinhos não são segredo e apagá-los destruiria a mensagem.
  const redacted = redactSecrets("erro v2 do usuario u no db", [
    "postgresql://u:senha-longa-123@db/x",
    `https://rpc.example.invalid/v2/${KEY}`,
  ]);
  assert.equal(redacted, "erro v2 do usuario u no db");
});

test("the error cause is never logged, only the sanitized message", () => {
  const error = new Error("falha na consulta", {
    cause: new Error(`https://rpc.example.invalid/v2/${KEY}`),
  });
  const line = chainErrorLog(error, "falha", []);
  assert.doesNotMatch(JSON.stringify(line), new RegExp(KEY));
  assert.equal(line.error, "falha na consulta");
});

test("a non-string error code is left out of the log line", () => {
  const error = Object.assign(new Error("x"), { code: 503 });
  assert.equal("code" in chainErrorLog(error, "falha", []), false);
});
