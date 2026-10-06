import { createHash } from "node:crypto";
import {
  type Address,
  type ChainEventName,
  type ChainEventRecord,
  effectiveStatus,
  type Hash,
  type OfferRecord,
  onchainStatusCodes,
  type OfferStatus,
  UINT256_MAX,
  type SettlementRecord,
  type WalletState,
} from "../domain.js";
import { ApiProblem, problems } from "../problem.js";
import type { Fixtures } from "./fixtures.js";

/**
 * Regras da simulação DvP. As funções exportadas são puras e compartilhadas
 * pelo store em memória e pelo `PgStore`, então os dois recusam e registram as
 * mesmas transições com os mesmos argumentos de evento.
 */

export const MAX_MOCK_OFFERS = 100;
const LAST_ISO_SECOND = 253402300799n;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;

export type SimulatedOfferInput = {
  amountCents: string;
  borrowerWallet: string;
  lenderWallet: string;
  rateCdiBps: number;
  termDays: number;
  validitySeconds: number;
};

export type SimulatedAction = "accept" | "reject" | "cancel";

/** Hash sintético e determinístico: não corresponde a nenhuma transação real. */
export function syntheticHash(value: string): Hash {
  return `0x${createHash("sha256").update(`mock:${value}`).digest("hex")}`;
}

export function notRegisteredProblem(): ApiProblem {
  return new ApiProblem(
    422,
    "not-registered-institution",
    "Carteira não cadastrada",
    "A carteira fictícia não está cadastrada.",
  );
}

export function requireRegisteredWallet(
  wallet: WalletState | undefined,
): WalletState {
  if (!wallet?.isRegistered) throw notRegisteredProblem();
  return wallet;
}

export function parseCounterparties(input: SimulatedOfferInput): {
  borrower: Address;
  lender: Address;
} {
  const lender = input.lenderWallet.toLowerCase() as Address;
  const borrower = input.borrowerWallet.toLowerCase() as Address;
  if (
    lender === ZERO_ADDRESS ||
    borrower === ZERO_ADDRESS ||
    lender === borrower
  ) {
    throw new ApiProblem(
      400,
      "invalid-counterparty",
      "Contraparte inválida",
      "As carteiras precisam ser diferentes e não nulas.",
    );
  }
  return { borrower, lender };
}

export function parseAmount(amountCents: string): bigint {
  const amount = BigInt(amountCents);
  if (amount === 0n || amount > UINT256_MAX) throw problems.invalidAmount();
  return amount;
}

export function requireLimit(borrower: WalletState, amount: bigint): void {
  if (borrower.availableLimitCents < amount) {
    throw problems.insufficientLimit(borrower.availableLimitCents, amount);
  }
}

/** Horários on-chain têm resolução de segundos. */
export function blockTime(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 1_000) * 1_000);
}

export function offerExpiry(
  at: Date,
  validitySeconds: number,
): { expiresAt: Date; unix: bigint } {
  const unix = BigInt(at.getTime() / 1_000) + BigInt(validitySeconds);
  if (unix > LAST_ISO_SECOND) {
    throw new ApiProblem(
      400,
      "invalid-expiry",
      "Validade inválida",
      "expiresAt ultrapassa o limite de datas ISO do simulador.",
    );
  }
  return { expiresAt: new Date(Number(unix) * 1_000), unix };
}

/** Só uma oferta `offered` dentro da validade aceita transições. */
export function requireActionable(offer: OfferRecord, now: Date): void {
  const status = effectiveStatus(offer, now);
  if (status === "expired" && offer.onchainStatus === 0)
    throw problems.offerExpired();
  if (status !== "offered") throw problems.invalidOfferStatus(status);
}

export function actionOutcome(action: SimulatedAction): {
  eventName: ChainEventName;
  status: OfferStatus;
} {
  if (action === "accept")
    return { eventName: "OfferAccepted", status: "settled" };
  if (action === "reject")
    return { eventName: "OfferRejected", status: "rejected" };
  return { eventName: "OfferCancelled", status: "cancelled" };
}

export function offerCreatedArgs(
  offer: OfferRecord,
  expiryUnix: bigint,
): Record<string, string> {
  return {
    amount: offer.amountCents.toString(),
    borrower: offer.borrower,
    expiresAt: expiryUnix.toString(),
    lender: offer.lender,
    offerId: offer.onchainOfferId.toString(),
    rateCDI: String(offer.rateCdiBps),
    term: String(offer.termDays),
  };
}

export function actionEventArgs(
  offer: OfferRecord,
  action: SimulatedAction,
  at: Date,
): Record<string, string> {
  const offerId = offer.onchainOfferId.toString();
  const timestamp = String(at.getTime() / 1_000);
  return action === "cancel"
    ? { offerId, timestamp }
    : { borrower: offer.borrower, offerId, timestamp };
}

export function offerSettledArgs(
  offer: OfferRecord,
  at: Date,
): Record<string, string> {
  const offerId = offer.onchainOfferId.toString();
  return {
    amount: offer.amountCents.toString(),
    borrower: offer.borrower,
    lender: offer.lender,
    offerId,
    positionTokenId: offerId,
    rateCDI: String(offer.rateCdiBps),
    term: String(offer.termDays),
    timestamp: String(at.getTime() / 1_000),
  };
}

