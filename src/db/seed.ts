import pg from "pg";
import { createFixtures } from "../mock/fixtures.js";

/**
 * Popula o banco com a massa de demonstração de `src/mock/fixtures.ts`: as
 * mesmas instituições, carteiras, ofertas, eventos, liquidações e histórico
 * de limite que a API em memória serve. Os horários são relativos a `now`,
 * então logo após o seed sempre há ofertas abertas.
 *
 * - `if-empty` (padrão): só grava se ainda não existir deployment. Seguro para
 *   rodar a cada `docker compose up`.
 * - `reset`: apaga os dados da projeção (não o esquema) e grava de novo, com
 *   horários renovados. Útil antes de uma demonstração.
 */
export type SeedMode = "if-empty" | "reset";
export type SeedResult = { seeded: boolean; offers: number };

const DATA_TABLES = [
  "transaction_requests",
  "credit_limit_history",
  "settlements",
  "chain_events",
  "sync_cursors",
  "offers",
  "contract_wallet_state",
  "contract_deployments",
  "institutions",
];

/** Trava distinta da migration: seed e migration não disputam a mesma chave. */
const SEED_LOCK = 724182915;

export async function seedDemo(
  connectionString: string,
  options: { mode?: SeedMode; now?: Date } = {},
): Promise<SeedResult> {
  const mode = options.mode ?? "if-empty";
  const data = createFixtures(options.now ?? new Date());
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [SEED_LOCK]);
    if (mode === "reset") {
      await client.query(`TRUNCATE ${DATA_TABLES.join(", ")}`);
    } else {
      const { rows } = await client.query(
        "SELECT 1 FROM contract_deployments LIMIT 1",
      );
      if (rows.length > 0) {
        await client.query("ROLLBACK");
        return { offers: 0, seeded: false };
      }
    }

    const d = data.deployment;
    const scope = [d.chainId, d.contractAddress] as const;
    await client.query(
      `INSERT INTO contract_deployments (chain_id, contract_address,
         brl_token_address, position_token_address, start_block)
       VALUES ($1, $2, $3, $4, $5)`,
      [...scope, d.brlTokenAddress, d.positionTokenAddress, d.startBlock],
    );

    for (const institution of data.institutions) {
      await client.query(
        "INSERT INTO institutions (id, name) VALUES ($1, $2)",
        [institution.id, institution.name],
      );
    }

    for (const wallet of data.wallets) {
      await client.query(
        `INSERT INTO contract_wallet_state (chain_id, contract_address,
           wallet_address, institution_id, is_registered, available_limit_cents,
           observed_block, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ...scope,
          wallet.wallet,
          wallet.institutionId,
          wallet.isRegistered,
          wallet.availableLimitCents.toString(),
          wallet.observedBlock,
          wallet.observedAt,
        ],
      );
    }

    for (const offer of data.offers) {
      await client.query(
        `INSERT INTO offers (id, chain_id, contract_address, onchain_offer_id,
           lender_wallet, borrower_wallet, amount_cents, rate_cdi_bps, term_days,
           status, created_at, expires_at, create_tx_hash, created_block,
           indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $11)`,
        [
          offer.id,
          ...scope,
          offer.onchainOfferId.toString(),
          offer.lender,
          offer.borrower,
          offer.amountCents.toString(),
          offer.rateCdiBps,
          offer.termDays,
          offer.onchainStatus,
          offer.createdAt,
          offer.expiresAt,
          offer.createTxHash,
          offer.createdBlock,
        ],
      );
    }

    for (const event of data.chainEvents) {
      await client.query(
        `INSERT INTO chain_events (chain_id, contract_address, tx_hash,
           log_index, offer_id, event_name, block_number, block_hash,
           block_timestamp, event_args, indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9)`,
        [
          ...scope,
          event.txHash,
          event.logIndex,
          event.offerId,
          event.eventName,
          event.blockNumber,
          event.blockHash,
          event.blockTimestamp,
          JSON.stringify(event.args),
        ],
      );
    }

    for (const change of data.creditLimitChanges) {
      await client.query(
        `INSERT INTO credit_limit_history (chain_id, contract_address, tx_hash,
           log_index, wallet_address, change_kind, previous_limit_cents,
           new_limit_cents, offer_id, block_timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          ...scope,
          change.txHash,
          change.logIndex,
          change.wallet,
          change.changeKind,
          change.previousLimitCents.toString(),
          change.newLimitCents.toString(),
          change.offerId,
          change.blockTimestamp,
        ],
      );
    }

    const onchainIds = new Map(
      data.offers.map((offer) => [offer.id, offer.onchainOfferId]),
    );
    for (const settlement of data.settlements) {
      await client.query(
        `INSERT INTO settlements (offer_id, chain_id, contract_address,
           onchain_offer_id, position_token_id, tx_hash, block_number,
           block_hash, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          settlement.offerId,
          ...scope,
          onchainIds.get(settlement.offerId)?.toString(),
          settlement.positionTokenId.toString(),
          settlement.txHash,
          settlement.blockNumber,
          settlement.blockHash,
          settlement.settledAt,
        ],
      );
    }

    const cursor = data.syncCursor;
    await client.query(
      `INSERT INTO sync_cursors (chain_id, contract_address,
         last_processed_block, last_processed_block_hash, last_synced_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ...scope,
        cursor.lastProcessedBlock,
        cursor.lastProcessedBlockHash,
        cursor.lastSyncedAt,
      ],
    );

    await client.query("COMMIT");
    return { offers: data.offers.length, seeded: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
