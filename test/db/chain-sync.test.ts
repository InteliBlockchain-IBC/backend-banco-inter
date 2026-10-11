import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  type Hash,
  type Hex,
} from "viem";
import { buildApp } from "../../src/app.js";
import { creditInterbankOfferAbi } from "../../src/blockchain/abi.js";
import {
  type ChainReader,
  ChainSyncError,
  type ChainSyncOptions,
  syncChain,
} from "../../src/blockchain/sync.js";
import { migrate } from "../../src/database/migrate.js";
import { seedDemo } from "../../src/database/seed.js";
import { START } from "../support.js";

/**
 * Integração real do listener: PostgreSQL de TEST_DATABASE_URL (um schema
 * descartável por teste) e uma chain Sepolia falsa que entrega logs
 * codificados com a ABI do contrato, como o eth_getLogs faria.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip =
  DATABASE_URL === undefined ? "TEST_DATABASE_URL is required" : undefined;

const CONTRACT = "0x00000000000000000000000000000000000000c1" as Address;
const BRL = "0x00000000000000000000000000000000000000b1" as Address;
const POSITION = "0x00000000000000000000000000000000000000d1" as Address;
const LENDER = "0x1111111111111111111111111111111111111111" as Address;
const BORROWER = "0x2222222222222222222222222222222222222222" as Address;
const SEPOLIA = 11155111;
const GENESIS_TIME = 1_790_000_000n;
const LOCK = 724182916;

type EventName = (typeof creditInterbankOfferAbi)[number]["name"];

const txHash = (n: number): Hash =>
  `0x${n.toString(16).padStart(64, "a")}` as Hash;

/** Chain em memória com head, reorgs e falhas sob controle do teste. */
class FakeChain {
  chainId = SEPOLIA;
  head = 0n;
  failBlock: bigint | undefined;
  onGetLogs: (() => Promise<void>) | undefined;
  readonly ranges: Array<[bigint, bigint]> = [];
  readonly #forks = new Map<bigint, number>();
  readonly #logs: Array<Record<string, unknown>> = [];

  blockHash(number: bigint): Hash {
    const fork = this.#forks.get(number) ?? 0;
    return `0x${fork.toString(16).padStart(8, "0")}${number
      .toString(16)
      .padStart(56, "0")}` as Hash;
  }

  /** O bloco passa a ter outro hash canônico; logs já emitidos ficam no antigo. */
  reorg(number: bigint) {
    this.#forks.set(number, (this.#forks.get(number) ?? 0) + 1);
  }

  emit(
    block: number,
    tx: number,
    logIndex: number,
    eventName: EventName,
    args: Record<string, unknown>,
  ) {
    const item = getAbiItem({
      abi: creditInterbankOfferAbi,
      name: eventName,
    } as Parameters<typeof getAbiItem>[0]) as unknown as {
      inputs: ReadonlyArray<{ indexed?: boolean; name: string; type: string }>;
    };
    const topics = encodeEventTopics({
      abi: creditInterbankOfferAbi,
      eventName,
      args,
    } as Parameters<typeof encodeEventTopics>[0]);
    const data = encodeAbiParameters(
      item.inputs.filter((input) => !input.indexed),
      item.inputs
        .filter((input) => !input.indexed)
        .map((input) => args[input.name]),
    );
    this.raw(block, tx, logIndex, topics as Hex[], data);
  }

  raw(block: number, tx: number, logIndex: number, topics: Hex[], data: Hex) {
    const number = BigInt(block);
    this.#logs.push({
      address: CONTRACT,
      blockHash: this.blockHash(number),
      blockNumber: number,
      data,
      logIndex,
      removed: false,
      topics,
      transactionHash: txHash(tx),
      transactionIndex: 0,
    });
  }

  client(): ChainReader {
    return {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        if (blockNumber > this.head) throw new Error("bloco futuro");
        if (blockNumber === this.failBlock)
          throw new Error(
            "HTTP request failed. URL: https://rpc.example.invalid/v2/chave-secreta-de-teste",
          );
        return {
          hash: this.blockHash(blockNumber),
          timestamp: GENESIS_TIME + blockNumber * 12n,
        };
      },
      getBlockNumber: async () => this.head,
      getChainId: async () => this.chainId,
      getLogs: async ({
        fromBlock,
        toBlock,
      }: {
        fromBlock: bigint;
        toBlock: bigint;
      }) => {
        assert.ok(toBlock - fromBlock + 1n <= 10n, "intervalo acima do RPC");
        assert.ok(toBlock <= this.head);
        this.ranges.push([fromBlock, toBlock]);
        await this.onGetLogs?.();
        return this.#logs.filter((log) => {
          const n = log.blockNumber as bigint;
          return n >= fromBlock && n <= toBlock;
        });
      },
    } as unknown as ChainReader;
  }
}