function block(data: Fixtures, at: Date, txHash: Hash) {
  const blockNumber =
    Math.max(
      data.syncCursor.lastProcessedBlock,
      ...data.chainEvents.map((event) => event.blockNumber),
    ) + 1;
  const blockHash = syntheticHash(`block:${blockNumber}`);
  return {
    blockHash,
    blockNumber,
    syncCursor: {
      lastProcessedBlock: blockNumber,
      lastProcessedBlockHash: blockHash,
      lastSyncedAt: at,
    },
    event(
      offerId: string,
      eventName: ChainEventName,
      logIndex: number,
      args: Record<string, string>,
    ): ChainEventRecord {
      return {
        args,
        blockHash,
        blockNumber,
        blockTimestamp: at,
        eventName,
        logIndex,
        offerId,
        txHash,
      };
    },
  };
}

export function simulateCreate(
  data: Fixtures,
  now: Date,
  newId: () => string,
  input: SimulatedOfferInput,
) {
  if (data.offers.length >= MAX_MOCK_OFFERS) {
    throw new ApiProblem(
      503,
      "mock-store-full",
      "Simulador cheio",
      "O simulador atingiu o limite de ofertas nesta instância.",
    );
  }
  const { borrower, lender } = parseCounterparties(input);
  const find = (address: Address) =>
    data.wallets.find((item) => item.wallet === address);
  requireRegisteredWallet(find(lender));
  const borrowerState = requireRegisteredWallet(find(borrower));
  const amount = parseAmount(input.amountCents);
  requireLimit(borrowerState, amount);
  const at = blockTime(now);
  const expiry = offerExpiry(at, input.validitySeconds);
  const onchainOfferId =
    data.offers.reduce(
      (max, offer) => (offer.onchainOfferId > max ? offer.onchainOfferId : max),
      0n,
    ) + 1n;
  // O id só é gerado depois de todas as recusas possíveis.
  const id = newId();
  const txHash = syntheticHash(`${id}:create`);
  const mined = block(data, at, txHash);
  const offer: OfferRecord = {
    amountCents: amount,
    borrower,
    createTxHash: txHash,
    createdAt: at,
    createdBlock: mined.blockNumber,
    expiresAt: expiry.expiresAt,
    id,
    lender,
    onchainOfferId,
    onchainStatus: onchainStatusCodes.offered,
    rateCdiBps: input.rateCdiBps,
    termDays: input.termDays,
  };
  const created = mined.event(
    id,
    "OfferCreated",
    0,
    offerCreatedArgs(offer, expiry.unix),
  );
  return {
    data: {
      ...data,
      offers: [...data.offers, offer],
      chainEvents: [...data.chainEvents, created],
      syncCursor: mined.syncCursor,
    },
    offer,
  };
}

export function simulateAction(
  data: Fixtures,
  now: Date,
  id: string,
  action: SimulatedAction,
): { data: Fixtures; offer: OfferRecord; settlement: SettlementRecord | null } {
  const original = data.offers.find((item) => item.id === id.toLowerCase());
  if (!original) throw problems.notFound("A oferta");
  requireActionable(original, now);
  const find = (address: Address) =>
    data.wallets.find((item) => item.wallet === address);
  const borrowerState =
    action === "accept"
      ? requireRegisteredWallet(find(original.borrower))
      : undefined;
  if (action === "accept") requireRegisteredWallet(find(original.lender));
  if (borrowerState) requireLimit(borrowerState, original.amountCents);
  const at = blockTime(now);
  const txHash = syntheticHash(`${original.id}:${action}`);
  const mined = block(data, at, txHash);
  const outcome = actionOutcome(action);
  const offer: OfferRecord = {
    ...original,
    onchainStatus: onchainStatusCodes[outcome.status],
  };
  const firstEvent = mined.event(
    original.id,
    outcome.eventName,
    0,
    actionEventArgs(original, action, at),
  );
  const settledEvent =
    action === "accept"
      ? mined.event(
          original.id,
          "OfferSettled",
          1,
          offerSettledArgs(original, at),
        )
      : null;
  const settlement: SettlementRecord | null = settledEvent
    ? {
        blockHash: mined.blockHash,
        blockNumber: mined.blockNumber,
        offerId: original.id,
        positionTokenId: original.onchainOfferId,
        settledAt: at,
        txHash,
      }
    : null;
  const availableLimitCents = borrowerState
    ? borrowerState.availableLimitCents - original.amountCents
    : null;
  return {
    data: {
      ...data,
      offers: data.offers.map((item) => (item.id === offer.id ? offer : item)),
      chainEvents: [
        ...data.chainEvents,
        firstEvent,
        ...(settledEvent ? [settledEvent] : []),
      ],
      settlements: settlement
        ? [...data.settlements, settlement]
        : data.settlements,
      wallets:
        availableLimitCents === null
          ? data.wallets
          : data.wallets.map((wallet) =>
              wallet.wallet === original.borrower
                ? {
                    ...wallet,
                    availableLimitCents,
                    observedAt: at,
                    observedBlock: mined.blockNumber,
                  }
                : wallet,
            ),
      creditLimitChanges:
        availableLimitCents === null
          ? data.creditLimitChanges
          : [
              ...data.creditLimitChanges,
              {
                blockTimestamp: at,
                changeKind: "settlement",
                logIndex: 1,
                newLimitCents: availableLimitCents,
                offerId: original.id,
                previousLimitCents: borrowerState?.availableLimitCents ?? 0n,
                txHash,
                wallet: original.borrower,
              },
            ],
      syncCursor: mined.syncCursor,
    },
    offer,
    settlement,
  };
}
