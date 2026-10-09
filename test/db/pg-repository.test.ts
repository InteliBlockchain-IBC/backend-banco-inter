import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { buildApp } from "../../src/app.js";
import { migrate } from "../../src/database/migrate.js";
import { seedDemo } from "../../src/database/seed.js";
import { hashOf, mockOfferId, mockWallets, offers, START } from "../support.js";

/**
 * Integração com PostgreSQL real. Cada teste cria um schema descartável,
 * aplica as migrations e o seed com o mesmo relógio da API em memória. O teste
 * central executa a mesma sequência nas duas fontes de dados e exige respostas
 * idênticas: o fim dos mocks não pode mudar o contrato que o frontend consome.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip =
  DATABASE_URL === undefined ? "TEST_DATABASE_URL is required" : undefined;

type Clock = { advance: (ms: number) => void; now: () => Date };

function clock(): Clock {
  let current = START.getTime();
  return {
    advance: (ms) => {
      current += ms;
    },
    now: () => new Date(current),
  };
}

/** Ids determinísticos e iguais nas duas fontes. */
function ids(): () => string {
  let n = 0;
  return () => `c0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

async function isolatedDatabase(t: TestContext): Promise<string> {
  assert.ok(DATABASE_URL);
  const schema = `sprint3_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const url = new URL(DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  await migrate(url.toString(), resolve(ROOT, "migrations"));
  await seedDemo(url.toString(), { mode: "reset", now: START });
  return url.toString();
}

async function pgApp(
  t: TestContext,
  databaseUrl: string,
  time: Clock,
): Promise<FastifyInstance> {
  const app = await buildApp({
    databaseUrl,
    logger: false,
    newId: ids(),
    nodeEnv: "test",
    now: time.now,
  });
  t.after(() => app.close());
  return app;
}

async function memoryApp(
  t: TestContext,
  time: Clock,
): Promise<FastifyInstance> {
  const app = await buildApp({
    logger: false,
    newId: ids(),
    nodeEnv: "test",
    now: time.now,
  });
  t.after(() => app.close());
  return app;
}

type Step = {
  headers?: Record<string, string>;
  method: "GET" | "POST";
  payload?: Record<string, unknown>;
  url: string;
};

/** Corpo comparável: sem correlationId nem a origem, que diferem por definição. */
function comparable(response: LightMyRequestResponse) {
  const body = response.json();
  if (body?.meta?.source !== undefined) body.meta.source = "<source>";
  if (typeof body?.correlationId === "string") body.correlationId = "<id>";
  return { body, status: response.statusCode };
}

const reads = [
  "/api/deployment",
  "/api/sync-status",
  "/api/offers",
  "/api/offers?limit=3&offset=2",
  "/api/offers?status=offered",
  "/api/offers?status=expired",
  "/api/offers?status=settled",
  `/api/offers?wallet=${mockWallets.beta}&role=borrower`,
  `/api/offers?wallet=${mockWallets.alfa}&role=lender`,
  `/api/offers?wallet=${mockWallets.gama}`,
  "/api/offers?offset=50",
  `/api/offers/${mockOfferId(offers.settledAlfaToBeta)}`,
  `/api/offers/${mockOfferId(offers.openGamaToAlfa)}/events`,
  `/api/offers/${mockOfferId(99)}`,
  "/api/operations",
  `/api/operations?wallet=${mockWallets.gama}&limit=1`,
  `/api/operations/${hashOf("f")}`,
  "/api/credit-limits",
  `/api/credit-limits?registered=true&minAvailableCents=10000000000&excludeWallet=${mockWallets.alfa}`,
  `/api/credit-limits/${mockWallets.delta}`,
  `/api/credit-limits/${mockWallets.beta}/history`,
  `/api/credit-limits/${hashOf("e").slice(0, 42)}`,
].map((url): Step => ({ method: "GET", url }));

const simulated = {
  amountCents: "100000000",
  borrowerWallet: mockWallets.beta,
  lenderWallet: mockWallets.alfa,
  rateCdiBps: 10_500,
  termDays: 1,
  validitySeconds: 3_600,
};

const as = (wallet: string) => ({ "x-wallet-address": wallet });

test("PostgreSQL serves the same payloads as the in-memory store", {
  skip,
}, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const memoryClock = clock();
  const pgClock = clock();
  const memory = await memoryApp(t, memoryClock);
  const postgres = await pgApp(t, databaseUrl, pgClock);

  const run = async (steps: Step[]) => {
    for (const step of steps) {
      const [expected, actual] = await Promise.all([
        memory.inject(step),
        postgres.inject(step),
      ]);
      assert.deepEqual(
        comparable(actual),
        comparable(expected),
        `${step.method} ${step.url}`,
      );
    }
  };
  const tick = (ms: number) => {
    memoryClock.advance(ms);
    pgClock.advance(ms);
  };

  await run(reads);

  // Intenções: criação, ação, conflito, submissão, duplicidade e vencimento.
  const createIntent: Step = {
    headers: as(mockWallets.alfa),
    method: "POST",
    payload: {
      amountCents: "100000000",
      borrowerWallet: mockWallets.beta,
      rateCdiBps: 10_500,
      termDays: 1,
      validitySeconds: 3_600,
    },
    url: "/api/offers",
  };
  const firstIntent = "c0000000-0000-4000-8000-000000000001";
  const secondIntent = "c0000000-0000-4000-8000-000000000002";
  await run([
    createIntent,
    { ...createIntent, headers: as(mockWallets.delta) },
    {
      ...createIntent,
      payload: { ...createIntent.payload, amountCents: "999999999999999" },
    },
    {
      headers: as(mockWallets.beta),
      method: "POST",
      url: `/api/offers/${mockOfferId(offers.openAlfaToBeta)}/accept`,
    },
    {
      headers: as(mockWallets.beta),
      method: "POST",
      url: `/api/offers/${mockOfferId(offers.openAlfaToBeta)}/accept`,
    },
    {
      headers: as(mockWallets.gama),
      method: "POST",
      url: `/api/offers/${mockOfferId(offers.openAlfaToBeta)}/cancel`,
    },
    {
      headers: as(mockWallets.alfa),
      method: "POST",
      url: `/api/offers/${mockOfferId(offers.cancelled)}/reject`,
    },
    {
      headers: as(mockWallets.beta),
      method: "POST",
      url: `/api/offers/${mockOfferId(offers.expiredLazy)}/accept`,
    },
    {
      headers: as(mockWallets.gama),
      method: "POST",
      payload: { txHash: hashOf("1") },
      url: `/api/transaction-requests/${firstIntent}/submission`,
    },
    {
      headers: as(mockWallets.alfa),
      method: "POST",
      payload: { txHash: hashOf("1") },
      url: `/api/transaction-requests/${firstIntent}/submission`,
    },
    {
      headers: as(mockWallets.beta),
      method: "POST",
      payload: { txHash: hashOf("1") },
      url: `/api/transaction-requests/${secondIntent}/submission`,
    },
    { method: "GET", url: `/api/transaction-requests/${firstIntent}` },
  ]);
  tick(16 * 60_000);
  await run([
    {
      headers: as(mockWallets.beta),
      method: "POST",
      payload: { txHash: hashOf("2") },
      url: `/api/transaction-requests/${secondIntent}/submission`,
    },
    { method: "GET", url: `/api/transaction-requests/${secondIntent}` },
  ]);

  // Simulação persistida: criar, aceitar, rejeitar, cancelar e recusas.
  tick(1_000);
  await run([
    { method: "POST", payload: simulated, url: "/api/mock/offers" },
    {
      method: "POST",
      payload: { ...simulated, lenderWallet: mockWallets.delta },
      url: "/api/mock/offers",
    },
    {
      method: "POST",
      payload: { ...simulated, borrowerWallet: mockWallets.alfa },
      url: "/api/mock/offers",
    },
    {
      method: "POST",
      payload: { ...simulated, amountCents: "999999999999999" },
      url: "/api/mock/offers",
    },
  ]);
  const created = (
    await postgres.inject({ method: "GET", url: "/api/offers?limit=1" })
  ).json().data[0].id;
  tick(1_000);
  await run([{ method: "POST", payload: simulated, url: "/api/mock/offers" }]);
  const second = (
    await postgres.inject({ method: "GET", url: "/api/offers?limit=1" })
  ).json().data[0].id;
  tick(1_000);
  await run([
    { method: "POST", url: `/api/mock/offers/${created.toUpperCase()}/accept` },
    { method: "POST", url: `/api/mock/offers/${created}/cancel` },
    { method: "POST", url: `/api/mock/offers/${second}/reject` },
    {
      method: "POST",
      url: `/api/mock/offers/${mockOfferId(offers.openGamaToAlfa)}/cancel`,
    },
    {
      method: "POST",
      url: `/api/mock/offers/${mockOfferId(offers.expiredLazy)}/accept`,
    },
  ]);
  tick(2 * 60 * 60_000);
  await run(reads);
});

