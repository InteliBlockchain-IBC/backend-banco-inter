import {
  type Address,
  type ChainEventRecord,
  type CreditLimitChangeRecord,
  type Deployment,
  effectiveStatus,
  type Institution,
  type OfferRecord,
  type SettlementRecord,
  type SyncCursor,
  type TransactionAction,
  type TransactionRequestRecord,
  type TransactionStatus,
  type WalletState,
} from "./domain.js";

/**
 * Montagem do payload público. O store em memória e o PostgreSQL produzem os
 * mesmos registros de domínio e passam por aqui, então o JSON é idêntico nas
 * duas fontes de dados.
 */

export const EXPLORER = "https://sepolia.etherscan.io";
/** Acima disso sem sincronizar, a API sinaliza o listener como atrasado. */
export const SYNC_STALE_AFTER_SECONDS = 60;

const iso = (date: Date): string => date.toISOString();

export type Party = {
  institution: { id: string; name: string } | null;
  wallet: Address;
};

/** Contexto comum: o deployment ativo, o relógio e a resolução de partes. */
export type ViewContext = Readonly<{
  deployment: Deployment;
  now: Date;
  party: (address: Address) => Party;
}>;

export function party(
  address: Address,
  institution: Institution | null | undefined,
): Party {
  return {
    institution:
      institution === null || institution === undefined
        ? null
        : { id: institution.id, name: institution.name },
    wallet: address,
  };
}

export function deploymentView(d: Deployment) {
  return {
    brlTokenAddress: d.brlTokenAddress,
    chainId: d.chainId,
    contractAddress: d.contractAddress,
    explorerUrl: `${EXPLORER}/address/${d.contractAddress}`,
    network: "sepolia" as const,
    positionTokenAddress: d.positionTokenAddress,
    startBlock: d.startBlock,
  };
}

export function syncStatusView(d: Deployment, cursor: SyncCursor, now: Date) {
  const lagSeconds = Math.max(
    0,
    Math.floor((now.getTime() - cursor.lastSyncedAt.getTime()) / 1000),
  );
  return {
    chainId: d.chainId,
    contractAddress: d.contractAddress,
    lagSeconds,
    lastProcessedBlock: cursor.lastProcessedBlock,
    lastProcessedBlockHash: cursor.lastProcessedBlockHash,
    lastSyncedAt: iso(cursor.lastSyncedAt),
    stale: lagSeconds > SYNC_STALE_AFTER_SECONDS,
  };
}

export function offerView(
  ctx: ViewContext,
  offer: OfferRecord,
  settlement: SettlementRecord | undefined,
) {
  return {
    amountCents: offer.amountCents.toString(),
    borrower: ctx.party(offer.borrower),
    chainId: ctx.deployment.chainId,
    contractAddress: ctx.deployment.contractAddress,
    createTxHash: offer.createTxHash,
    createdAt: iso(offer.createdAt),
    createdBlock: offer.createdBlock,
    expiresAt: iso(offer.expiresAt),
    id: offer.id,
    lender: ctx.party(offer.lender),
    onchainOfferId: offer.onchainOfferId.toString(),
    onchainStatusCode: offer.onchainStatus,
    rateCdiBps: offer.rateCdiBps,
    settlement:
      settlement === undefined
        ? null
        : {
            blockNumber: settlement.blockNumber,
            positionTokenId: settlement.positionTokenId.toString(),
            settledAt: iso(settlement.settledAt),
            txHash: settlement.txHash,
          },
    status: effectiveStatus(offer, ctx.now),
    termDays: offer.termDays,
  };
}

export function operationView(
  ctx: ViewContext,
  offer: OfferRecord,
  settlement: SettlementRecord,
) {
  return {
    amountCents: offer.amountCents.toString(),
    blockHash: settlement.blockHash,
    blockNumber: settlement.blockNumber,
    borrower: ctx.party(offer.borrower),
    chainId: ctx.deployment.chainId,
    contractAddress: ctx.deployment.contractAddress,
    explorerUrl: `${EXPLORER}/tx/${settlement.txHash}`,
    lender: ctx.party(offer.lender),
    offerId: offer.id,
    onchainOfferId: offer.onchainOfferId.toString(),
    positionTokenId: settlement.positionTokenId.toString(),
    rateCdiBps: offer.rateCdiBps,
    settledAt: iso(settlement.settledAt),
    termDays: offer.termDays,
    txHash: settlement.txHash,
  };
}

export function eventView(event: ChainEventRecord) {
  return {
    args: { ...event.args },
    blockHash: event.blockHash,
    blockNumber: event.blockNumber,
    blockTimestamp: iso(event.blockTimestamp),
    eventName: event.eventName,
    logIndex: event.logIndex,
    offerId: event.offerId,
    txHash: event.txHash,
  };
}

export function creditLimitView(state: WalletState, owner: Party) {
  return {
    availableLimitCents: state.availableLimitCents.toString(),
    institution: owner.institution,
    isRegistered: state.isRegistered,
    observedAt: iso(state.observedAt),
    observedBlock: state.observedBlock,
    wallet: state.wallet,
  };
}

export function creditLimitChangeView(change: CreditLimitChangeRecord) {
  return {
    blockTimestamp: iso(change.blockTimestamp),
    changeKind: change.changeKind,
    logIndex: change.logIndex,
    newLimitCents: change.newLimitCents.toString(),
    offerId: change.offerId,
    previousLimitCents: change.previousLimitCents.toString(),
    txHash: change.txHash,
  };
}

const functionNames: Record<TransactionAction, string> = {
  accept_offer: "acceptOffer",
  cancel_offer: "cancelOffer",
  create_offer: "createOffer",
  reject_offer: "rejectOffer",
};

/** Uma intenção `pending` vencida é apresentada como `expired` sem escrita. */
export function liveRequestStatus(
  request: TransactionRequestRecord,
  now: Date,
): TransactionStatus {
  if (
    request.status === "pending" &&
    request.expiresAt.getTime() <= now.getTime()
  ) {
    return "expired";
  }
  return request.status;
}

export function requestView(
  ctx: Omit<ViewContext, "party">,
  request: TransactionRequestRecord,
  onchainOfferId: bigint | undefined,
) {
  const args =
    request.action === "create_offer"
      ? [
          request.borrowerWallet ?? "",
          request.amountCents?.toString() ?? "",
          String(request.rateCdiBps),
          String(request.termDays),
          String(request.validitySeconds),
        ]
      : [onchainOfferId?.toString() ?? ""];
  return {
    action: request.action,
    contractCall: {
      args,
      chainId: ctx.deployment.chainId,
      contractAddress: ctx.deployment.contractAddress,
      functionName: functionNames[request.action],
    },
    createdAt: iso(request.createdAt),
    expiresAt: iso(request.expiresAt),
    failureCode: request.failureCode,
    id: request.id,
    offerId: request.offerId,
    params:
      request.action === "create_offer"
        ? {
            amountCents: request.amountCents?.toString() ?? "",
            borrowerWallet: request.borrowerWallet ?? "",
            rateCdiBps: request.rateCdiBps ?? 0,
            termDays: request.termDays ?? 0,
            validitySeconds: request.validitySeconds ?? 0,
          }
        : null,
    requesterWallet: request.requesterWallet,
    status: liveRequestStatus(request, ctx.now),
    submittedAt: request.submittedAt === null ? null : iso(request.submittedAt),
    txHash: request.txHash,
  };
}
