import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { safeChainErrorMessage } from "../../src/blockchain/logging.js";
import { syncChain } from "../../src/blockchain/sync.js";
import {
  BORROWER,
  CONTRACT,
  connect,
  counts,
  DATABASE_URL,
  FakeChain,
  GENESIS_TIME,
  happyPath,
  isolatedDatabase,
  LENDER,
  options,
  rejectsWith,
  skip,
  syncAll,
  txHash,
} from "./chain-support.js";

/**
 * Casos de erro e de borda do listener: dados da chain que não batem com a
 * projeção, respostas malformadas do RPC, limites numéricos e operação.
 */

const NOTHING = {
  cursor: null,
  events: "0",
  history: "0",
  offers: "0",
  settlements: "0",
};

/** Cadastro e limite do tomador, sem oferta. */
function registered(chain: FakeChain, limit = 100_000n) {
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
    newLimit: limit,
    previousLimit: 0n,
    timestamp: 2n,
  });
}

function created(
  chain: FakeChain,
  block: number,
  offerId: bigint,
  amount: bigint,
) {
  chain.emit(block, block, 0, "OfferCreated", {
    amount,
    borrower: BORROWER,
    expiresAt: GENESIS_TIME + BigInt(block) * 12n + 3600n,
    lender: LENDER,
    offerId,
    rateCDI: 10_250n,
    term: 1n,
  });
}

function settled(
  chain: FakeChain,
  block: number,
  offerId: bigint,
  amount: bigint,
  parties: { borrower?: string; lender?: string } = {},
) {
  chain.emit(block, block, 0, "OfferSettled", {
    amount,
    borrower: parties.borrower ?? BORROWER,
    lender: parties.lender ?? LENDER,
    offerId,
    positionTokenId: offerId,
    rateCDI: 10_250n,
    term: 1n,
    timestamp: 1n,
  });
}

async function limitOf(db: pg.Client, wallet: string) {
  const { rows } = await db.query(
    "SELECT available_limit_cents, is_registered FROM contract_wallet_state WHERE wallet_address = $1",
    [wallet],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Dados da chain que não batem com a projeção
// ---------------------------------------------------------------------------

test("a settlement amount different from the offer is a conflict", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  registered(chain);
  created(chain, 103, 1n, 30_000n);
  settled(chain, 104, 1n, 99_999n);
  chain.head = 200n;
  await rejectsWith(syncChain(options(url, chain)), "OFFER_CONFLICT");
  assert.deepEqual(await counts(await connect(t, url)), NOTHING);
});

test("a settlement with other counterparties than the offer is a conflict", {
  skip,
}, async (t) => {
  for (const parties of [
    { borrower: "0x3333333333333333333333333333333333333333" },
    { lender: "0x4444444444444444444444444444444444444444" },
  ]) {
    const url = await isolatedDatabase(t);
    const chain = new FakeChain();
    registered(chain);
    created(chain, 103, 1n, 30_000n);
    settled(chain, 104, 1n, 30_000n, parties);
    chain.head = 200n;
    await rejectsWith(syncChain(options(url, chain)), "OFFER_CONFLICT");
  }
});

test("a limit lowered on-chain makes a later projected settlement insufficient", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  registered(chain);
  created(chain, 103, 1n, 30_000n);
  chain.emit(104, 104, 0, "CreditLimitUpdated", {
    institution: BORROWER,
    newLimit: 0n,
    previousLimit: 100_000n,
    timestamp: 3n,
  });
  chain.head = 104n + 12n;
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  assert.equal((await limitOf(db, BORROWER))?.available_limit_cents, "0");
  const history = await db.query(
    "SELECT previous_limit_cents, new_limit_cents FROM credit_limit_history ORDER BY block_timestamp",
  );
  assert.deepEqual(history.rows.at(-1), {
    new_limit_cents: "0",
    previous_limit_cents: "100000",
  });

  settled(chain, 105, 1n, 30_000n);
  chain.head = 105n + 12n;
  await rejectsWith(syncChain(options(url, chain)), "INSUFFICIENT_LIMIT");
  assert.equal((await counts(db))?.cursor, "104");
});

// ---------------------------------------------------------------------------
// Respostas malformadas ou inesperadas do RPC
// ---------------------------------------------------------------------------

test("a log the RPC marks as removed is treated as a reorg", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  registered(chain);
  chain.patchLast({ removed: true });
  chain.head = 200n;
  await rejectsWith(syncChain(options(url, chain)), "CHAIN_REORG");
  assert.deepEqual(await counts(await connect(t, url)), NOTHING);
});

