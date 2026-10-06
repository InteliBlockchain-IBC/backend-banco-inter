import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  type Address,
  type ChainEventName,
  type ChainEventRecord,
  type CreditLimitChangeRecord,
  type Deployment,
  type Hash,
  type OfferRecord,
  type OnchainStatusCode,
  onchainStatusCodes,
  type SettlementRecord,
  type TransactionAction,
  type TransactionRequestRecord,
  type TransactionStatus,
  UINT256_MAX,
  type WalletState,
} from "../../domain/types.js";
import {
  actionEventArgs,
  actionOutcome,
  blockTime,
  offerCreatedArgs,
  offerExpiry,
  offerSettledArgs,
  parseAmount,
  parseCounterparties,
  requireActionable,
  requireLimit,
  requireRegisteredWallet,
  type SimulatedAction,
  type SimulatedOfferInput,
  syntheticHash,
} from "../../domain/rules.js";
import { problems } from "../../http/errors.js";
import {
  type CreditLimitFilter,
  type Repository,
  type OfferFilter,
  type OfferIntentInput,
  type OfferView,
  type Page,
  REQUEST_TTL_MS,
  type SimulationResult,
} from "../repository.js";
import {
  creditLimitChangeView,
  creditLimitView,
  deploymentView,
  eventView,
  liveRequestStatus,
  offerView,
  operationView,
  type Party,
  party,
  requestView,
  syncStatusView,
  type ViewContext,
} from "../../domain/views.js";

/**
 * Fonte de dados PostgreSQL. Lê e grava a projeção de `migrations/` para o
 * deployment ativo (o registro mais recente de `contract_deployments`).
 *
 * - Valores uint256 (`numeric(78,0)`) chegam do driver como string e viram
 *   `bigint`; colunas `bigint` de bloco viram `number`.
 * - O relógio é injetado (`now`) e passado como parâmetro, nunca `now()` do
 *   banco, para os testes controlarem vencimentos.
 * - Toda escrita roda em transação. Simulações e intenções de ação usam um
 *   advisory lock por transação, porque número de bloco, id on-chain e a
 *   checagem de intenção em andamento dependem de ler-e-depois-escrever.
 */

const SIMULATION_LOCK = 724182914;
const UNIQUE_VIOLATION = "23505";

type Queryable = Pick<pg.PoolClient, "query">;

type DeploymentRow = {
  brl_token_address: string;
  chain_id: string;
  contract_address: string;
  position_token_address: string;
  start_block: string;
};

type OfferRow = {
  amount_cents: string;
  borrower_wallet: string;
  create_tx_hash: string;
  created_at: Date;
  created_block: string;
  expires_at: Date;
  id: string;
  lender_wallet: string;
  onchain_offer_id: string;
  rate_cdi_bps: string;
  status: number;
  term_days: string;
};

type SettlementColumns = {
  s_block_hash: string | null;
  s_block_number: string | null;
  s_position_token_id: string | null;
  s_settled_at: Date | null;
  s_tx_hash: string | null;
};

type WalletRow = {
  available_limit_cents: string;
  institution_id: string | null;
  institution_name: string | null;
  is_registered: boolean;
  observed_at: Date;
  observed_block: string | null;
  wallet_address: string;
};

type EventRow = {
  block_hash: string;
  block_number: string;
  block_timestamp: Date;
  event_args: Record<string, string>;
  event_name: ChainEventName;
  log_index: string;
  offer_id: string | null;
  tx_hash: string;
};

type HistoryRow = {
  block_timestamp: Date;
  change_kind: "admin_update" | "settlement";
  log_index: string;
  new_limit_cents: string;
  offer_id: string | null;
  previous_limit_cents: string;
  tx_hash: string;
  wallet_address: string;
};

type RequestRow = {
  action: TransactionAction;
  amount_cents: string | null;
  borrower_wallet: string | null;
  created_at: Date;
  expires_at: Date;
  failure_code: string | null;
  id: string;
  offer_id: string | null;
  offer_onchain_id: string | null;
  rate_cdi_bps: string | null;
  requester_wallet: string;
  status: TransactionStatus;
  submitted_at: Date | null;
  term_days: string | null;
  tx_hash: string | null;
  validity_seconds: string | null;
};

const lower = (address: string): Address => address.toLowerCase() as Address;
const toNumber = (value: string | null): number | null =>
  value === null ? null : Number(value);

// ---------------------------------------------------------------------------
// Linhas -> registros de domínio
// ---------------------------------------------------------------------------