test("writes survive a restart of the API", { skip }, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const time = clock();
  const first = await pgApp(t, databaseUrl, time);
  const create = await first.inject({
    method: "POST",
    payload: simulated,
    url: "/api/mock/offers",
  });
  const id = create.json().data.offer.id;
  const accept = await first.inject({
    method: "POST",
    url: `/api/mock/offers/${id}/accept`,
  });
  assert.equal(accept.statusCode, 200);
  const operation = accept.json().data.operation;
  await first.close();

  const second = await pgApp(t, databaseUrl, time);
  const receipt = await second.inject({
    method: "GET",
    url: `/api/operations/${operation.txHash}`,
  });
  assert.equal(receipt.statusCode, 200);
  assert.equal(receipt.headers["x-data-source"], "postgres");
  assert.deepEqual(receipt.json().data, operation);
  assert.equal(receipt.json().data.rateCdiBps, simulated.rateCdiBps);
  assert.equal(receipt.json().data.lender.wallet, mockWallets.alfa);
  assert.equal(receipt.json().data.borrower.wallet, mockWallets.beta);
});

test("concurrent accepts settle an offer exactly once", { skip }, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const app = await pgApp(t, databaseUrl, clock());
  const url = `/api/mock/offers/${mockOfferId(offers.openAlfaToBeta)}/accept`;

  const responses = await Promise.all(
    Array.from({ length: 5 }, () => app.inject({ method: "POST", url })),
  );

  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [200, 409, 409, 409, 409],
  );
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  const settlements = await db.query(
    "SELECT 1 FROM settlements WHERE offer_id = $1",
    [mockOfferId(offers.openAlfaToBeta)],
  );
  assert.equal(settlements.rowCount, 1);
});

