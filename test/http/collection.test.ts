import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { API_VERSION, buildApp } from "../../src/app.js";
import { documentedOperations } from "./openapi.test.js";

// dist/test/collection.test.js -> raiz do repositório
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type Item = {
  item?: Item[];
  name?: string;
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
        assert.ok(item.name?.trim(), "A requisição exportada precisa de nome");
        const path = item.request.url.path
          .map((segment) =>
            segment
              .replace(
                /^\{\{(openOfferId|settledOfferId|cancelOfferId|mockOfferId|requestId)\}\}$/,
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

test("the exported collection asserts the HTTP status of every request", async () => {
  type CollectionItem = Item & {
    event?: { listen: string; script: { exec: string[] } }[];
    item?: CollectionItem[];
  };
  const collection = JSON.parse(
    await readFile(
      resolve(
        ROOT,
        "docs/collection/backend-banco-inter.postman_collection.json",
      ),
      "utf8",
    ),
  ) as { item: CollectionItem[] };
  let requests = 0;
  const check = (items: typeof collection.item) => {
    for (const item of items) {
      if (item.item) {
        check(item.item);
        continue;
      }
      if (!item.request) continue;
      requests++;
      const scripts = item.event?.filter((event) => event.listen === "test");
      assert.ok(
        scripts?.some((event) =>
          event.script.exec.some((line) => line.includes("pm.test(")),
        ),
        `${item.request.method} ${item.request.url.path.join("/")}`,
      );
    }
  };
  check(collection.item);
  assert.equal(requests, 24);
});

test("docs/openapi.json matches the served contract (run npm run docs:export)", async (t) => {
  const app = await buildApp({ logger: false, nodeEnv: "development" });
  t.after(() => app.close());
  await app.ready();

  const exported = JSON.parse(
    await readFile(resolve(ROOT, "docs/openapi.json"), "utf8"),
  );

  assert.deepEqual(exported, JSON.parse(JSON.stringify(app.swagger())));
});

test("exported 403 examples replay with their saved wallet and payload", async (t) => {
  type SavedRequest = {
    header: { key: string; value: string }[];
    method: "GET" | "POST";
    url: { raw: string };
    body?: { raw: string };
  };
  type SavedExample = {
    body: string;
    code: number;
    name: string;
    originalRequest: SavedRequest;
  };
  type CollectionItem = { item?: CollectionItem[]; response?: SavedExample[] };
  const collection = JSON.parse(
    await readFile(
      resolve(
        ROOT,
        "docs/collection/backend-banco-inter.postman_collection.json",
      ),
      "utf8",
    ),
  ) as {
    item: CollectionItem[];
    variable: { key: string; value: string }[];
  };
  const variables: Record<string, string> = Object.fromEntries(
    collection.variable.map(({ key, value }) => [key, value]),
  );
  const baseUrl = variables.baseUrl;
  assert.ok(baseUrl);
  const expand = (value: string) =>
    value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => variables[name] ?? "");
  const examples: SavedExample[] = [];
  const collect = (items: CollectionItem[]) => {
    for (const item of items) {
      examples.push(
        ...(item.response ?? []).filter((example) => example.code === 403),
      );
      if (item.item) collect(item.item);
    }
  };
  collect(collection.item);
  assert.ok(examples.length >= 3);
  for (const example of examples) {
    const app = await buildApp({
      logger: false,
      nodeEnv: "test",
      now: () => new Date("2026-09-29T12:00:00.000Z"),
    });
    t.after(() => app.close());
    const request = example.originalRequest;
    const response: { statusCode: number; json(): { type: string } } =
      await app.inject({
        method: request.method,
        url: expand(request.url.raw).replace(baseUrl, ""),
        headers: Object.fromEntries(
          request.header.map(({ key, value }) => [key, expand(value)]),
        ),
        ...(request.body
          ? { payload: JSON.parse(expand(request.body.raw)) }
          : {}),
      });
    assert.equal(response.statusCode, example.code, example.name);
    assert.equal(response.json().type, JSON.parse(example.body ?? "{}").type);
  }
});
