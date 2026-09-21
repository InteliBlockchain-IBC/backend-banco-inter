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
