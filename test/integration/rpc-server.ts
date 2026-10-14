import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { TestContext } from "node:test";
import { type Hex, toHex } from "viem";
import type { ChainSyncOptions } from "../../src/blockchain/sync.js";
import {
  BRL,
  CONTRACT,
  type FakeChain,
  POSITION,
} from "../db/chain-support.js";

type RpcRequest = Readonly<{
  id: number;
  jsonrpc: "2.0";
  method: string;
  params?: readonly unknown[];
}>;
type BeforeRequest = (method: string) => Promise<void>;
const ZERO_HASH = `0x${"00".repeat(32)}`;

function quantity(value: unknown): bigint {
  assert.equal(typeof value, "string");
  assert.match(value as string, /^0x(?:0|[1-9a-f][0-9a-f]*)$/);
  return BigInt(value as string);
}

async function blockResponse(chain: FakeChain, value: unknown) {
  const blockNumber = quantity(value);
  const block = await chain.client().getBlock({ blockNumber });
  return {
    baseFeePerGas: "0x0",
    difficulty: "0x0",
    extraData: "0x",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    hash: block.hash,
    logsBloom: `0x${"00".repeat(256)}`,
    miner: "0x0000000000000000000000000000000000000000",
    mixHash: ZERO_HASH,
    nonce: "0x0000000000000000",
    number: toHex(blockNumber),
    parentHash: chain.blockHash(blockNumber - 1n),
    receiptsRoot: ZERO_HASH,
    sha3Uncles: ZERO_HASH,
    size: "0x0",
    stateRoot: ZERO_HASH,
    timestamp: toHex(block.timestamp),
    totalDifficulty: "0x0",
    transactions: [],
    transactionsRoot: ZERO_HASH,
    uncles: [],
  };
}

async function logsResponse(chain: FakeChain, value: unknown) {
  assert.ok(value !== null && typeof value === "object");
  const filter = value as { address?: unknown; fromBlock?: Hex; toBlock?: Hex };
  assert.equal(filter.address, CONTRACT, "o listener deve filtrar o contrato");
  const logs = await chain.client().getLogs({
    address: CONTRACT,
    fromBlock: quantity(filter.fromBlock),
    toBlock: quantity(filter.toBlock),
  });
  return logs.map((log) => ({
    ...log,
    blockNumber: log.blockNumber === null ? null : toHex(log.blockNumber),
    logIndex: log.logIndex === null ? null : toHex(log.logIndex),
    transactionIndex:
      log.transactionIndex === null ? null : toHex(log.transactionIndex),
  }));
}

async function result(chain: FakeChain, request: RpcRequest) {
  switch (request.method) {
    case "eth_chainId":
      return toHex(await chain.client().getChainId());
    case "eth_blockNumber":
      return toHex(await chain.client().getBlockNumber());
    case "eth_getBlockByNumber":
      assert.equal(request.params?.[1], false);
      return blockResponse(chain, request.params?.[0]);
    case "eth_getLogs":
      return logsResponse(chain, request.params?.[0]);
    default:
      throw new Error(`Método RPC inesperado: ${request.method}`);
  }
}

async function reply(
  chain: FakeChain,
  beforeRequest: BeforeRequest | undefined,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
) {
  let id: number | null = null;
  try {
    assert.equal(incoming.method, "POST");
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString()) as RpcRequest;
    assert.equal(request.jsonrpc, "2.0");
    assert.equal(typeof request.id, "number");
    assert.equal(typeof request.method, "string");
    assert.ok(request.params === undefined || Array.isArray(request.params));
    id = request.id;
    await beforeRequest?.(request.method);
    const value = await result(chain, request);
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ id, jsonrpc: "2.0", result: value }));
  } catch (error) {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(
      JSON.stringify({
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
        id,
        jsonrpc: "2.0",
      }),
    );
  }
}

/** Só o provedor é fictício; syncChain cria seu cliente viem HTTP normalmente. */
export async function startRpc(
  t: TestContext,
  chain: FakeChain,
  beforeRequest?: BeforeRequest,
): Promise<string> {
  const server = createServer((incoming, outgoing) => {
    void reply(chain, beforeRequest, incoming, outgoing);
  });
  t.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

export async function rpcOptions(
  t: TestContext,
  databaseUrl: string,
  chain: FakeChain,
  beforeRequest?: BeforeRequest,
): Promise<ChainSyncOptions> {
  const rpcUrl = await startRpc(t, chain, beforeRequest);
  return {
    brlTokenAddress: BRL,
    confirmations: 12,
    contractAddress: CONTRACT,
    databaseUrl,
    positionTokenAddress: POSITION,
    rpcUrl,
    startBlock: 100,
  };
}
