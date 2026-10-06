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

export const MAX_MOCK_OFFERS = 100;
const LAST_ISO_SECOND = 253402300799n;

export type SimulatedOfferInput = {
  amountCents: string;
  borrowerWallet: string;
  lenderWallet: string;
  rateCdiBps: number;
  termDays: number;
  validitySeconds: number;
};

function hash(value: string): Hash {
  return `0x${createHash("sha256").update(`mock:${value}`).digest("hex")}`;
}

function registered(data: Fixtures, address: Address): WalletState {
  const wallet = data.wallets.find((item) => item.wallet === address);
  if (!wallet?.isRegistered) {
    throw new ApiProblem(
      422,
      "not-registered-institution",
      "Carteira não cadastrada",
      "A carteira fictícia não está cadastrada.",
    );
  }
  return wallet;
}

function block(data: Fixtures, at: Date, txHash: Hash) {
  const blockNumber =
    Math.max(
      data.syncCursor.lastProcessedBlock,
      ...data.chainEvents.map((event) => event.blockNumber),
    ) + 1;
  const blockHash = hash(`block:${blockNumber}`);
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
  id: string,
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
  const lender = input.lenderWallet.toLowerCase() as Address;
  const borrower = input.borrowerWallet.toLowerCase() as Address;
  if (
    lender === `0x${"00".repeat(20)}` ||
    borrower === `0x${"00".repeat(20)}` ||
    lender === borrower
  ) {
    throw new ApiProblem(
      400,
      "invalid-counterparty",
      "Contraparte inválida",
      "As carteiras precisam ser diferentes e não nulas.",
    );
  }
  registered(data, lender);
  const borrowerState = registered(data, borrower);
  const amount = BigInt(input.amountCents);
  if (amount === 0n || amount > UINT256_MAX) throw problems.invalidAmount();
  if (borrowerState.availableLimitCents < amount) {
    throw problems.insufficientLimit(borrowerState.availableLimitCents, amount);
  }
  const at = new Date(Math.floor(now.getTime() / 1_000) * 1_000);
  const expiry = BigInt(at.getTime() / 1_000) + BigInt(input.validitySeconds);
  if (expiry > LAST_ISO_SECOND) {
    throw new ApiProblem(
      400,
      "invalid-expiry",
      "Validade inválida",
      "expiresAt ultrapassa o limite de datas ISO do simulador.",
    );
  }
  const expiresAt = new Date(Number(expiry) * 1_000);
  const onchainOfferId =
    data.offers.reduce(
      (max, offer) => (offer.onchainOfferId > max ? offer.onchainOfferId : max),
      0n,
    ) + 1n;
  const txHash = hash(`${id}:create`);
  const mined = block(data, at, txHash);
  const offer: OfferRecord = {
    amountCents: amount,
    borrower,
    createTxHash: txHash,
    createdAt: at,
    createdBlock: mined.blockNumber,
    expiresAt,
    id,
    lender,
    onchainOfferId,
    onchainStatus: onchainStatusCodes.offered,
    rateCdiBps: input.rateCdiBps,
    termDays: input.termDays,
  };
  const created = mined.event(id, "OfferCreated", 0, {
    amount: amount.toString(),
    borrower,
    expiresAt: expiry.toString(),
    lender,
    offerId: onchainOfferId.toString(),
    rateCDI: String(input.rateCdiBps),
    term: String(input.termDays),
  });
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
  action: "accept" | "reject" | "cancel",
): { data: Fixtures; offer: OfferRecord; settlement: SettlementRecord | null } {
  const original = data.offers.find((item) => item.id === id.toLowerCase());
  if (!original) throw problems.notFound("A oferta");
  const status = effectiveStatus(original, now);
  if (status === "expired" && original.onchainStatus === 0)
    throw problems.offerExpired();
  if (status !== "offered") throw problems.invalidOfferStatus(status);
  const borrowerState =
    action === "accept" ? registered(data, original.borrower) : undefined;
  if (action === "accept") registered(data, original.lender);
  if (
    borrowerState &&
    borrowerState.availableLimitCents < original.amountCents
  ) {
    throw problems.insufficientLimit(
      borrowerState.availableLimitCents,
      original.amountCents,
    );
  }
  const at = new Date(Math.floor(now.getTime() / 1_000) * 1_000);
  const txHash = hash(`${id}:${action}`);
  const mined = block(data, at, txHash);
  const unix = String(at.getTime() / 1_000);
  const offerId = original.onchainOfferId.toString();
  const newStatus: OfferStatus =
    action === "accept"
      ? "settled"
      : action === "reject"
        ? "rejected"
        : "cancelled";
  const offer: OfferRecord = {
    ...original,
    onchainStatus: onchainStatusCodes[newStatus],
  };
  const firstEvent = mined.event(
    original.id,
    action === "accept"
      ? "OfferAccepted"
      : action === "reject"
        ? "OfferRejected"
        : "OfferCancelled",
    0,
    action === "cancel"
      ? { offerId, timestamp: unix }
      : { borrower: original.borrower, offerId, timestamp: unix },
  );
  const settledEvent =
    action === "accept"
      ? mined.event(original.id, "OfferSettled", 1, {
          amount: original.amountCents.toString(),
          borrower: original.borrower,
          lender: original.lender,
          offerId,
          positionTokenId: offerId,
          rateCDI: String(original.rateCdiBps),
          term: String(original.termDays),
          timestamp: unix,
        })
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
