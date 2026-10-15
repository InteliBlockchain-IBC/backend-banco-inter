import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { TestContext } from "node:test";
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
import { creditInterbankOfferAbi } from "../../src/blockchain/abi.js";
import {
  type ChainReader,
  ChainSyncError,
  type ChainSyncOptions,
  syncChain,
} from "../../src/blockchain/sync.js";
import { migrate } from "../../src/database/migrate.js";

/**
 * Apoio aos testes do listener. Integração real: PostgreSQL de TEST_DATABASE_URL (um schema
 * descartável por teste) e uma chain Sepolia falsa que entrega logs
 * codificados com a ABI do contrato, como o eth_getLogs faria.
 */

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const skip =
  DATABASE_URL === undefined ? "TEST_DATABASE_URL is required" : undefined;

export const CONTRACT = "0x00000000000000000000000000000000000000c1" as Address;
export const BRL = "0x00000000000000000000000000000000000000b1" as Address;
export const POSITION = "0x00000000000000000000000000000000000000d1" as Address;
export const LENDER = "0x1111111111111111111111111111111111111111" as Address;
export const BORROWER = "0x2222222222222222222222222222222222222222" as Address;
export const SEPOLIA = 11155111;
export const GENESIS_TIME = 1_790_000_000n;
export const LOCK = 724182916;

export type EventName = (typeof creditInterbankOfferAbi)[number]["name"];

export const txHash = (n: number): Hash =>
  `0x${n.toString(16).padStart(64, "a")}` as Hash;

/** Chain em memória com head, reorgs e falhas sob controle do teste. */
export class FakeChain {
  chainId = SEPOLIA;
  head = 0n;
  failBlock: bigint | undefined;
  /** Blocos que o RPC devolve sem hash (resposta malformada). */
  readonly hashless = new Set<bigint>();
  /** Falha nas chamadas indicadas, com uma URL secreta na mensagem. */
  readonly failing = new Set<"getBlockNumber" | "getChainId" | "getLogs">();
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

  /** Altera o último log emitido (logs pendentes, removidos...). */
  patchLast(patch: Record<string, unknown>) {
    const last = this.#logs.at(-1);
    assert.ok(last);
    Object.assign(last, patch);
  }

  /** O RPC devolve o último log duas vezes na mesma resposta. */
  duplicateLast() {
    const last = this.#logs.at(-1);
    assert.ok(last);
    this.#logs.push({ ...last });
  }

  #fail(call: "getBlockNumber" | "getChainId" | "getLogs") {
    if (this.failing.has(call))
      throw new Error(
        `${call} failed. URL: https://rpc.example.invalid/v2/chave-secreta-de-teste`,
      );
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
          hash: this.hashless.has(blockNumber)
            ? null
            : this.blockHash(blockNumber),
          timestamp: GENESIS_TIME + blockNumber * 12n,
        };
      },
      getBlockNumber: async () => {
        this.#fail("getBlockNumber");
        return this.head;
      },
      getChainId: async () => {
        this.#fail("getChainId");
        return this.chainId;
      },
      getLogs: async ({
        fromBlock,
        toBlock,
      }: {
        fromBlock: bigint;
        toBlock: bigint;
      }) => {
        assert.ok(toBlock - fromBlock + 1n <= 10n, "intervalo acima do RPC");
        assert.ok(toBlock <= this.head);
        this.#fail("getLogs");
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

export async function isolatedDatabase(t: TestContext): Promise<string> {
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

export async function connect(t: TestContext, url: string) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  t.after(() => db.end());
  return db;
}

export function options(
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

export async function syncAll(opts: ChainSyncOptions) {
  let indexed = 0;
  for (let pass = 0; pass < 100; pass++) {
    const result = await syncChain(opts);
    indexed += result.indexed;
    if (result.caughtUp) return indexed;
  }
  throw new Error("o listener não alcançou o head");
}

/** Cadastro, limite de 1.000,00, oferta de 300,00 e aceite liquidado. */
export function happyPath(
  chain: FakeChain,
  expiresAt = GENESIS_TIME + 103n * 12n + 3600n,
) {
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
    expiresAt,
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

export async function counts(db: pg.Client) {
  const { rows } = await db.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM chain_events) AS events,
            (SELECT count(*) FROM settlements) AS settlements,
            (SELECT count(*) FROM credit_limit_history) AS history,
            (SELECT count(*) FROM offers) AS offers,
            (SELECT max(last_processed_block) FROM sync_cursors) AS cursor`,
  );
  return rows[0];
}

export async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ChainSyncError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}