test("a pending log without block hash is invalid", { skip }, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  registered(chain);
  chain.patchLast({ blockHash: null });
  chain.head = 200n;
  await rejectsWith(syncChain(options(url, chain)), "INVALID_LOG");
});

test("a block returned without hash aborts the batch", { skip }, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  registered(chain);
  chain.hashless.add(102n);
  chain.head = 200n;
  await assert.rejects(syncChain(options(url, chain)), /Bloco 102 sem hash/);
  assert.deepEqual(await counts(await connect(t, url)), NOTHING);
});

test("the same log returned twice in one response is applied once", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  registered(chain);
  created(chain, 103, 1n, 30_000n);
  settled(chain, 104, 1n, 30_000n);
  chain.duplicateLast();
  chain.head = 104n + 12n;
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  assert.equal((await limitOf(db, BORROWER))?.available_limit_cents, "70000");
  assert.deepEqual(await counts(db), {
    cursor: "104",
    events: "5",
    history: "2",
    offers: "1",
    settlements: "1",
  });
});

for (const call of ["getChainId", "getBlockNumber", "getLogs"] as const) {
  test(`a failing ${call} leaves no open connection and no partial write`, {
    skip,
  }, async (t) => {
    const url = await isolatedDatabase(t);
    const chain = new FakeChain();
    happyPath(chain);
    chain.failing.add(call);
    for (let attempt = 0; attempt < 5; attempt++)
      await assert.rejects(syncChain(options(url, chain)), /failed/);
    const db = await connect(t, url);
    assert.deepEqual(await counts(db), NOTHING);
    const open = await db.query(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = 'chain-sync'",
    );
    assert.equal(open.rows[0]?.n, "0");

    chain.failing.delete(call);
    assert.equal(await syncAll(options(url, chain)), 6);
  });
}

test("an unreachable database fails fast without leaking its credentials", {
  skip,
}, async () => {
  assert.ok(DATABASE_URL);
  const url = new URL(DATABASE_URL);
  url.port = "1"; // nada escuta aqui
  url.password = "senha-que-nao-pode-vazar";
  const chain = new FakeChain();
  happyPath(chain);
  const started = Date.now();
  const error = await syncChain(options(url.toString(), chain)).then(
    () => assert.fail("deveria falhar"),
    (failure: unknown) => failure,
  );
  assert.ok(Date.now() - started < 15_000);
  const message = safeChainErrorMessage(error, [url.toString()]);
  assert.doesNotMatch(message, /senha-que-nao-pode-vazar/);
  assert.ok(message.length > 0);
});

// ---------------------------------------------------------------------------
// Valores e regras de negócio
// ---------------------------------------------------------------------------

test("uint256 amounts beyond 2^53 are stored and debited exactly", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  const limit = 2n ** 200n + 7n;
  const amount = 2n ** 199n + 3n;
  registered(chain, limit);
  created(chain, 103, 1n, amount);
  settled(chain, 104, 1n, amount);
  chain.head = 104n + 12n;
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  assert.equal(
    (await limitOf(db, BORROWER))?.available_limit_cents,
    (limit - amount).toString(),
  );
  const offer = await db.query("SELECT amount_cents FROM offers");
  assert.equal(offer.rows[0]?.amount_cents, amount.toString());
});

test("several settlements of one borrower chain the limit history", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  registered(chain);
  created(chain, 103, 1n, 30_000n);
  created(chain, 104, 2n, 20_000n);
  settled(chain, 105, 1n, 30_000n);
  settled(chain, 106, 2n, 20_000n);
  chain.head = 106n + 12n;
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  const { rows } = await db.query(
    "SELECT change_kind, previous_limit_cents, new_limit_cents FROM credit_limit_history ORDER BY block_timestamp",
  );
  assert.deepEqual(rows, [
    {
      change_kind: "admin_update",
      new_limit_cents: "100000",
      previous_limit_cents: "0",
    },
    {
      change_kind: "settlement",
      new_limit_cents: "70000",
      previous_limit_cents: "100000",
    },
    {
      change_kind: "settlement",
      new_limit_cents: "50000",
      previous_limit_cents: "70000",
    },
  ]);
  assert.equal((await limitOf(db, BORROWER))?.available_limit_cents, "50000");
});

test("an offer created in one batch can settle in a later one", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  registered(chain);
  created(chain, 105, 1n, 30_000n);
  settled(chain, 125, 1n, 30_000n);
  chain.head = 125n + 12n;
  const opts = options(url, chain);
  assert.equal((await syncChain(opts)).to, 109);
  await syncAll(opts);
  const db = await connect(t, url);
  const offer = await db.query("SELECT status FROM offers");
  assert.equal(offer.rows[0]?.status, 2);
});