function toDeployment(row: DeploymentRow): Deployment {
  return {
    brlTokenAddress: row.brl_token_address as Address,
    chainId: Number(row.chain_id),
    contractAddress: row.contract_address as Address,
    positionTokenAddress: row.position_token_address as Address,
    startBlock: Number(row.start_block),
  };
}

function toOffer(row: OfferRow): OfferRecord {
  return {
    amountCents: BigInt(row.amount_cents),
    borrower: row.borrower_wallet as Address,
    createTxHash: row.create_tx_hash as Hash,
    createdAt: row.created_at,
    createdBlock: Number(row.created_block),
    expiresAt: row.expires_at,
    id: row.id,
    lender: row.lender_wallet as Address,
    onchainOfferId: BigInt(row.onchain_offer_id),
    onchainStatus: row.status as OnchainStatusCode,
    rateCdiBps: Number(row.rate_cdi_bps),
    termDays: Number(row.term_days),
  };
}

function toSettlement(
  offerId: string,
  row: SettlementColumns,
): SettlementRecord | undefined {
  if (
    row.s_tx_hash === null ||
    row.s_block_hash === null ||
    row.s_block_number === null ||
    row.s_position_token_id === null ||
    row.s_settled_at === null
  ) {
    return undefined;
  }
  return {
    blockHash: row.s_block_hash as Hash,
    blockNumber: Number(row.s_block_number),
    offerId,
    positionTokenId: BigInt(row.s_position_token_id),
    settledAt: row.s_settled_at,
    txHash: row.s_tx_hash as Hash,
  };
}

function toWallet(row: WalletRow): WalletState {
  return {
    availableLimitCents: BigInt(row.available_limit_cents),
    institutionId: row.institution_id,
    isRegistered: row.is_registered,
    observedAt: row.observed_at,
    observedBlock: Number(row.observed_block ?? 0),
    wallet: row.wallet_address as Address,
  };
}

function toParty(row: WalletRow): Party {
  return party(
    row.wallet_address as Address,
    row.institution_id === null || row.institution_name === null
      ? null
      : { id: row.institution_id, name: row.institution_name },
  );
}

function toEvent(row: EventRow): ChainEventRecord {
  return {
    args: row.event_args,
    blockHash: row.block_hash as Hash,
    blockNumber: Number(row.block_number),
    blockTimestamp: row.block_timestamp,
    eventName: row.event_name,
    logIndex: Number(row.log_index),
    offerId: row.offer_id,
    txHash: row.tx_hash as Hash,
  };
}

function toHistory(row: HistoryRow): CreditLimitChangeRecord {
  return {
    blockTimestamp: row.block_timestamp,
    changeKind: row.change_kind,
    logIndex: Number(row.log_index),
    newLimitCents: BigInt(row.new_limit_cents),
    offerId: row.offer_id,
    previousLimitCents: BigInt(row.previous_limit_cents),
    txHash: row.tx_hash as Hash,
    wallet: row.wallet_address as Address,
  };
}

function toRequest(row: RequestRow): TransactionRequestRecord {
  return {
    action: row.action,
    amountCents: row.amount_cents === null ? null : BigInt(row.amount_cents),
    borrowerWallet: row.borrower_wallet as Address | null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    failureCode: row.failure_code,
    id: row.id,
    offerId: row.offer_id,
    rateCdiBps: toNumber(row.rate_cdi_bps),
    requesterWallet: row.requester_wallet as Address,
    status: row.status,
    submittedAt: row.submitted_at,
    termDays: toNumber(row.term_days),
    txHash: row.tx_hash as Hash | null,
    validitySeconds: toNumber(row.validity_seconds),
  };
}

// ---------------------------------------------------------------------------
// SQL compartilhado
// ---------------------------------------------------------------------------

const OFFER_COLUMNS = `
  o.id, o.onchain_offer_id, o.lender_wallet, o.borrower_wallet, o.amount_cents,
  o.rate_cdi_bps, o.term_days, o.status, o.created_at, o.expires_at,
  o.create_tx_hash, o.created_block,
  s.tx_hash AS s_tx_hash, s.block_number AS s_block_number,
  s.block_hash AS s_block_hash, s.settled_at AS s_settled_at,
  s.position_token_id AS s_position_token_id`;

const WALLET_COLUMNS = `
  w.wallet_address, iw.institution_id, i.name AS institution_name,
  w.is_registered, w.available_limit_cents, w.observed_block, w.observed_at`;

const REQUEST_COLUMNS = `
  r.id, r.action, r.status, r.requester_wallet, r.offer_id, r.borrower_wallet,
  r.amount_cents, r.rate_cdi_bps, r.term_days, r.validity_seconds, r.tx_hash,
  r.created_at, r.expires_at, r.submitted_at, r.failure_code,
  o.onchain_offer_id AS offer_onchain_id`;

