import pg from "pg";
import {
  type Address,
  createPublicClient,
  type Hash,
  http,
  type PublicClient,
  parseEventLogs,
  toEventSelector,
} from "viem";
import { sepolia } from "viem/chains";
import { onchainStatusCodes } from "../domain/types.js";
import { creditInterbankOfferAbi } from "./abi.js";

/** Leituras de RPC usadas pelo listener; os testes injetam uma chain falsa. */
export type ChainReader = Pick<
  PublicClient,
  "getBlock" | "getBlockNumber" | "getChainId" | "getLogs"
>;

export type ChainSyncOptions = Readonly<{
  brlTokenAddress: Address;
  /** Blocos abaixo do head que ainda não são indexados. */
  confirmations: number;
  contractAddress: Address;
  databaseUrl: string;
  positionTokenAddress: Address;
  rpcUrl: string;
  startBlock: number;
  /** Substitui o cliente HTTP criado a partir de `rpcUrl`. */
  client?: ChainReader;
  /** Blocos por eth_getLogs; nunca acima de MAX_BLOCKS_PER_BATCH. */
  batchSize?: number;
}>;

export type ChainSyncResult = Readonly<{
  /** O cursor alcançou o head seguro: o worker pode esperar o próximo bloco. */
  caughtUp: boolean;
  from: number | null;
  indexed: number;
  safeHead: number;
  to: number | null;
}>;

export type ChainSyncErrorCode =
  | "CHAIN_MISMATCH"
  | "CHAIN_REORG"
  | "INSUFFICIENT_LIMIT"
  | "INVALID_LOG"
  | "MISSING_LIMIT"
  | "OFFER_CONFLICT"
  | "ORPHAN_OFFER_EVENT";

/**
 * Inconsistência entre a chain e a projeção. O lote inteiro é desfeito e o
 * cursor não avança: o worker para no mesmo bloco até alguém corrigir a causa,
 * em vez de gravar uma projeção incompleta.
 */
export class ChainSyncError extends Error {
  readonly code: ChainSyncErrorCode;

  constructor(code: ChainSyncErrorCode, message: string) {
    super(message);
    this.name = "ChainSyncError";
    this.code = code;
  }
}

const LOCK = 724182916;
// O plano gratuito da Alchemy para Sepolia limita eth_getLogs a 10 blocos.
// Mantenha o worker compatível com ele; em um endpoint pago, isso pode virar
// configuração, mas nunca deve exceder o limite do provedor.
export const MAX_BLOCKS_PER_BATCH = 10;

const address = (value: string) => value.toLowerCase();
const eventArgs = (args: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, String(value)]),
  );
const knownTopics = new Set(
  creditInterbankOfferAbi.map((item) => toEventSelector(item)),
);
const terminalStatus: Record<string, number> = {
  OfferSettled: onchainStatusCodes.settled,
  OfferCancelled: onchainStatusCodes.cancelled,
  OfferExpired: onchainStatusCodes.expired,
  OfferRejected: onchainStatusCodes.rejected,
};
const institutionEvents = new Set([
  "InstitutionRegistered",
  "InstitutionRevoked",
  "CreditLimitUpdated",
]);

type OfferRow = {
  amount_cents: string;
  borrower_wallet: string;
  create_tx_hash: string;
  id: string;
  lender_wallet: string;
};

