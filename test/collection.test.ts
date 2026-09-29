import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { API_VERSION, buildApp } from "../src/app.js";
import { documentedOperations } from "./openapi.test.js";

// dist/test/collection.test.js -> raiz do repositório
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type Item = {
  item?: Item[];
  request?: { method: string; url: { path: string[] } };
};

test("the exported collection covers every documented operation", async () => {
  const collection = JSON.parse(
    await readFile(
      resolve(
        ROOT,
        "docs/collection/backend-banco-inter.postman_collection.json",
      ),
      "utf8",
    ),
  ) as { info: { version: string }; item: Item[] };

  const found = new Set<string>();
  const walk = (items: Item[]) => {
    for (const item of items) {
      if (item.item) walk(item.item);
      if (item.request) {
        const path = item.request.url.path
          .map((segment) =>
            segment
              .replace(
                /^\{\{(openOfferId|settledOfferId|requestId)\}\}$/,
                "{id}",
              )
              .replace(/^\{\{settledTxHash\}\}$/, "{txHash}")
              .replace(/^\{\{\w+Wallet\}\}$/, "{wallet}"),
          )
          .join("/");
        found.add(`${item.request.method} /${path}`);
      }
    }
  };
  walk(collection.item);

  assert.equal(collection.info.version, API_VERSION);
  assert.deepEqual([...found].sort(), [...documentedOperations].sort());
});

test("docs/openapi.json matches the served contract (run npm run docs:export)", async (t) => {
  const app = await buildApp({ logger: false });
  t.after(() => app.close());
  await app.ready();

  const exported = JSON.parse(
    await readFile(resolve(ROOT, "docs/openapi.json"), "utf8"),
  );

  assert.deepEqual(exported, JSON.parse(JSON.stringify(app.swagger())));
});