/** Monta `WHERE` parametrizado sem concatenar valores no SQL. */
class Where {
  readonly params: unknown[];
  readonly #clauses: string[] = [];

  constructor(deployment: Deployment, alias: string) {
    this.params = [deployment.chainId, deployment.contractAddress];
    this.#clauses.push(
      `${alias}.chain_id = $1`,
      `${alias}.contract_address = $2`,
    );
  }

  /** Recebe o SQL com `?` no lugar de cada valor, na ordem de `values`. */
  add(sql: string, ...values: unknown[]): this {
    let text = sql;
    for (const value of values) {
      this.params.push(value);
      text = text.replace("?", `$${this.params.length}`);
    }
    this.#clauses.push(text);
    return this;
  }

  next(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  toString(): string {
    return `WHERE ${this.#clauses.join(" AND ")}`;
  }
}

export type PgRepositoryOptions = {
  now?: () => Date;
  newId?: () => string;
};

export class PgRepository implements Repository {
  readonly source = "postgres" as const;
  readonly #pool: pg.Pool;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(pool: pg.Pool, options: PgRepositoryOptions = {}) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  static fromUrl(connectionString: string, options: PgRepositoryOptions = {}) {
    return new PgRepository(
      new pg.Pool({
        connectionString,
        // Uma requisição presa não deve segurar o pool inteiro.
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 10,
        statement_timeout: 10_000,
      }),
      options,
    );
  }

  async check(): Promise<void> {
    try {
      await this.#pool.query("SELECT 1");
    } catch {
      throw problems.databaseUnavailable();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  // -------------------------------------------------------------------
  // Rede
  // -------------------------------------------------------------------

  async deployment() {
    return deploymentView(await this.#deployment(this.#pool));
  }

  async syncStatus() {
    const d = await this.#deployment(this.#pool);
    const { rows } = await this.#pool.query<{
      last_processed_block: string;
      last_processed_block_hash: string | null;
      last_synced_at: Date;
    }>(
      `SELECT last_processed_block, last_processed_block_hash, last_synced_at
         FROM sync_cursors WHERE chain_id = $1 AND contract_address = $2`,
      [d.chainId, d.contractAddress],
    );
    const row = rows[0];
    // Sem cursor, o listener nunca rodou: começa no bloco de deploy.
    const cursor = {
      lastProcessedBlock:
        row === undefined ? d.startBlock : Number(row.last_processed_block),
      lastProcessedBlockHash: (row?.last_processed_block_hash ??
        `0x${"0".repeat(64)}`) as Hash,
      lastSyncedAt: row?.last_synced_at ?? new Date(0),
    };
    return syncStatusView(d, cursor, this.#now());
  }

  // -------------------------------------------------------------------
  // Ofertas
  // -------------------------------------------------------------------

  async listOffers(filter: OfferFilter, page: Page) {
    const d = await this.#deployment(this.#pool);
    const now = this.#now();
    const where = new Where(d, "o");
    switch (filter.status) {
      case undefined:
        break;
      case "offered":
        where.add("o.status = 0 AND o.expires_at > ?", now);
        break;
      case "expired":
        where.add(
          "(o.status = 4 OR (o.status = 0 AND o.expires_at <= ?))",
          now,
        );
        break;
      default:
        where.add("o.status = ?", onchainStatusCodes[filter.status]);
    }
    if (filter.wallet !== undefined) {
      const wallet = lower(filter.wallet);
      const role = filter.role ?? "any";
      if (role === "lender") where.add("o.lender_wallet = ?", wallet);
      else if (role === "borrower") where.add("o.borrower_wallet = ?", wallet);
      else
        where.add(
          "(o.lender_wallet = ? OR o.borrower_wallet = ?)",
          wallet,
          wallet,
        );
    }
    const countSql = `SELECT count(*) AS total FROM offers o ${where}`;
    const countParams = [...where.params];
    const listSql = `SELECT ${OFFER_COLUMNS}
           FROM offers o LEFT JOIN settlements s ON s.offer_id = o.id
           ${where}
          ORDER BY o.created_at DESC, o.onchain_offer_id DESC
          LIMIT ${where.next(page.limit)} OFFSET ${where.next(page.offset)}`;
    const [count, result] = await Promise.all([
      this.#pool.query<{ total: string }>(countSql, countParams),
      this.#pool.query<OfferRow & SettlementColumns>(listSql, where.params),
    ]);
    const ctx = await this.#context(this.#pool, d, result.rows);
    return {
      items: result.rows.map((row) =>
        offerView(ctx, toOffer(row), toSettlement(row.id, row)),
      ),
      limit: page.limit,
      offset: page.offset,
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async getOffer(id: string) {
    const d = await this.#deployment(this.#pool);
    return this.#offerView(this.#pool, d, id);
  }

  async offerEvents(id: string) {
    const d = await this.#deployment(this.#pool);
    const offer = await this.#offerRow(this.#pool, d, id);
    const { rows } = await this.#pool.query<EventRow>(
      `SELECT tx_hash, log_index, offer_id, event_name, block_number,
              block_hash, block_timestamp, event_args
         FROM chain_events
        WHERE chain_id = $1 AND contract_address = $2 AND offer_id = $3
        ORDER BY block_number, log_index`,
      [d.chainId, d.contractAddress, offer.id],
    );
    return rows.map((row) => eventView(toEvent(row)));
  }

  // -------------------------------------------------------------------
  // Operações liquidadas
  // -------------------------------------------------------------------

  async listOperations(filter: { wallet?: string }, page: Page) {
    const d = await this.#deployment(this.#pool);
    const where = new Where(d, "s");
    if (filter.wallet !== undefined) {
      const wallet = lower(filter.wallet);
      where.add(
        "(o.lender_wallet = ? OR o.borrower_wallet = ?)",
        wallet,
        wallet,
      );
    }
    const from = "FROM settlements s JOIN offers o ON o.id = s.offer_id";
    const countSql = `SELECT count(*) AS total ${from} ${where}`;
    const countParams = [...where.params];
    const listSql = `SELECT ${OFFER_COLUMNS} ${from} ${where}
          ORDER BY s.settled_at DESC, s.tx_hash
          LIMIT ${where.next(page.limit)} OFFSET ${where.next(page.offset)}`;
    const [count, result] = await Promise.all([
      this.#pool.query<{ total: string }>(countSql, countParams),
      this.#pool.query<OfferRow & SettlementColumns>(listSql, where.params),
    ]);
    const ctx = await this.#context(this.#pool, d, result.rows);
    return {
      items: result.rows.map((row) => {
        const settlement = toSettlement(row.id, row);
        if (settlement === undefined) throw new Error("liquidação sem dados");
        return operationView(ctx, toOffer(row), settlement);
      }),
      limit: page.limit,
      offset: page.offset,
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async getOperation(txHash: string) {
    const d = await this.#deployment(this.#pool);
    const { rows } = await this.#pool.query<OfferRow & SettlementColumns>(
      `SELECT ${OFFER_COLUMNS}
         FROM settlements s JOIN offers o ON o.id = s.offer_id
        WHERE s.chain_id = $1 AND s.contract_address = $2 AND s.tx_hash = $3`,
      [d.chainId, d.contractAddress, txHash.toLowerCase()],
    );
    const row = rows[0];
    const settlement = row && toSettlement(row.id, row);
    if (row === undefined || settlement === undefined)
      throw problems.notFound("A operação");
    const ctx = await this.#context(this.#pool, d, rows);
    return operationView(ctx, toOffer(row), settlement);
  }

  // -------------------------------------------------------------------
  // Limites
  // -------------------------------------------------------------------

  async listCreditLimits(filter: CreditLimitFilter) {
    const d = await this.#deployment(this.#pool);
    const where = new Where(d, "w");
    if (filter.registered !== undefined)
      where.add("w.is_registered = ?", filter.registered);
    if (filter.minAvailableCents !== undefined)
      where.add(
        "w.available_limit_cents >= ?::numeric",
        filter.minAvailableCents,
      );
    if (filter.excludeWallet !== undefined)
      where.add("w.wallet_address <> ?", lower(filter.excludeWallet));
    const { rows } = await this.#pool.query<WalletRow>(
      `SELECT ${WALLET_COLUMNS}
         FROM contract_wallet_state w
         LEFT JOIN institution_wallets iw ON iw.wallet_address = w.wallet_address
         LEFT JOIN institutions i ON i.id = iw.institution_id
         ${where}
        ORDER BY w.available_limit_cents DESC, w.wallet_address`,
      where.params,
    );
    return rows.map((row) => creditLimitView(toWallet(row), toParty(row)));
  }

  async getCreditLimit(wallet: string) {
    const d = await this.#deployment(this.#pool);
    const row = await this.#walletRow(this.#pool, d, wallet);
    if (row === undefined) throw problems.notFound("A carteira");
    return creditLimitView(toWallet(row), toParty(row));
  }

  async creditLimitHistory(wallet: string) {
    const d = await this.#deployment(this.#pool);
    const row = await this.#walletRow(this.#pool, d, wallet);
    if (row === undefined) throw problems.notFound("A carteira");
    const { rows } = await this.#pool.query<HistoryRow>(
      `SELECT tx_hash, log_index, wallet_address, change_kind,
              previous_limit_cents, new_limit_cents, offer_id, block_timestamp
         FROM credit_limit_history
        WHERE chain_id = $1 AND contract_address = $2 AND wallet_address = $3
        ORDER BY block_timestamp DESC, tx_hash, log_index`,
      [d.chainId, d.contractAddress, row.wallet_address],
    );
    return rows.map((item) => creditLimitChangeView(toHistory(item)));
  }

  // -------------------------------------------------------------------
  // Intenções
  // -------------------------------------------------------------------

  async getTransactionRequest(id: string) {
    const d = await this.#deployment(this.#pool);
    return requestView(
      { deployment: d, now: this.#now() },
      ...(await this.#requestRow(this.#pool, d, id)),
    );
  }

  async createOfferIntent(requesterWallet: string, input: OfferIntentInput) {
    return this.#transaction(async (client) => {
      const d = await this.#deployment(client);
      const requester = await this.#walletRow(client, d, requesterWallet);
      if (requester === undefined || !requester.is_registered)
        throw problems.notRegistered("requester");
      const borrowerAddress = lower(input.borrowerWallet);
      if (borrowerAddress === requester.wallet_address)
        throw problems.invalidCounterparty();
      const borrower = await this.#walletRow(client, d, borrowerAddress);
      if (borrower === undefined || !borrower.is_registered)
        throw problems.notRegistered("counterparty");
      const amount = BigInt(input.amountCents);
      if (amount > UINT256_MAX) throw problems.invalidAmount();
      const available = BigInt(borrower.available_limit_cents);
      if (available < amount)
        throw problems.insufficientLimit(available, amount);
      return this.#insertRequest(client, d, {
        action: "create_offer",
        amountCents: amount,
        borrowerWallet: borrowerAddress,
        offerId: null,
        rateCdiBps: input.rateCdiBps,
        requesterWallet: requester.wallet_address as Address,
        termDays: input.termDays,
        validitySeconds: input.validitySeconds,
      });
    });
  }

  async offerActionIntent(
    action: Exclude<TransactionAction, "create_offer">,
    requesterWallet: string,
    offerId: string,
  ) {
    return this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SIMULATION_LOCK]);
      const d = await this.#deployment(client);
      const offer = toOffer(await this.#offerRow(client, d, offerId));
      const now = this.#now();
      requireActionable(offer, now);

      const requester = lower(requesterWallet);
      if (action === "cancel_offer" && requester !== offer.lender)
        throw problems.forbiddenNotLender();
      if (action !== "cancel_offer" && requester !== offer.borrower)
        throw problems.forbiddenNotBorrower();
      // Como no contrato: só o aceite exige as duas carteiras ainda cadastradas.
      if (action === "accept_offer") {
        const self = await this.#walletRow(client, d, requester);
        if (self === undefined || !self.is_registered)
          throw problems.notRegistered("requester");
        const lender = await this.#walletRow(client, d, offer.lender);
        if (lender === undefined || !lender.is_registered)
          throw problems.notRegistered("counterparty");
        const available = BigInt(self.available_limit_cents);
        if (available < offer.amountCents)
          throw problems.insufficientLimit(available, offer.amountCents);
      }

      const { rows: open } = await client.query<{ id: string }>(
        `SELECT id FROM transaction_requests
          WHERE offer_id = $1 AND action = $2
            AND (status = 'submitted' OR (status = 'pending' AND expires_at > $3))
          ORDER BY created_at LIMIT 1`,
        [offer.id, action, now],
      );
      if (open[0] !== undefined) throw problems.requestInProgress(open[0].id);

      return this.#insertRequest(client, d, {
        action,
        amountCents: null,
        borrowerWallet: null,
        offerId: offer.id,
        rateCdiBps: null,
        requesterWallet: requester,
        termDays: null,
        validitySeconds: null,
      });
    });
  }

  async submitTransaction(
    requestId: string,
    requesterWallet: string,
    txHash: string,
  ) {
    return this.#transaction(async (client) => {
      const d = await this.#deployment(client);
      const [request] = await this.#requestRow(client, d, requestId, true);
      if (lower(requesterWallet) !== request.requesterWallet)
        throw problems.forbiddenNotRequester();
      const now = this.#now();
      const status = liveRequestStatus(request, now);
      if (status === "expired") throw problems.requestExpired();
      if (status !== "pending") throw problems.invalidRequestStatus(status);
      const hash = txHash.toLowerCase() as Hash;
      try {
        await client.query(
          `UPDATE transaction_requests
              SET status = 'submitted', tx_hash = $2, submitted_at = $3
            WHERE id = $1`,
          [request.id, hash, now],
        );
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION)
          throw problems.duplicateTransaction(hash);
        throw error;
      }
      return requestView(
        { deployment: d, now },
        ...(await this.#requestRow(client, d, request.id)),
      );
    });
  }

  // -------------------------------------------------------------------
  // Simulação persistida (development/test)
  // -------------------------------------------------------------------

  async createSimulatedOffer(
    input: SimulatedOfferInput,
  ): Promise<SimulationResult> {
    return this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SIMULATION_LOCK]);
      const d = await this.#deployment(client);
      const { borrower, lender } = parseCounterparties(input);
      const lenderRow = await this.#walletRow(client, d, lender);
      requireRegisteredWallet(lenderRow && toWallet(lenderRow));
      const borrowerRow = await this.#walletRow(client, d, borrower);
      const borrowerState = requireRegisteredWallet(
        borrowerRow && toWallet(borrowerRow),
      );
      const amount = parseAmount(input.amountCents);
      requireLimit(borrowerState, amount);
      const at = blockTime(this.#now());
      const expiry = offerExpiry(at, input.validitySeconds);

      const { rows } = await client.query<{ next_id: string }>(
        `SELECT COALESCE(max(onchain_offer_id), 0) + 1 AS next_id
           FROM offers WHERE chain_id = $1 AND contract_address = $2`,
        [d.chainId, d.contractAddress],
      );
      const id = this.#newId();
      const txHash = syntheticHash(`${id}:create`);
      const mined = await this.#nextBlock(client, d);
      const offer: OfferRecord = {
        amountCents: amount,
        borrower,
        createTxHash: txHash,
        createdAt: at,
        createdBlock: mined.blockNumber,
        expiresAt: expiry.expiresAt,
        id,
        lender,
        onchainOfferId: BigInt(rows[0]?.next_id ?? 1),
        onchainStatus: onchainStatusCodes.offered,
        rateCdiBps: input.rateCdiBps,
        termDays: input.termDays,
      };
      await client.query(
        `INSERT INTO offers (id, chain_id, contract_address, onchain_offer_id,
           lender_wallet, borrower_wallet, amount_cents, rate_cdi_bps, term_days,
           status, created_at, expires_at, create_tx_hash, created_block, indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $11)`,
        [
          offer.id,
          d.chainId,
          d.contractAddress,
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
      await this.#insertEvent(client, d, {
        args: offerCreatedArgs(offer, expiry.unix),
        blockHash: mined.blockHash,
        blockNumber: mined.blockNumber,
        blockTimestamp: at,
        eventName: "OfferCreated",
        logIndex: 0,
        offerId: offer.id,
        txHash,
      });
      await this.#advanceCursor(client, d, mined, at);
      return {
        offer: await this.#offerView(client, d, offer.id),
        operation: null,
      };
    });
  }

  async simulatedOfferAction(
    id: string,
    action: SimulatedAction,
  ): Promise<SimulationResult> {
    return this.#transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SIMULATION_LOCK]);
      const d = await this.#deployment(client);
      const original = toOffer(await this.#offerRow(client, d, id, true));
      requireActionable(original, this.#now());

      let borrowerState: WalletState | undefined;
      if (action === "accept") {
        const borrowerRow = await this.#walletRow(
          client,
          d,
          original.borrower,
          true,
        );
        borrowerState = requireRegisteredWallet(
          borrowerRow && toWallet(borrowerRow),
        );
        const lenderRow = await this.#walletRow(client, d, original.lender);
        requireRegisteredWallet(lenderRow && toWallet(lenderRow));
        requireLimit(borrowerState, original.amountCents);
      }

      const at = blockTime(this.#now());
      const txHash = syntheticHash(`${original.id}:${action}`);
      const mined = await this.#nextBlock(client, d);
      const outcome = actionOutcome(action);
      const event = (
        eventName: ChainEventName,
        logIndex: number,
        args: Record<string, string>,
      ): ChainEventRecord => ({
        args,
        blockHash: mined.blockHash,
        blockNumber: mined.blockNumber,
        blockTimestamp: at,
        eventName,
        logIndex,
        offerId: original.id,
        txHash,
      });

      await client.query(
        "UPDATE offers SET status = $2, indexed_at = $3 WHERE id = $1",
        [original.id, onchainStatusCodes[outcome.status], at],
      );
      await this.#insertEvent(
        client,
        d,
        event(outcome.eventName, 0, actionEventArgs(original, action, at)),
      );

      if (borrowerState !== undefined) {
        await this.#insertEvent(
          client,
          d,
          event("OfferSettled", 1, offerSettledArgs(original, at)),
        );
        await client.query(
          `INSERT INTO settlements (offer_id, chain_id, contract_address,
             onchain_offer_id, position_token_id, tx_hash, block_number,
             block_hash, settled_at)
           VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8)`,
          [
            original.id,
            d.chainId,
            d.contractAddress,
            original.onchainOfferId.toString(),
            txHash,
            mined.blockNumber,
            mined.blockHash,
            at,
          ],
        );
        const previous = borrowerState.availableLimitCents;
        const next = previous - original.amountCents;
        await client.query(
          `UPDATE contract_wallet_state
              SET available_limit_cents = $4, observed_block = $5, observed_at = $6
            WHERE chain_id = $1 AND contract_address = $2 AND wallet_address = $3`,
          [
            d.chainId,
            d.contractAddress,
            original.borrower,
            next.toString(),
            mined.blockNumber,
            at,
          ],
        );
        await client.query(
          `INSERT INTO credit_limit_history (chain_id, contract_address, tx_hash,
             log_index, wallet_address, change_kind, previous_limit_cents,
             new_limit_cents, offer_id, block_timestamp)
           VALUES ($1, $2, $3, 1, $4, 'settlement', $5, $6, $7, $8)`,
          [
            d.chainId,
            d.contractAddress,
            txHash,
            original.borrower,
            previous.toString(),
            next.toString(),
            original.id,
            at,
          ],
        );
      }
      await this.#advanceCursor(client, d, mined, at);

      const offer = await this.#offerView(client, d, original.id);
      return {
        offer,
        operation:
          borrowerState === undefined
            ? null
            : await this.#operationByOffer(client, d, original.id),
      };
    });
  }

  // -------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------

  async #transaction<T>(
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #deployment(db: Queryable): Promise<Deployment> {
    const { rows } = await db.query<DeploymentRow>(
      `SELECT chain_id, contract_address, brl_token_address,
              position_token_address, start_block
         FROM contract_deployments
        ORDER BY created_at DESC, chain_id, contract_address
        LIMIT 1`,
    );
    if (rows[0] === undefined) throw problems.deploymentNotConfigured();
    return toDeployment(rows[0]);
  }

  /** Resolve instituição de todas as carteiras citadas nas linhas, numa consulta. */
  async #context(
    db: Queryable,
    d: Deployment,
    rows: Array<{ borrower_wallet: string; lender_wallet: string }>,
  ): Promise<ViewContext> {
    const addresses = [
      ...new Set(
        rows.flatMap((row) => [row.lender_wallet, row.borrower_wallet]),
      ),
    ];
    const parties = new Map<string, Party>();
    if (addresses.length > 0) {
      // O vínculo com o banco independe do deployment: lê institution_wallets.
      const { rows: owners } = await db.query<{
        institution_id: string;
        institution_name: string;
        wallet_address: string;
      }>(
        `SELECT iw.wallet_address, iw.institution_id, i.name AS institution_name
           FROM institution_wallets iw
           JOIN institutions i ON i.id = iw.institution_id
          WHERE iw.wallet_address = ANY($1)`,
        [addresses],
      );
      for (const row of owners) {
        parties.set(
          row.wallet_address,
          party(row.wallet_address as Address, {
            id: row.institution_id,
            name: row.institution_name,
          }),
        );
      }
    }
    return {
      deployment: d,
      now: this.#now(),
      party: (address) => parties.get(address) ?? party(address, null),
    };
  }

  async #offerRow(
    db: Queryable,
    d: Deployment,
    id: string,
    forUpdate = false,
  ): Promise<OfferRow & SettlementColumns> {
    const { rows } = await db.query<OfferRow & SettlementColumns>(
      `SELECT ${OFFER_COLUMNS}
         FROM offers o LEFT JOIN settlements s ON s.offer_id = o.id
        WHERE o.chain_id = $1 AND o.contract_address = $2 AND o.id = $3
        ${forUpdate ? "FOR UPDATE OF o" : ""}`,
      [d.chainId, d.contractAddress, id.toLowerCase()],
    );
    if (rows[0] === undefined) throw problems.notFound("A oferta");
    return rows[0];
  }

  async #offerView(
    db: Queryable,
    d: Deployment,
    id: string,
  ): Promise<OfferView> {
    const row = await this.#offerRow(db, d, id);
    const ctx = await this.#context(db, d, [row]);
    return offerView(ctx, toOffer(row), toSettlement(row.id, row));
  }

  async #operationByOffer(db: Queryable, d: Deployment, offerId: string) {
    const row = await this.#offerRow(db, d, offerId);
    const settlement = toSettlement(row.id, row);
    if (settlement === undefined) return null;
    const ctx = await this.#context(db, d, [row]);
    return operationView(ctx, toOffer(row), settlement);
  }

  async #walletRow(
    db: Queryable,
    d: Deployment,
    wallet: string,
    forUpdate = false,
  ): Promise<WalletRow | undefined> {
    const { rows } = await db.query<WalletRow>(
      `SELECT ${WALLET_COLUMNS}
         FROM contract_wallet_state w
         LEFT JOIN institution_wallets iw ON iw.wallet_address = w.wallet_address
         LEFT JOIN institutions i ON i.id = iw.institution_id
        WHERE w.chain_id = $1 AND w.contract_address = $2 AND w.wallet_address = $3
        ${forUpdate ? "FOR UPDATE OF w" : ""}`,
      [d.chainId, d.contractAddress, lower(wallet)],
    );
    return rows[0];
  }

  async #requestRow(
    db: Queryable,
    d: Deployment,
    id: string,
    forUpdate = false,
  ): Promise<[TransactionRequestRecord, bigint | undefined]> {
    const { rows } = await db.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS}
         FROM transaction_requests r
         LEFT JOIN offers o ON o.id = r.offer_id
        WHERE r.chain_id = $1 AND r.contract_address = $2 AND r.id = $3
        ${forUpdate ? "FOR UPDATE OF r" : ""}`,
      [d.chainId, d.contractAddress, id.toLowerCase()],
    );
    const row = rows[0];
    if (row === undefined) throw problems.notFound("A intenção");
    return [
      toRequest(row),
      row.offer_onchain_id === null ? undefined : BigInt(row.offer_onchain_id),
    ];
  }

  async #insertRequest(
    client: pg.PoolClient,
    d: Deployment,
    input: Omit<
      TransactionRequestRecord,
      | "createdAt"
      | "expiresAt"
      | "failureCode"
      | "id"
      | "status"
      | "submittedAt"
      | "txHash"
    >,
  ) {
    const createdAt = this.#now();
    const id = this.#newId();
    await client.query(
      `INSERT INTO transaction_requests (id, chain_id, contract_address, action,
         status, requester_wallet, offer_id, borrower_wallet, amount_cents,
         rate_cdi_bps, term_days, validity_seconds, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        d.chainId,
        d.contractAddress,
        input.action,
        input.requesterWallet,
        input.offerId,
        input.borrowerWallet,
        input.amountCents?.toString() ?? null,
        input.rateCdiBps,
        input.termDays,
        input.validitySeconds,
        createdAt,
        new Date(createdAt.getTime() + REQUEST_TTL_MS),
      ],
    );
    return requestView(
      { deployment: d, now: this.#now() },
      ...(await this.#requestRow(client, d, id)),
    );
  }

  async #insertEvent(
    client: pg.PoolClient,
    d: Deployment,
    event: ChainEventRecord,
  ) {
    await client.query(
      `INSERT INTO chain_events (chain_id, contract_address, tx_hash, log_index,
         offer_id, event_name, block_number, block_hash, block_timestamp,
         event_args, indexed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9)`,
      [
        d.chainId,
        d.contractAddress,
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

  /** Próximo bloco sintético: depois do cursor e de qualquer evento gravado. */
  async #nextBlock(
    client: pg.PoolClient,
    d: Deployment,
  ): Promise<{ blockHash: Hash; blockNumber: number }> {
    const { rows } = await client.query<{ head: string }>(
      `SELECT GREATEST(
          (SELECT max(block_number) FROM chain_events
            WHERE chain_id = $1 AND contract_address = $2),
          (SELECT last_processed_block FROM sync_cursors
            WHERE chain_id = $1 AND contract_address = $2),
          $3::bigint) AS head`,
      [d.chainId, d.contractAddress, d.startBlock],
    );
    const blockNumber = Number(rows[0]?.head ?? d.startBlock) + 1;
    return { blockHash: syntheticHash(`block:${blockNumber}`), blockNumber };
  }

  async #advanceCursor(
    client: pg.PoolClient,
    d: Deployment,
    mined: { blockHash: Hash; blockNumber: number },
    at: Date,
  ) {
    await client.query(
      `INSERT INTO sync_cursors (chain_id, contract_address, last_processed_block,
         last_processed_block_hash, last_synced_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chain_id, contract_address) DO UPDATE
         SET last_processed_block = EXCLUDED.last_processed_block,
             last_processed_block_hash = EXCLUDED.last_processed_block_hash,
             last_synced_at = EXCLUDED.last_synced_at`,
      [d.chainId, d.contractAddress, mined.blockNumber, mined.blockHash, at],
    );
  }
}
