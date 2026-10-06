import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationError, loadConfig } from "../src/config.js";

const DATABASE_URL =
  "postgresql://banco_inter:segredo@127.0.0.1:5432/banco_inter";

test("uses safe configuration defaults", () => {
  assert.deepEqual(loadConfig({ DATABASE_URL }), {
    databaseUrl: DATABASE_URL,
    host: "127.0.0.1",
    nodeEnv: "production",
    port: 3000,
  });
});

test("production requires DATABASE_URL", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL é obrigatória/);
  assert.throws(
    () => loadConfig({ DATABASE_URL: "  ", NODE_ENV: "production" }),
    ConfigurationError,
  );
});

test("development and test fall back to the in-memory store", () => {
  for (const NODE_ENV of ["development", "test"]) {
    assert.equal(loadConfig({ NODE_ENV }).databaseUrl, undefined);
  }
});

test("rejects a DATABASE_URL that is not postgres without echoing it", () => {
  for (const url of ["mysql://u:segredo@h/db", "segredo", "postgresql://a b"]) {
    assert.throws(
      () => loadConfig({ DATABASE_URL: url, NODE_ENV: "test" }),
      (error: Error) =>
        error instanceof ConfigurationError &&
        !error.message.includes("segredo"),
    );
  }
});

test("accepts both postgres URL schemes", () => {
  for (const url of [
    DATABASE_URL,
    "postgres://u:p@db:5432/x?sslmode=require",
  ]) {
    assert.equal(loadConfig({ DATABASE_URL: url }).databaseUrl, url);
  }
});

test("rejects a non-numeric port", () => {
  assert.throws(
    () => loadConfig({ PORT: "three-thousand" }),
    ConfigurationError,
  );
});

test("rejects an unsupported environment", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "preview" }), ConfigurationError);
});

test("rejects a port outside the valid range", () => {
  for (const port of ["0", "65536", "-1", ""]) {
    assert.throws(() => loadConfig({ PORT: port }), ConfigurationError);
  }
});

test("accepts the port boundaries", () => {
  assert.equal(loadConfig({ DATABASE_URL, PORT: "1" }).port, 1);
  assert.equal(loadConfig({ DATABASE_URL, PORT: "65535" }).port, 65535);
});

test("rejects a port that is not a decimal integer", () => {
  // `Number()` aceita as três formas abaixo; a configuração não.
  for (const port of ["1e3", "0x10", "3000.5", " 3000"]) {
    assert.throws(() => loadConfig({ PORT: port }), ConfigurationError);
  }
});

test("rejects a host that is not an address", () => {
  for (const host of ["", "   ", "not a host!", "http://x", "a/b"]) {
    assert.throws(() => loadConfig({ HOST: host }), ConfigurationError);
  }
});

test("accepts IPv4, IPv6 and hostname forms", () => {
  for (const host of ["127.0.0.1", "0.0.0.0", "::1", "localhost"]) {
    assert.equal(loadConfig({ DATABASE_URL, HOST: host }).host, host);
  }
});