async function isolatedDatabase(t: TestContext): Promise<string> {
  assert.ok(DATABASE_URL);
  const schema = `sprint4_${randomUUID().replaceAll("-", "")}`;
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
  return url.toString();
}

async function connect(t: TestContext, url: string) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  t.after(() => db.end());
  return db;
}

function options(
  databaseUrl: string,
  chain: FakeChain,
  startBlock = 100,
): ChainSyncOptions {
  return {
    brlTokenAddress: BRL,
    client: chain.client(),
    confirmations: 12,
    contractAddress: CONTRACT,
    databaseUrl,
    positionTokenAddress: POSITION,
    rpcUrl: "",
    startBlock,
  };
}

async function syncAll(opts: ChainSyncOptions) {
  let indexed = 0;
  for (let pass = 0; pass < 100; pass++) {
    const result = await syncChain(opts);
    indexed += result.indexed;
    if (result.caughtUp) return indexed;
  }
  throw new Error("o listener não alcançou o head");
}

/** Cadastro, limite de 1.000,00, oferta de 300,00 e aceite liquidado. */
function happyPath(chain: FakeChain) {
  chain.emit(101, 1, 0, "InstitutionRegistered", {
    timestamp: 1n,
    wallet: LENDER,
  });
  chain.emit(101, 1, 1, "InstitutionRegistered", {
    timestamp: 1n,
    wallet: BORROWER,
  });
  chain.emit(102, 2, 0, "CreditLimitUpdated", {
    institution: BORROWER,
    newLimit: 100_000n,
    previousLimit: 0n,
    timestamp: 2n,
  });
  chain.emit(103, 3, 0, "OfferCreated", {
    amount: 30_000n,
    borrower: BORROWER,
    expiresAt: GENESIS_TIME + 103n * 12n + 3600n,
    lender: LENDER,
    offerId: 1n,
    rateCDI: 10_250n,
    term: 1n,
  });
  chain.emit(104, 4, 0, "OfferAccepted", {
    borrower: BORROWER,
    offerId: 1n,
    timestamp: 4n,
  });
  chain.emit(104, 4, 1, "OfferSettled", {
    amount: 30_000n,
    borrower: BORROWER,
    lender: LENDER,
    offerId: 1n,
    positionTokenId: 1n,
    rateCDI: 10_250n,
    term: 1n,
    timestamp: 4n,
  });
  chain.head = 104n + 12n;
}

