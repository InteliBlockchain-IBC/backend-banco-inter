import assert from "node:assert/strict";
import test from "node:test";
import { safeChainErrorMessage } from "../../src/blockchain/logging.js";

test("redacts an RPC URL and its API key from worker errors", () => {
  const key = "a-chave-que-nao-pode-aparecer";
  const message = safeChainErrorMessage(
    new Error(
      `RPC Request failed. URL: https://eth-sepolia.g.alchemy.com/v2/${key}`,
    ),
  );

  assert.doesNotMatch(message, new RegExp(key));
  assert.match(message, /https:\/\/eth-sepolia\.g\.alchemy\.com\/\[redacted\]/);
});

test("keeps non-URL error details useful", () => {
  assert.equal(
    safeChainErrorMessage(new Error("timeout ao consultar o bloco")),
    "timeout ao consultar o bloco",
  );
});
