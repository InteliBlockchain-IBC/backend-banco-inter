import type { OfferStatus, TransactionAction } from "./domain.js";
import type { SimulatedOfferInput } from "./mock/simulate.js";
import type {
  creditLimitChangeView,
  creditLimitView,
  deploymentView,
  eventView,
  offerView,
  operationView,
  requestView,
  syncStatusView,
} from "./views.js";

/**
 * Contrato entre as rotas e a fonte de dados. `MockStore` (memória, usado nos
 * testes HTTP e em development sem banco) e `PgStore` (PostgreSQL) implementam
 * a mesma interface e devolvem os mesmos payloads (`src/views.ts`).
 */

export type DataSource = "mock" | "postgres";
export type Awaitable<T> = T | Promise<T>;

/** Validade de uma intenção até o frontend informar o hash assinado. */
export const REQUEST_TTL_MS = 15 * 60_000;

export type Page = { limit: number; offset: number };
export type Paged<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export type OfferFilter = {
  role?: "lender" | "borrower" | "any";
  status?: OfferStatus;
  wallet?: string;
};

export type CreditLimitFilter = {
  excludeWallet?: string;
  minAvailableCents?: string;
  registered?: boolean;
};

export type OfferIntentInput = {
  amountCents: string;
  borrowerWallet: string;
  rateCdiBps: number;
  termDays: number;
  validitySeconds: number;
};

export type DeploymentView = ReturnType<typeof deploymentView>;
export type SyncStatusView = ReturnType<typeof syncStatusView>;
export type OfferView = ReturnType<typeof offerView>;
export type OperationView = ReturnType<typeof operationView>;
export type EventView = ReturnType<typeof eventView>;
export type CreditLimitView = ReturnType<typeof creditLimitView>;
export type CreditLimitChangeView = ReturnType<typeof creditLimitChangeView>;
export type TransactionRequestView = ReturnType<typeof requestView>;
export type SimulationResult = {
  offer: OfferView;
  operation: OperationView | null;
};

export interface DataStore {
  /** Vai para `x-data-source` e `meta.source` de toda resposta 2xx. */
  readonly source: DataSource;

  deployment(): Awaitable<DeploymentView>;
  syncStatus(): Awaitable<SyncStatusView>;

  listOffers(filter: OfferFilter, page: Page): Awaitable<Paged<OfferView>>;
  getOffer(id: string): Awaitable<OfferView>;
  offerEvents(id: string): Awaitable<EventView[]>;

  listOperations(
    filter: { wallet?: string },
    page: Page,
  ): Awaitable<Paged<OperationView>>;
  getOperation(txHash: string): Awaitable<OperationView>;

  listCreditLimits(filter: CreditLimitFilter): Awaitable<CreditLimitView[]>;
  getCreditLimit(wallet: string): Awaitable<CreditLimitView>;
  creditLimitHistory(wallet: string): Awaitable<CreditLimitChangeView[]>;

  getTransactionRequest(id: string): Awaitable<TransactionRequestView>;
  createOfferIntent(
    requesterWallet: string,
    input: OfferIntentInput,
  ): Awaitable<TransactionRequestView>;
  offerActionIntent(
    action: Exclude<TransactionAction, "create_offer">,
    requesterWallet: string,
    offerId: string,
  ): Awaitable<TransactionRequestView>;
  submitTransaction(
    requestId: string,
    requesterWallet: string,
    txHash: string,
  ): Awaitable<TransactionRequestView>;

  createSimulatedOffer(input: SimulatedOfferInput): Awaitable<SimulationResult>;
  simulatedOfferAction(
    id: string,
    action: "accept" | "reject" | "cancel",
  ): Awaitable<SimulationResult>;

  /** Readiness: lança se a dependência não responde. */
  check(): Promise<void>;
  close(): Promise<void>;
}