async function counts(db: pg.Client) {
  const { rows } = await db.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM chain_events) AS events,
            (SELECT count(*) FROM settlements) AS settlements,
            (SELECT count(*) FROM credit_limit_history) AS history,
            (SELECT count(*) FROM offers) AS offers,
            (SELECT max(last_processed_block) FROM sync_cursors) AS cursor`,
  );
  return rows[0];
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ChainSyncError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

test("indexes offer, settlement, limit debit and history from Sepolia logs", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  assert.equal(await syncAll(options(url, chain)), 6);
  const db = await connect(t, url);

  const events = await db.query(
    `SELECT event_name, tx_hash, log_index, block_number, block_hash,
            block_timestamp, event_args, offer_id IS NOT NULL AS has_offer
       FROM chain_events ORDER BY block_number, log_index`,
  );
  assert.deepEqual(
    events.rows.map((row) => row.event_name),
    [
      "InstitutionRegistered",
      "InstitutionRegistered",
      "CreditLimitUpdated",
      "OfferCreated",
      "OfferAccepted",
      "OfferSettled",
    ],
  );
  const settled = events.rows[5];
  assert.equal(settled.tx_hash, txHash(4));
  assert.equal(settled.log_index, "1");
  assert.equal(settled.block_number, "104");
  assert.equal(settled.block_hash, chain.blockHash(104n));
  assert.equal(
    settled.block_timestamp.getTime(),
    Number(GENESIS_TIME + 104n * 12n) * 1000,
  );
  assert.equal(settled.has_offer, true);
  assert.deepEqual(settled.event_args, {
    amount: "30000",
    borrower: BORROWER,
    lender: LENDER,
    offerId: "1",
    positionTokenId: "1",
    rateCDI: "10250",
    term: "1",
    timestamp: "4",
  });

  const offer = await db.query(
    "SELECT status, amount_cents, create_tx_hash, created_block FROM offers",
  );
  assert.deepEqual(offer.rows, [
    {
      amount_cents: "30000",
      create_tx_hash: txHash(3),
      created_block: "103",
      status: 2,
    },
  ]);
  const settlement = await db.query(
    "SELECT tx_hash, block_number, block_hash, position_token_id FROM settlements",
  );
  assert.deepEqual(settlement.rows, [
    {
      block_hash: chain.blockHash(104n),
      block_number: "104",
      position_token_id: "1",
      tx_hash: txHash(4),
    },
  ]);
  const wallets = await db.query(
    `SELECT wallet_address, is_registered, available_limit_cents
       FROM contract_wallet_state ORDER BY wallet_address`,
  );
  assert.deepEqual(wallets.rows, [
    {
      available_limit_cents: "0",
      is_registered: true,
      wallet_address: LENDER,
    },
    {
      available_limit_cents: "70000",
      is_registered: true,
      wallet_address: BORROWER,
    },
  ]);
  const history = await db.query(
    `SELECT change_kind, previous_limit_cents, new_limit_cents, tx_hash
       FROM credit_limit_history ORDER BY block_timestamp`,
  );
  assert.deepEqual(history.rows, [
    {
      change_kind: "admin_update",
      new_limit_cents: "100000",
      previous_limit_cents: "0",
      tx_hash: txHash(2),
    },
    {
      change_kind: "settlement",
      new_limit_cents: "70000",
      previous_limit_cents: "100000",
      tx_hash: txHash(4),
    },
  ]);
  const deployment = await db.query(
    "SELECT source FROM contract_deployments WHERE contract_address = $1",
    [CONTRACT],
  );
  assert.equal(deployment.rows[0]?.source, "listener");
});

test("replaying already indexed blocks never debits the limit twice", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  const before = await counts(db);

  // Cursor de volta ao bloco inicial: os mesmos logs passam de novo.
  await db.query(
    "UPDATE sync_cursors SET last_processed_block = 100, last_processed_block_hash = $1",
    [chain.blockHash(100n)],
  );
  await syncAll(options(url, chain));

  assert.deepEqual(await counts(db), before);
  const limit = await db.query(
    "SELECT available_limit_cents FROM contract_wallet_state WHERE wallet_address = $1",
    [BORROWER],
  );
  assert.equal(limit.rows[0]?.available_limit_cents, "70000");
});

test("catches up in RPC-sized batches and waits for confirmations", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  chain.emit(139, 9, 0, "InstitutionRegistered", {
    timestamp: 1n,
    wallet: LENDER,
  });
  chain.head = 150n; // head seguro: 138
  const opts = options(url, chain);

  const first = await syncChain(opts);
  assert.deepEqual(first, {
    caughtUp: false,
    from: 100,
    indexed: 0,
    safeHead: 138,
    to: 109,
  });
  assert.equal(await syncAll(opts), 0);
  assert.deepEqual(
    chain.ranges.map(([from, to]) => [Number(from), Number(to)]),
    [
      [100, 109],
      [110, 119],
      [120, 129],
      [130, 138],
    ],
  );

  // Sem bloco novo: nada a fazer, sem nova chamada de getLogs.
  assert.equal((await syncChain(opts)).caughtUp, true);
  assert.equal(chain.ranges.length, 4);

  chain.head = 151n; // o bloco 139 atinge 12 confirmações
  assert.equal(await syncAll(opts), 1);
  const db = await connect(t, url);
  assert.equal((await counts(db))?.cursor, "139");
});

test("an offer event without its OfferCreated stops the sync", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  // START_BLOCK depois da criação da oferta (bloco 103).
  const opts = options(url, chain, 104);

  await rejectsWith(syncChain(opts), "ORPHAN_OFFER_EVENT");
  await rejectsWith(syncChain(opts), "ORPHAN_OFFER_EVENT");
  const db = await connect(t, url);
  assert.deepEqual(await counts(db), {
    cursor: null,
    events: "0",
    history: "0",
    offers: "0",
    settlements: "0",
  });
});

test("cancel, reject and expire without OfferCreated are orphans too", {
  skip,
}, async (t) => {
  for (const [eventName, args] of [
    ["OfferCancelled", { offerId: 7n, timestamp: 1n }],
    ["OfferRejected", { borrower: BORROWER, offerId: 7n, timestamp: 1n }],
    ["OfferExpired", { offerId: 7n, timestamp: 1n }],
    ["OfferAccepted", { borrower: BORROWER, offerId: 7n, timestamp: 1n }],
  ] as const) {
    const url = await isolatedDatabase(t);
    const chain = new FakeChain();
    chain.emit(105, 5, 0, eventName, args);
    chain.head = 200n;
    await rejectsWith(syncChain(options(url, chain)), "ORPHAN_OFFER_EVENT");
  }
});

test("offer status follows cancel, reject and expire events", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  const create = (block: number, offerId: bigint) =>
    chain.emit(block, block, 0, "OfferCreated", {
      amount: 1_000n,
      borrower: BORROWER,
      expiresAt: GENESIS_TIME + BigInt(block) * 12n + 60n,
      lender: LENDER,
      offerId,
      rateCDI: 10_000n,
      term: 1n,
    });
  create(101, 1n);
  create(102, 2n);
  create(103, 3n);
  chain.emit(104, 104, 0, "OfferCancelled", { offerId: 1n, timestamp: 1n });
  chain.emit(105, 105, 0, "OfferRejected", {
    borrower: BORROWER,
    offerId: 2n,
    timestamp: 1n,
  });
  chain.emit(106, 106, 0, "OfferExpired", { offerId: 3n, timestamp: 1n });
  chain.head = 120n;
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  const { rows } = await db.query(
    "SELECT onchain_offer_id, status FROM offers ORDER BY onchain_offer_id",
  );
  assert.deepEqual(rows, [
    { onchain_offer_id: "1", status: 3 },
    { onchain_offer_id: "2", status: 5 },
    { onchain_offer_id: "3", status: 4 },
  ]);
  assert.equal((await counts(db))?.history, "0");
});

test("a settlement without a projected limit rolls the batch back", {
  skip,
}, async (t) => {
  for (const [limit, code] of [
    [undefined, "MISSING_LIMIT"],
    [10_000n, "INSUFFICIENT_LIMIT"],
  ] as const) {
    const url = await isolatedDatabase(t);
    // Oferta de 300,00 sem limite projetado, ou com limite menor que ela.
    const fresh = new FakeChain();
    fresh.emit(101, 1, 0, "InstitutionRegistered", {
      timestamp: 1n,
      wallet: LENDER,
    });
    if (limit !== undefined) {
      fresh.emit(101, 1, 1, "InstitutionRegistered", {
        timestamp: 1n,
        wallet: BORROWER,
      });
      fresh.emit(102, 2, 0, "CreditLimitUpdated", {
        institution: BORROWER,
        newLimit: limit,
        previousLimit: 0n,
        timestamp: 2n,
      });
    }
    fresh.emit(103, 3, 0, "OfferCreated", {
      amount: 30_000n,
      borrower: BORROWER,
      expiresAt: GENESIS_TIME + 103n * 12n + 3600n,
      lender: LENDER,
      offerId: 1n,
      rateCDI: 10_250n,
      term: 1n,
    });
    fresh.emit(104, 4, 1, "OfferSettled", {
      amount: 30_000n,
      borrower: BORROWER,
      lender: LENDER,
      offerId: 1n,
      positionTokenId: 1n,
      rateCDI: 10_250n,
      term: 1n,
      timestamp: 4n,
    });
    fresh.head = 116n;
    await rejectsWith(syncChain(options(url, fresh)), code);
    const db = await connect(t, url);
    assert.deepEqual(await counts(db), {
      cursor: null,
      events: "0",
      history: "0",
      offers: "0",
      settlements: "0",
    });
  }
});

test("a reorg of the cursor block is detected and nothing advances", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  const opts = options(url, chain);
  await syncAll(opts);
  const db = await connect(t, url);
  const before = await counts(db);

  chain.reorg(BigInt(before?.cursor ?? 0));
  chain.head += 5n;
  await rejectsWith(syncChain(opts), "CHAIN_REORG");
  assert.deepEqual(await counts(db), before);
});

test("a log from a block that is no longer canonical is rejected", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  chain.reorg(103n); // o OfferCreated ficou no bloco órfão
  await rejectsWith(syncChain(options(url, chain)), "CHAIN_REORG");
  const db = await connect(t, url);
  assert.equal((await counts(db))?.events, "0");
});

test("refuses an RPC that is not Sepolia", { skip }, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  chain.chainId = 1;
  await rejectsWith(syncChain(options(url, chain)), "CHAIN_MISMATCH");
});

test("an RPC failure mid-batch persists nothing; the next pass recovers", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  chain.failBlock = 104n;
  const opts = options(url, chain);
  await assert.rejects(syncChain(opts), /HTTP request failed/);
  const db = await connect(t, url);
  assert.equal((await counts(db))?.events, "0");

  chain.failBlock = undefined;
  assert.equal(await syncAll(opts), 6);
});

test("logs with a known topic but undecodable data are invalid", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  const topics = encodeEventTopics({
    abi: creditInterbankOfferAbi,
    args: { wallet: LENDER },
    eventName: "InstitutionRegistered",
  }) as Hex[];
  chain.raw(101, 1, 0, topics, "0x");
  chain.head = 120n;
  await rejectsWith(syncChain(options(url, chain)), "INVALID_LOG");
});

test("logs outside the ABI (AccessControl roles) are ignored", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  chain.raw(101, 1, 0, [`0x${"ab".repeat(32)}`], "0x");
  chain.head = 120n;
  assert.equal(await syncAll(options(url, chain)), 0);
});

test("an on-chain offer id already used by seed or simulation data is a conflict", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const db = await connect(t, url);
  await db.query(
    `INSERT INTO contract_deployments (chain_id, contract_address, brl_token_address, position_token_address, start_block)
     VALUES ($1, $2, $3, $4, 100)`,
    [SEPOLIA, CONTRACT, BRL, POSITION],
  );
  await db.query(
    `INSERT INTO offers (chain_id, contract_address, onchain_offer_id, lender_wallet, borrower_wallet,
       amount_cents, rate_cdi_bps, term_days, status, created_at, expires_at, create_tx_hash, created_block)
     VALUES ($1, $2, 1, $3, $4, 5, 1, 1, 0, now(), now() + interval '1 hour', $5, 101)`,
    [SEPOLIA, CONTRACT, LENDER, BORROWER, txHash(999)],
  );
  const chain = new FakeChain();
  happyPath(chain);
  await rejectsWith(syncChain(options(url, chain)), "OFFER_CONFLICT");
});

test("parallel passes are serialized and index each event once", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  const opts = options(url, chain);
  await Promise.all([syncAll(opts), syncAll(opts), syncAll(opts)]);
  const db = await connect(t, url);
  assert.deepEqual(await counts(db), {
    cursor: "104",
    events: "6",
    history: "2",
    offers: "1",
    settlements: "1",
  });
});

test("a dropped PostgreSQL socket rejects the pass instead of killing the process", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const admin = await connect(t, url);
  const chain = new FakeChain();
  happyPath(chain);
  // Enquanto o listener espera o RPC com a transação aberta, o servidor
  // derruba a conexão dele (identificada pelo advisory lock que segura).
  chain.onGetLogs = async () => {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted",
      [LOCK],
    );
    await delay(200);
  };
  await assert.rejects(
    syncChain(options(url, chain)),
    /Conexão com o PostgreSQL perdida/,
  );
  chain.onGetLogs = undefined;
  assert.equal(await syncAll(options(url, chain)), 6);
});

test("simulations are refused on the listener deployment and seed reset keeps its data", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  await seedDemo(url, { mode: "reset", now: START });
  const chain = new FakeChain();
  happyPath(chain);
  await syncAll(options(url, chain));

  const app = await buildApp({
    databaseUrl: url,
    logger: false,
    nodeEnv: "test",
    now: () => START,
  });
  t.after(() => app.close());

  const deployment = await app.inject({ url: "/api/deployment" });
  assert.equal(deployment.json().data.contractAddress, CONTRACT);
  const simulated = await app.inject({
    method: "POST",
    payload: {
      amountCents: "1000",
      borrowerWallet: BORROWER,
      lenderWallet: LENDER,
      rateCdiBps: 10_000,
      termDays: 1,
      validitySeconds: 3600,
    },
    url: "/api/mock/offers",
  });
  assert.equal(simulated.statusCode, 409);
  assert.match(simulated.json().type, /simulation-unavailable$/);
  const offers = await app.inject({ url: "/api/offers" });
  assert.equal(offers.json().meta.total, 1);

  const db = await connect(t, url);
  await seedDemo(url, { mode: "reset", now: START });
  const listener = await db.query(
    `SELECT (SELECT count(*) FROM chain_events WHERE contract_address = $1) AS events,
            (SELECT max(last_processed_block) FROM sync_cursors WHERE contract_address = $1) AS cursor`,
    [CONTRACT],
  );
  assert.deepEqual(listener.rows[0], { cursor: "104", events: "6" });
});