/** Uma passagem idempotente; execute repetidamente em cron/worker. */
export async function syncChain(
  options: ChainSyncOptions,
): Promise<ChainSyncResult> {
  const batch = BigInt(
    Math.min(options.batchSize ?? MAX_BLOCKS_PER_BATCH, MAX_BLOCKS_PER_BATCH),
  );
  const rpc =
    options.client ??
    createPublicClient({ chain: sepolia, transport: http(options.rpcUrl) });
  const chainId = await rpc.getChainId();
  if (chainId !== sepolia.id)
    throw new ChainSyncError(
      "CHAIN_MISMATCH",
      `O RPC configurado responde chain ${chainId}; o listener indexa apenas a Sepolia (${sepolia.id}).`,
    );
  const contract = address(options.contractAddress);

  const db = new pg.Client({
    application_name: "chain-sync",
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  // Uma queda de socket faz o pg emitir 'error' fora de qualquer promise. Sem
  // listener, o Node encerra o processo antes do try/catch do worker; aqui o
  // erro é guardado e a próxima query (ou o catch abaixo) o reporta.
  let connectionError: Error | undefined;
  db.on("error", (error) => {
    connectionError = error;
  });
  await db.connect();

  const blocks = new Map<bigint, { hash: Hash; timestamp: bigint }>();
  /** Bloco canônico; com `expected`, exige que o log venha desse mesmo bloco. */
  const canonicalBlock = async (number: bigint, expected?: Hash) => {
    let block = blocks.get(number);
    if (block === undefined) {
      const fetched = await rpc.getBlock({ blockNumber: number });
      if (!fetched.hash) throw new Error(`Bloco ${number} sem hash no RPC`);
      block = { hash: fetched.hash, timestamp: fetched.timestamp };
      blocks.set(number, block);
    }
    if (expected !== undefined && address(expected) !== address(block.hash))
      throw new ChainSyncError(
        "CHAIN_REORG",
        `Reorg detectada no bloco ${number}: o log veio do bloco ${expected}, mas o bloco canônico é ${block.hash}.`,
      );
    return block;
  };

  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    await db.query(
      `INSERT INTO contract_deployments (chain_id,contract_address,brl_token_address,position_token_address,start_block,source)
       VALUES ($1,$2,$3,$4,$5,'listener')
       ON CONFLICT (chain_id,contract_address) DO UPDATE SET source='listener'`,
      [
        sepolia.id,
        contract,
        address(options.brlTokenAddress),
        address(options.positionTokenAddress),
        options.startBlock,
      ],
    );
    const cursor = await db.query<{
      last_processed_block: string;
      last_processed_block_hash: string | null;
    }>(
      `SELECT last_processed_block, last_processed_block_hash FROM sync_cursors
        WHERE chain_id=$1 AND contract_address=$2 FOR UPDATE`,
      [sepolia.id, contract],
    );
    const saved = cursor.rows[0];

    // O último bloco processado ainda precisa ser canônico. Se não for, os
    // eventos já gravados a partir dele podem não existir mais na chain.
    if (saved?.last_processed_block_hash) {
      const block = BigInt(saved.last_processed_block);
      const canonical = await canonicalBlock(block);
      if (address(canonical.hash) !== saved.last_processed_block_hash)
        throw new ChainSyncError(
          "CHAIN_REORG",
          `Reorg detectada no bloco ${block}: o cursor registrou ${saved.last_processed_block_hash}, mas o bloco canônico é ${canonical.hash}. Reindexe a partir de um bloco anterior.`,
        );
    }

    const from = saved
      ? BigInt(saved.last_processed_block) + 1n
      : BigInt(options.startBlock);
    const head = await rpc.getBlockNumber();
    const safeHead = head - BigInt(options.confirmations);
    if (safeHead < from) {
      // Nada novo: registra que o worker está vivo para /api/sync-status.
      await db.query(
        "UPDATE sync_cursors SET last_synced_at=now() WHERE chain_id=$1 AND contract_address=$2",
        [sepolia.id, contract],
      );
      await db.query("COMMIT");
      return {
        caughtUp: true,
        from: null,
        indexed: 0,
        safeHead: Number(safeHead),
        to: null,
      };
    }
    const to = from + batch - 1n > safeHead ? safeHead : from + batch - 1n;
    const logs = await rpc.getLogs({
      address: options.contractAddress,
      fromBlock: from,
      toBlock: to,
    });
    const events = parseEventLogs({
      abi: creditInterbankOfferAbi,
      logs,
      strict: true,
    });
    // Eventos do AccessControl (RoleGranted...) ficam de fora de propósito.
    // Um log com tópico da nossa ABI que não decodifica, não.
    const expected = logs.filter(
      (log) => log.topics[0] && knownTopics.has(log.topics[0]),
    ).length;
    if (expected !== events.length)
      throw new ChainSyncError(
        "INVALID_LOG",
        `${expected - events.length} log(s) do contrato entre os blocos ${from} e ${to} não correspondem à ABI.`,
      );

    for (const log of events) {
      if (
        log.blockNumber === null ||
        log.blockHash === null ||
        log.logIndex === null ||
        log.transactionHash === null
      )
        throw new ChainSyncError("INVALID_LOG", "Log RPC sem posição canônica");
      // O RPC marca como `removed` um log cujo bloco saiu da chain canônica.
      if (log.removed)
        throw new ChainSyncError(
          "CHAIN_REORG",
          `Log removido pelo RPC (reorg) na tx ${log.transactionHash}, bloco ${log.blockNumber}.`,
        );
      const block = await canonicalBlock(log.blockNumber, log.blockHash);
      const blockTime = new Date(Number(block.timestamp) * 1000);
      const where = `tx ${log.transactionHash}, bloco ${log.blockNumber}, log ${log.logIndex}`;
      const args = eventArgs(log.args);

      let offer: OfferRow | undefined;
      if (log.eventName === "OfferCreated") {
        const created = await db.query<OfferRow>(
          `INSERT INTO offers (chain_id,contract_address,onchain_offer_id,lender_wallet,borrower_wallet,amount_cents,rate_cdi_bps,term_days,status,created_at,expires_at,create_tx_hash,created_block)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (chain_id,contract_address,onchain_offer_id) DO UPDATE SET indexed_at=now()
           RETURNING id, create_tx_hash, lender_wallet, borrower_wallet, amount_cents::text`,
          [
            sepolia.id,
            contract,
            args.offerId,
            address(args.lender ?? ""),
            address(args.borrower ?? ""),
            args.amount,
            args.rateCDI,
            args.term,
            onchainStatusCodes.offered,
            blockTime,
            new Date(Number(args.expiresAt) * 1000),
            address(log.transactionHash),
            Number(log.blockNumber),
          ],
        );
        offer = created.rows[0];
        // Mesmo id on-chain com outro hash de criação: a linha veio do seed ou
        // da simulação, não deste contrato. Não mistura as duas origens.
        if (offer && offer.create_tx_hash !== address(log.transactionHash))
          throw new ChainSyncError(
            "OFFER_CONFLICT",
            `A oferta on-chain ${args.offerId} já existe no banco com outro hash de criação (${where}).`,
          );
      } else if (args.offerId !== undefined) {
        const found = await db.query<OfferRow>(
          `SELECT id, create_tx_hash, lender_wallet, borrower_wallet, amount_cents::text
             FROM offers WHERE chain_id=$1 AND contract_address=$2 AND onchain_offer_id=$3`,
          [sepolia.id, contract, args.offerId],
        );
        offer = found.rows[0];
        if (offer === undefined)
          throw new ChainSyncError(
            "ORPHAN_OFFER_EVENT",
            `${log.eventName} da oferta ${args.offerId} sem OfferCreated indexado (${where}). Verifique se CREDIT_INTERBANK_OFFER_START_BLOCK é anterior à criação da oferta.`,
          );
      }

      const persistedEvent = await db.query(
        `INSERT INTO chain_events (chain_id,contract_address,tx_hash,log_index,offer_id,event_name,block_number,block_hash,block_timestamp,event_args)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING
         RETURNING 1`,
        [
          sepolia.id,
          contract,
          address(log.transactionHash),
          Number(log.logIndex),
          offer?.id ?? null,
          log.eventName,
          Number(log.blockNumber),
          address(log.blockHash),
          blockTime,
          JSON.stringify(args),
        ],
      );
      // Cursor e eventos são gravados na mesma transação, mas manter esse
      // guarda torna a liquidação segura até em uma reexecução manual.
      if (persistedEvent.rowCount === 0) continue;

      const status = terminalStatus[log.eventName];
      if (offer && status !== undefined)
        await db.query(
          "UPDATE offers SET status=$2,indexed_at=now() WHERE id=$1",
          [offer.id, status],
        );

      if (log.eventName === "OfferSettled" && offer) {
        const borrower = address(args.borrower ?? "");
        if (
          args.amount !== offer.amount_cents ||
          borrower !== offer.borrower_wallet ||
          address(args.lender ?? "") !== offer.lender_wallet
        )
          throw new ChainSyncError(
            "OFFER_CONFLICT",
            `OfferSettled da oferta ${args.offerId} diverge da OfferCreated indexada (valor ou contrapartes) (${where}).`,
          );
        await db.query(
          `INSERT INTO settlements (offer_id,chain_id,contract_address,onchain_offer_id,position_token_id,tx_hash,block_number,block_hash,settled_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (offer_id) DO NOTHING`,
          [
            offer.id,
            sepolia.id,
            contract,
            args.offerId,
            args.positionTokenId,
            address(log.transactionHash),
            Number(log.blockNumber),
            address(log.blockHash),
            blockTime,
          ],
        );
        // O contrato debita o limite no aceite sem emitir CreditLimitUpdated:
        // a projeção repete o débito com o valor exato da oferta.
        const state = await db.query<{ available_limit_cents: string }>(
          `SELECT available_limit_cents::text FROM contract_wallet_state
            WHERE chain_id=$1 AND contract_address=$2 AND wallet_address=$3 FOR UPDATE`,
          [sepolia.id, contract, borrower],
        );
        const available = state.rows[0]?.available_limit_cents;
        if (available === undefined)
          throw new ChainSyncError(
            "MISSING_LIMIT",
            `OfferSettled da oferta ${args.offerId}: o tomador ${borrower} não tem limite registrado na projeção (${where}).`,
          );
        const previous = BigInt(available);
        const amount = BigInt(offer.amount_cents);
        if (previous < amount)
          throw new ChainSyncError(
            "INSUFFICIENT_LIMIT",
            `OfferSettled da oferta ${args.offerId}: a projeção tem ${previous} centavos de limite para ${borrower} e a oferta debita ${amount} (${where}).`,
          );
        const next = previous - amount;
        await db.query(
          `UPDATE contract_wallet_state
              SET available_limit_cents=$4, observed_block=$5, observed_at=$6
            WHERE chain_id=$1 AND contract_address=$2 AND wallet_address=$3`,
          [
            sepolia.id,
            contract,
            borrower,
            next.toString(),
            Number(log.blockNumber),
            blockTime,
          ],
        );
        await db.query(
          `INSERT INTO credit_limit_history (chain_id,contract_address,tx_hash,log_index,wallet_address,change_kind,previous_limit_cents,new_limit_cents,offer_id,block_timestamp)
           VALUES ($1,$2,$3,$4,$5,'settlement',$6,$7,$8,$9)`,
          [
            sepolia.id,
            contract,
            address(log.transactionHash),
            Number(log.logIndex),
            borrower,
            previous.toString(),
            next.toString(),
            offer.id,
            blockTime,
          ],
        );
      }

      if (institutionEvents.has(log.eventName)) {
        const wallet = address(args.wallet ?? args.institution ?? "");
        const registered =
          log.eventName === "InstitutionRegistered"
            ? true
            : log.eventName === "InstitutionRevoked"
              ? false
              : null;
        const limitUpdate = log.eventName === "CreditLimitUpdated";
        await db.query(
          `INSERT INTO contract_wallet_state (chain_id,contract_address,wallet_address,is_registered,available_limit_cents,observed_block,observed_at)
           VALUES ($1,$2,$3,COALESCE($4,false),$5,$6,$7)
           ON CONFLICT (chain_id,contract_address,wallet_address) DO UPDATE SET is_registered=COALESCE($4,contract_wallet_state.is_registered),available_limit_cents=CASE WHEN $8 THEN $5 ELSE contract_wallet_state.available_limit_cents END,observed_block=$6,observed_at=$7`,
          [
            sepolia.id,
            contract,
            wallet,
            registered,
            args.newLimit ?? "0",
            Number(log.blockNumber),
            blockTime,
            limitUpdate,
          ],
        );
        if (limitUpdate)
          await db.query(
            `INSERT INTO credit_limit_history (chain_id,contract_address,tx_hash,log_index,wallet_address,change_kind,previous_limit_cents,new_limit_cents,offer_id,block_timestamp)
             VALUES ($1,$2,$3,$4,$5,'admin_update',$6,$7,NULL,$8)`,
            [
              sepolia.id,
              contract,
              address(log.transactionHash),
              Number(log.logIndex),
              wallet,
              args.previousLimit,
              args.newLimit,
              blockTime,
            ],
          );
      }
    }

    const finalBlock = await canonicalBlock(to);
    await db.query(
      `INSERT INTO sync_cursors (chain_id,contract_address,last_processed_block,last_processed_block_hash)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (chain_id,contract_address) DO UPDATE SET last_processed_block=$3,last_processed_block_hash=$4,last_synced_at=now()`,
      [sepolia.id, contract, to.toString(), address(finalBlock.hash)],
    );
    await db.query("COMMIT");
    return {
      caughtUp: to === safeHead,
      from: Number(from),
      indexed: events.length,
      safeHead: Number(safeHead),
      to: Number(to),
    };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    if (connectionError !== undefined)
      throw new Error(
        `Conexão com o PostgreSQL perdida: ${connectionError.message}`,
        { cause: error },
      );
    throw error;
  } finally {
    await db.end().catch(() => undefined);
  }
}