test("revoking keeps the limit and registering again keeps it too", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  registered(chain, 50_000n);
  chain.emit(103, 3, 0, "InstitutionRevoked", {
    timestamp: 3n,
    wallet: BORROWER,
  });
  chain.head = 103n + 12n;
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  assert.deepEqual(await limitOf(db, BORROWER), {
    available_limit_cents: "50000",
    is_registered: false,
  });

  chain.emit(104, 4, 0, "InstitutionRegistered", {
    timestamp: 4n,
    wallet: BORROWER,
  });
  chain.head = 104n + 12n;
  await syncAll(options(url, chain));
  assert.deepEqual(await limitOf(db, BORROWER), {
    available_limit_cents: "50000",
    is_registered: true,
  });
});

test("an offer created for an unknown wallet is still indexed", {
  skip,
}, async (t) => {
  // O contrato exige cadastro, mas a projeção não descarta eventos de
  // carteiras que ela ainda não viu (por exemplo, cadastro antes do START).
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  created(chain, 103, 1n, 30_000n);
  chain.head = 200n;
  assert.equal(await syncAll(options(url, chain)), 1);
});

// ---------------------------------------------------------------------------
// Configuração e operação do cursor
// ---------------------------------------------------------------------------

test("a checksummed contract address maps to the same lowercase projection", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  const upper = {
    ...options(url, chain),
    contractAddress: CONTRACT.toUpperCase().replace(
      "0X",
      "0x",
    ) as `0x${string}`,
  };
  await syncAll(upper);
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  const deployments = await db.query(
    "SELECT contract_address FROM contract_deployments",
  );
  assert.deepEqual(deployments.rows, [{ contract_address: CONTRACT }]);
  assert.equal((await counts(db))?.events, "6");
});

test("zero confirmations index up to the head; too many index nothing", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  chain.head = 104n;
  const shallow = { ...options(url, chain), confirmations: 0 };
  assert.equal(await syncAll(shallow), 6);

  const other = await isolatedDatabase(t);
  const deep = { ...options(other, chain), confirmations: 1_000 };
  const result = await syncChain(deep);
  assert.equal(result.caughtUp, true);
  assert.equal(result.indexed, 0);
  assert.ok(result.safeHead < 0);
});

test("batchSize is capped at the RPC limit and smaller batches work", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  chain.head = 200n;
  const big = await syncChain({ ...options(url, chain), batchSize: 500 });
  assert.equal(big.to, 109);

  const other = await isolatedDatabase(t);
  const small = await syncChain({ ...options(other, chain), batchSize: 3 });
  assert.deepEqual([small.from, small.to], [100, 102]);
});

test("once a cursor exists, a new START_BLOCK does not rewind or skip", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  chain.head = 200n;
  await syncChain(options(url, chain, 100));
  assert.equal((await syncChain(options(url, chain, 50))).from, 110);
  assert.equal((await syncChain(options(url, chain, 180))).from, 120);
});

test("a cursor without block hash skips the reorg check", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  await syncChain(options(url, chain));
  const db = await connect(t, url);
  await db.query("UPDATE sync_cursors SET last_processed_block_hash = NULL");
  chain.reorg(104n); // o bloco do cursor mudou, mas não há hash para comparar
  chain.head += 1n;
  assert.equal(await syncAll(options(url, chain)), 0);
});

test("an idle pass refreshes last_synced_at without moving the cursor", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  await db.query(
    "UPDATE sync_cursors SET last_synced_at = now() - interval '1 hour'",
  );
  const result = await syncChain(options(url, chain));
  assert.equal(result.indexed, 0);
  const { rows } = await db.query(
    "SELECT last_processed_block, now() - last_synced_at < interval '1 minute' AS fresh FROM sync_cursors",
  );
  assert.deepEqual(rows, [{ fresh: true, last_processed_block: "104" }]);
});

test("the cursor stores the canonical hash of the last processed block", {
  skip,
}, async (t) => {
  const url = await isolatedDatabase(t);
  const chain = new FakeChain();
  happyPath(chain);
  await syncAll(options(url, chain));
  const db = await connect(t, url);
  const { rows } = await db.query(
    "SELECT last_processed_block, last_processed_block_hash FROM sync_cursors",
  );
  assert.deepEqual(rows, [
    {
      last_processed_block: "104",
      last_processed_block_hash: chain.blockHash(104n),
    },
  ]);
  // Nenhum evento de outro deployment foi gravado.
  const foreign = await db.query(
    "SELECT count(*) AS n FROM chain_events WHERE contract_address <> $1 OR tx_hash = $2",
    [CONTRACT, txHash(999)],
  );
  assert.equal(foreign.rows[0]?.n, "0");
});
