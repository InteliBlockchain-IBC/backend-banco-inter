import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationError, loadConfig } from "../src/config.js";

test("uses safe configuration defaults", () => {
  assert.deepEqual(loadConfig({}), {
    host: "127.0.0.1",
    nodeEnv: "development",
    port: 3000,
  });
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
  assert.equal(loadConfig({ PORT: "1" }).port, 1);
  assert.equal(loadConfig({ PORT: "65535" }).port, 65535);
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
    assert.equal(loadConfig({ HOST: host }).host, host);
  }
});
