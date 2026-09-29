/**
 * Tipos de domínio da PoC, espelhando `migrations/001_initial_schema.sql` e o
 * contrato `CreditInterbankOffer` (branch `develop` do repositório de contratos).
 *
 * Unidades:
 * - valores e limites: centavos de BRLt (`bigint` internamente, string decimal no JSON);
 * - taxa: pontos-base do CDI (`10000` = 100% do CDI);
 * - prazo do empréstimo: dias; validade da oferta: segundos.
 */

export type Address = `0x${string}`;
export type Hash = `0x${string}`;

export const SEPOLIA_CHAIN_ID = 11155111;

export const offerStatuses = [
  "offered",
  "settled",
  "cancelled",
  "expired",
  "rejected",
] as const;
export type OfferStatus = (typeof offerStatuses)[number];

/** Códigos estáveis do enum `OfferStatus` do contrato (1 = Accepted nunca persiste). */
export const onchainStatusCodes = {
  offered: 0,
  settled: 2,
  cancelled: 3,
  expired: 4,
  rejected: 5,
} as const satisfies Record<OfferStatus, number>;
export type OnchainStatusCode = (typeof onchainStatusCodes)[OfferStatus];

export const transactionActions = [
  "create_offer",
  "accept_offer",
  "reject_offer",
  "cancel_offer",
] as const;
export type TransactionAction = (typeof transactionActions)[number];

export const transactionStatuses = [
  "pending",
  "submitted",
  "confirmed",
  "failed",
  "expired",
] as const;
export type TransactionStatus = (typeof transactionStatuses)[number];

export const chainEventNames = [
  "InstitutionRegistered",
  "InstitutionRevoked",
  "CreditLimitUpdated",
  "OfferCreated",
  "OfferAccepted",
  "OfferSettled",
  "OfferRejected",
  "OfferCancelled",
  "OfferExpired",
] as const;
export type ChainEventName = (typeof chainEventNames)[number];

export type Institution = Readonly<{ id: string; name: string }>;

export type Deployment = Readonly<{
  brlTokenAddress: Address;
  chainId: number;
  contractAddress: Address;
  positionTokenAddress: Address;
  startBlock: number;
}>;

export type WalletState = {
  availableLimitCents: bigint;
  institutionId: string | null;
  isRegistered: boolean;
  observedAt: Date;
  observedBlock: number;
  wallet: Address;
};

export type OfferRecord = {
  amountCents: bigint;
  borrower: Address;
  createTxHash: Hash;
  createdAt: Date;
  createdBlock: number;
  expiresAt: Date;
  id: string;
  lender: Address;
  onchainOfferId: bigint;
  onchainStatus: OnchainStatusCode;
  rateCdiBps: number;
  termDays: number;
};

export type SettlementRecord = Readonly<{
  blockHash: Hash;
  blockNumber: number;
  offerId: string;
  positionTokenId: bigint;
  settledAt: Date;
  txHash: Hash;
}>;

export type ChainEventRecord = Readonly<{
  args: Readonly<Record<string, string>>;
  blockHash: Hash;
  blockNumber: number;
  blockTimestamp: Date;
  eventName: ChainEventName;
  logIndex: number;
  offerId: string | null;
  txHash: Hash;
}>;

export type CreditLimitChangeRecord = Readonly<{
  blockTimestamp: Date;
  changeKind: "admin_update" | "settlement";
  logIndex: number;
  newLimitCents: bigint;
  offerId: string | null;
  previousLimitCents: bigint;
  txHash: Hash;
  wallet: Address;
}>;

export type TransactionRequestRecord = {
  action: TransactionAction;
  amountCents: bigint | null;
  borrowerWallet: Address | null;
  createdAt: Date;
  expiresAt: Date;
  failureCode: string | null;
  id: string;
  offerId: string | null;
  rateCdiBps: number | null;
  requesterWallet: Address;
  status: TransactionStatus;
  submittedAt: Date | null;
  termDays: number | null;
  txHash: Hash | null;
  validitySeconds: number | null;
};

export type SyncCursor = Readonly<{
  lastProcessedBlock: number;
  lastProcessedBlockHash: Hash;
  lastSyncedAt: Date;
}>;

/** Estado apresentado: `offered` vencida aparece como `expired` mesmo sem `OfferExpired`. */
export function effectiveStatus(offer: OfferRecord, now: Date): OfferStatus {
  const persisted = (Object.keys(onchainStatusCodes) as OfferStatus[]).find(
    (status) => onchainStatusCodes[status] === offer.onchainStatus,
  );
  if (persisted === undefined) {
    throw new Error(`código de status desconhecido: ${offer.onchainStatus}`);
  }
  if (persisted === "offered" && offer.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return persisted;
}
