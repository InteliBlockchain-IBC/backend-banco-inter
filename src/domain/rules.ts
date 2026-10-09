import { createHash } from "node:crypto";
import {
  type Address,
  type ChainEventName,
  effectiveStatus,
  type Hash,
  type OfferRecord,
  type OfferStatus,
  UINT256_MAX,
  type WalletState,
} from "./types.js";
import { ApiProblem, problems } from "../http/errors.js";

/**
 * Regras do fluxo DvP, puras (sem banco nem HTTP). Os dois repositórios as
 * aplicam, então recusam e registram as mesmas transições com os mesmos
 * argumentos de evento.
 */

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
