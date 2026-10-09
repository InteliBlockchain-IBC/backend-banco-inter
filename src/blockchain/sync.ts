import pg from "pg";
import { createPublicClient, http, parseEventLogs, type Address } from "viem";
import { sepolia } from "viem/chains";
import { creditInterbankOfferAbi } from "./abi.js";

export type ChainSyncOptions = Readonly<{
  brlTokenAddress: Address;
  confirmations: number;
  contractAddress: Address;
  databaseUrl: string;
  positionTokenAddress: Address;
  rpcUrl: string;
  startBlock: number;
}>;

const LOCK = 724182916;
// O plano gratuito da Alchemy para Sepolia limita eth_getLogs a 10 blocos.
// Mantenha o worker compatível com ele; em um endpoint pago, isso pode virar
// configuração, mas nunca deve exceder o limite do provedor.
const BATCH = 10n;
const address = (value: string) => value.toLowerCase();
const eventArgs = (args: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, String(value)]),
  );

/** Uma passagem idempotente; execute repetidamente em cron/worker. */
export async function syncChain(options: ChainSyncOptions) {
  const rpc = createPublicClient({
    chain: sepolia,
    transport: http(options.rpcUrl),
  });
  const db = new pg.Client({ connectionString: options.databaseUrl });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    await db.query(
      `INSERT INTO contract_deployments (chain_id,contract_address,brl_token_address,position_token_address,start_block)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (chain_id,contract_address) DO NOTHING`,
      [
        sepolia.id,
        address(options.contractAddress),
        address(options.brlTokenAddress),
        address(options.positionTokenAddress),
        options.startBlock,
      ],
    );
    const cursor = await db.query<{ last_processed_block: string }>(
      "SELECT last_processed_block FROM sync_cursors WHERE chain_id=$1 AND contract_address=$2 FOR UPDATE",
      [sepolia.id, address(options.contractAddress)],
    );
    const from = cursor.rows[0]
      ? BigInt(cursor.rows[0].last_processed_block) + 1n
      : BigInt(options.startBlock);
    const head = await rpc.getBlockNumber();
    const safeHead = head - BigInt(options.confirmations);
    if (safeHead < from) {
      await db.query("COMMIT");
      return { indexed: 0, from: null, to: null };
    }
    const to = from + BATCH - 1n > safeHead ? safeHead : from + BATCH - 1n;
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
    for (const log of events) {
      if (
        log.blockNumber === null ||
        log.logIndex === null ||
        log.transactionHash === null
      )
        throw new Error("Log RPC sem posição canônica");
      const block = await rpc.getBlock({ blockNumber: log.blockNumber });
      if (!block.hash) throw new Error("Bloco RPC sem hash");
      const args = eventArgs(log.args);
      let offerId: string | null = null;
      if (log.eventName === "OfferCreated") {
        const created = await db.query<{ id: string }>(
          `INSERT INTO offers (chain_id,contract_address,onchain_offer_id,lender_wallet,borrower_wallet,amount_cents,rate_cdi_bps,term_days,status,created_at,expires_at,create_tx_hash,created_block)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12)
           ON CONFLICT (chain_id,contract_address,onchain_offer_id) DO UPDATE SET indexed_at=now() RETURNING id`,
          [
            sepolia.id,
            address(options.contractAddress),
            args.offerId,
            address(args.lender ?? ""),
            address(args.borrower ?? ""),
            args.amount,
            args.rateCDI,
            args.term,
            new Date(Number(args.timestamp ?? block.timestamp) * 1000),
            new Date(Number(args.expiresAt) * 1000),
            log.transactionHash,
            Number(log.blockNumber),
          ],
        );
        offerId = created.rows[0]?.id ?? null;
      } else if (args.offerId) {
        const found = await db.query<{ id: string }>(
          "SELECT id FROM offers WHERE chain_id=$1 AND contract_address=$2 AND onchain_offer_id=$3",
          [sepolia.id, address(options.contractAddress), args.offerId],
        );
        offerId = found.rows[0]?.id ?? null;
      }
      await db.query(
        `INSERT INTO chain_events (chain_id,contract_address,tx_hash,log_index,offer_id,event_name,block_number,block_hash,block_timestamp,event_args)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [
          sepolia.id,
          address(options.contractAddress),
          log.transactionHash,
          Number(log.logIndex),
          offerId,
          log.eventName,
          Number(log.blockNumber),
          block.hash,
          new Date(Number(block.timestamp) * 1000),
          JSON.stringify(args),
        ],
      );
      const status: Record<string, number> = {
        OfferSettled: 2,
        OfferCancelled: 3,
        OfferExpired: 4,
        OfferRejected: 5,
      };
      if (offerId && status[log.eventName] !== undefined)
        await db.query(
          "UPDATE offers SET status=$2,indexed_at=now() WHERE id=$1",
          [offerId, status[log.eventName]],
        );
      if (log.eventName === "OfferSettled" && offerId)
        await db.query(
          `INSERT INTO settlements (offer_id,chain_id,contract_address,onchain_offer_id,position_token_id,tx_hash,block_number,block_hash,settled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (offer_id) DO NOTHING`,
          [
            offerId,
            sepolia.id,
            address(options.contractAddress),
            args.offerId,
            args.positionTokenId,
            log.transactionHash,
            Number(log.blockNumber),
            block.hash,
            new Date(Number(block.timestamp) * 1000),
          ],
        );
      if (
        [
          "InstitutionRegistered",
          "InstitutionRevoked",
          "CreditLimitUpdated",
        ].includes(log.eventName)
      ) {
        const wallet = address(args.wallet ?? args.institution ?? "");
        const registered =
          log.eventName === "InstitutionRegistered"
            ? true
            : log.eventName === "InstitutionRevoked"
              ? false
              : null;
        const limit = args.newLimit ?? "0";
        await db.query(
          `INSERT INTO contract_wallet_state (chain_id,contract_address,wallet_address,is_registered,available_limit_cents,observed_block,observed_at)
           VALUES ($1,$2,$3,COALESCE($4,false),$5,$6,$7)
           ON CONFLICT (chain_id,contract_address,wallet_address) DO UPDATE SET is_registered=COALESCE($4,contract_wallet_state.is_registered),available_limit_cents=CASE WHEN $8 THEN $5 ELSE contract_wallet_state.available_limit_cents END,observed_block=$6,observed_at=$7`,
          [
            sepolia.id,
            address(options.contractAddress),
            wallet,
            registered,
            limit,
            Number(log.blockNumber),
            new Date(Number(block.timestamp) * 1000),
            log.eventName === "CreditLimitUpdated",
          ],
        );
      }
    }
    const finalBlock = await rpc.getBlock({ blockNumber: to });
    await db.query(
      "INSERT INTO sync_cursors (chain_id,contract_address,last_processed_block,last_processed_block_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (chain_id,contract_address) DO UPDATE SET last_processed_block=$3,last_processed_block_hash=$4,last_synced_at=now()",
      [
        sepolia.id,
        address(options.contractAddress),
        to.toString(),
        finalBlock.hash,
      ],
    );
    await db.query("COMMIT");
    return { indexed: events.length, from: Number(from), to: Number(to) };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}