test("readiness reports the database and answers 503 when it is down", {
  skip,
}, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const up = await pgApp(t, databaseUrl, clock());
  const ready = await up.inject({ method: "GET", url: "/ready" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), {
    dependencies: [{ name: "postgres", status: "up" }],
    status: "ready",
  });

  const down = await pgApp(
    t,
    "postgresql://nobody:nothing@127.0.0.1:1/none",
    clock(),
  );
  const unready = await down.inject({ method: "GET", url: "/ready" });
  assert.equal(unready.statusCode, 503);
  assert.equal(unready.json().title, "Banco de dados indisponível");
  assert.doesNotMatch(unready.body, /nothing/);
  const health = await down.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
});

test("an empty database answers 503 until the seed runs", {
  skip,
}, async (t) => {
  assert.ok(DATABASE_URL);
  const databaseUrl = await isolatedDatabase(t);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  await db.query(
    "TRUNCATE sync_cursors, settlements, credit_limit_history, chain_events, transaction_requests, offers, contract_wallet_state, contract_deployments, institution_wallets, institutions",
  );
  const app = await pgApp(t, databaseUrl, clock());

  const response = await app.inject({ method: "GET", url: "/api/offers" });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().title, "Contrato não registrado");
  assert.deepEqual(await seedDemo(databaseUrl, { now: START }), {
    offers: 9,
    seeded: true,
  });
  assert.deepEqual(await seedDemo(databaseUrl, { now: START }), {
    offers: 0,
    seeded: false,
  });
  const after = await app.inject({ method: "GET", url: "/api/offers" });
  assert.equal(after.json().meta.total, 9);
});

test("one institution operates several wallets", { skip }, async (t) => {
  const databaseUrl = await isolatedDatabase(t);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  t.after(() => db.end());
  // O seed já dá duas carteiras ao Alfa; esta é a terceira.
  const treasury = `0x${"a8".repeat(20)}`;
  const { rows } = await db.query<{
    chain_id: string;
    contract_address: string;
  }>("SELECT chain_id, contract_address FROM contract_deployments");
  const deployment = rows[0];
  assert.ok(deployment);
  // Segunda carteira do Banco Alfa: vínculo off-chain + estado on-chain próprio.
  await db.query(
    `INSERT INTO institution_wallets (wallet_address, institution_id, label)
     SELECT $1, institution_id, 'Câmbio' FROM institution_wallets
      WHERE wallet_address = $2`,
    [treasury, mockWallets.alfa],
  );
  await db.query(
    `INSERT INTO contract_wallet_state (chain_id, contract_address,
       wallet_address, is_registered, available_limit_cents, observed_block)
     VALUES ($1, $2, $3, true, 5000000000, 1)`,
    [deployment.chain_id, deployment.contract_address, treasury],
  );
  const app = await pgApp(t, databaseUrl, clock());

  const [main, second] = await Promise.all(
    [mockWallets.alfa, treasury].map((wallet) =>
      app.inject({ method: "GET", url: `/api/credit-limits/${wallet}` }),
    ),
  );
  assert.equal(second?.statusCode, 200);
  assert.deepEqual(
    second?.json().data.institution,
    main?.json().data.institution,
  );
  assert.equal(second?.json().data.availableLimitCents, "5000000000");
  assert.notEqual(
    main?.json().data.availableLimitCents,
    second?.json().data.availableLimitCents,
    "cada carteira tem o próprio limite on-chain",
  );

  const create = await app.inject({
    method: "POST",
    payload: { ...simulated, lenderWallet: treasury },
    url: "/api/mock/offers",
  });
  assert.equal(create.statusCode, 201);
  const lender = create.json().data.offer.lender;
  assert.equal(lender.wallet, treasury);
  assert.equal(lender.institution.name, "Banco Alfa S.A. (fictício)");

  const byInstitution = await db.query<{ wallets: string }>(
    `SELECT count(*) AS wallets FROM institution_wallets iw
       JOIN institutions i ON i.id = iw.institution_id
      WHERE i.name = 'Banco Alfa S.A. (fictício)'`,
  );
  assert.equal(byInstitution.rows[0]?.wallets, "3");
});
