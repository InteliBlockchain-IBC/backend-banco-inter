import {
  type Address,
  type ChainEventName,
  type ChainEventRecord,
  type Hash,
  type OfferRecord,
  onchainStatusCodes,
  type SettlementRecord,
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
import { ApiProblem, problems } from "../../http/errors.js";
import type { Fixtures } from "../../demo/fixtures.js";

/**
 * Transições da simulação sobre o estado em memória (`Fixtures`), aplicando as
 * regras de `domain/rules.ts`. O equivalente no PostgreSQL está em
 * `repositories/postgres/pg-repository.ts`.
 */

export const MAX_MOCK_OFFERS = 100;

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
