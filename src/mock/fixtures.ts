import {
  type Address,
  type ChainEventName,
  type ChainEventRecord,
  type CreditLimitChangeRecord,
  type Deployment,
  type Hash,
  type Institution,
  type OfferRecord,
  onchainStatusCodes,
  SEPOLIA_CHAIN_ID,
  type SettlementRecord,
  type SyncCursor,
  type WalletState,
} from "../domain.js";

/**
 * Massa fictícia coerente com o contrato: toda oferta tem os eventos que a
 * geraram, toda liquidação debita o limite do tomador e todo limite tem
 * histórico. Os horários são relativos a `now`, então sempre há ofertas
 * abertas e uma oferta vencida sem `OfferExpired` (vencimento preguiçoso).
 */
export type Fixtures = {
  chainEvents: ChainEventRecord[];
  creditLimitChanges: CreditLimitChangeRecord[];
  deployment: Deployment;
  institutions: Institution[];
  offers: OfferRecord[];
  settlements: SettlementRecord[];
  syncCursor: SyncCursor;
  wallets: WalletState[];
};

const BLOCK_TIME_MS = 12_000;
const HEAD_BLOCK = 9_200_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function hex64(prefix: string, n: number): Hash {
  return `0x${prefix}${n.toString(16).padStart(64 - prefix.length, "0")}`;
}

function wallet(byte: string): Address {
  return `0x${byte.repeat(20)}`;
}

function uuid(prefix: string, n: number): string {
  return `${prefix.padEnd(8, "0")}-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

export const mockWallets = {
  alfa: wallet("a1"),
  beta: wallet("b2"),
  delta: wallet("d4"),
  gama: wallet("c3"),
} as const;

export const mockInstitutionIds = {
  alfa: uuid("b", 1),
  beta: uuid("b", 2),
  delta: uuid("b", 4),
  gama: uuid("b", 3),
} as const;

export function mockOfferId(onchainOfferId: number): string {
  return uuid("a", onchainOfferId);
}

type OfferSeed = {
  amountCents: bigint;
  borrower: Address;
  createdAgoMs: number;
  lender: Address;
  outcome:
    | { kind: "open"; validityMs: number }
    | { kind: "settled"; afterMs: number }
    | { kind: "cancelled"; afterMs: number }
    | { kind: "rejected"; afterMs: number }
    | { kind: "expired"; validityMs: number; expireCalled: boolean };
  rateCdiBps: number;
  termDays: number;
};

export function createFixtures(now: Date): Fixtures {
  // Horários on-chain têm resolução de segundos.
  const nowMs = Math.floor(now.getTime() / 1000) * 1000;
  const blockAt = (at: Date): number =>
    HEAD_BLOCK - Math.ceil((nowMs - at.getTime()) / BLOCK_TIME_MS);
  let txCounter = 0;
  const nextTx = (): Hash => hex64("7", ++txCounter);
  const blockHash = (block: number): Hash => hex64("b", block);

  const deployment: Deployment = {
    brlTokenAddress: wallet("0b"),
    chainId: SEPOLIA_CHAIN_ID,
    contractAddress: wallet("0c"),
    positionTokenAddress: wallet("0e"),
    startBlock: blockAt(new Date(nowMs - 10 * DAY)),
  };

  const institutions: Institution[] = [
    { id: mockInstitutionIds.alfa, name: "Banco Alfa S.A. (fictício)" },
    { id: mockInstitutionIds.beta, name: "Banco Beta S.A. (fictício)" },
    { id: mockInstitutionIds.gama, name: "Banco Gama S.A. (fictício)" },
    { id: mockInstitutionIds.delta, name: "Banco Delta S.A. (fictício)" },
  ];

  const chainEvents: ChainEventRecord[] = [];
  const creditLimitChanges: CreditLimitChangeRecord[] = [];
  const walletByAddress = new Map<Address, WalletState>();

  const emit = (
    at: Date,
    txHash: Hash,
    logIndex: number,
    eventName: ChainEventName,
    args: Record<string, string>,
    offerId: string | null = null,
  ): ChainEventRecord => {
    const blockNumber = blockAt(at);
    const event: ChainEventRecord = {
      args,
      blockHash: blockHash(blockNumber),
      blockNumber,
      blockTimestamp: at,
      eventName,
      logIndex,
      offerId,
      txHash,
    };
    chainEvents.push(event);
    return event;
  };

  const setLimit = (
    target: WalletState,
    newLimit: bigint,
    at: Date,
    kind: "admin_update" | "settlement",
    source: { txHash: Hash; logIndex: number; offerId: string | null },
  ): void => {
    creditLimitChanges.push({
      blockTimestamp: at,
      changeKind: kind,
      logIndex: source.logIndex,
      newLimitCents: newLimit,
      offerId: source.offerId,
      previousLimitCents: target.availableLimitCents,
      txHash: source.txHash,
      wallet: target.wallet,
    });
    target.availableLimitCents = newLimit;
    target.observedAt = at;
    target.observedBlock = blockAt(at);
  };

  const registration: Array<{
    address: Address;
    institutionId: string;
    initialLimitCents: bigint;
    revokedAgoMs?: number;
  }> = [
    {
      address: mockWallets.alfa,
      initialLimitCents: 32_500_000_000n,
      institutionId: mockInstitutionIds.alfa,
    },
    {
      address: mockWallets.beta,
      initialLimitCents: 20_000_000_000n,
      institutionId: mockInstitutionIds.beta,
    },
    {
      address: mockWallets.gama,
      initialLimitCents: 11_000_000_000n,
      institutionId: mockInstitutionIds.gama,
    },
    {
      address: mockWallets.delta,
      initialLimitCents: 5_000_000_000n,
      institutionId: mockInstitutionIds.delta,
      revokedAgoMs: 4 * DAY,
    },
  ];

  registration.forEach((entry, index) => {
    const registeredAt = new Date(nowMs - 9 * DAY + index * HOUR);
    const state: WalletState = {
      availableLimitCents: 0n,
      institutionId: entry.institutionId,
      isRegistered: true,
      observedAt: registeredAt,
      observedBlock: blockAt(registeredAt),
      wallet: entry.address,
    };
    walletByAddress.set(entry.address, state);
    const registerTx = nextTx();
    emit(registeredAt, registerTx, 0, "InstitutionRegistered", {
      timestamp: String(Math.floor(registeredAt.getTime() / 1000)),
      wallet: entry.address,
    });

    const limitAt = new Date(registeredAt.getTime() + 10 * MINUTE);
    const limitTx = nextTx();
    emit(limitAt, limitTx, 0, "CreditLimitUpdated", {
      institution: entry.address,
      newLimit: entry.initialLimitCents.toString(),
      previousLimit: "0",
      timestamp: String(Math.floor(limitAt.getTime() / 1000)),
    });
    setLimit(state, entry.initialLimitCents, limitAt, "admin_update", {
      logIndex: 0,
      offerId: null,
      txHash: limitTx,
    });

    if (entry.revokedAgoMs !== undefined) {
      const revokedAt = new Date(nowMs - entry.revokedAgoMs);
      emit(revokedAt, nextTx(), 0, "InstitutionRevoked", {
        timestamp: String(Math.floor(revokedAt.getTime() / 1000)),
        wallet: entry.address,
      });
      state.isRegistered = false;
      state.observedAt = revokedAt;
      state.observedBlock = blockAt(revokedAt);
    }
  });

  const seeds: OfferSeed[] = [
    {
      amountCents: 5_000_000_000n,
      borrower: mockWallets.beta,
      createdAgoMs: 3 * DAY,
      lender: mockWallets.alfa,
      outcome: { afterMs: 12 * MINUTE, kind: "settled" },
      rateCdiBps: 10_250,
      termDays: 1,
    },
    {
      amountCents: 2_500_000_000n,
      borrower: mockWallets.alfa,
      createdAgoMs: 2 * DAY,
      lender: mockWallets.gama,
      outcome: { afterMs: 7 * MINUTE, kind: "settled" },
      rateCdiBps: 10_100,
      termDays: 1,
    },
    {
      amountCents: 1_000_000_000n,
      borrower: mockWallets.gama,
      createdAgoMs: 30 * HOUR,
      lender: mockWallets.beta,
      outcome: { afterMs: 20 * MINUTE, kind: "cancelled" },
      rateCdiBps: 10_300,
      termDays: 1,
    },
    {
      amountCents: 7_000_000_000n,
      borrower: mockWallets.gama,
      createdAgoMs: 26 * HOUR,
      lender: mockWallets.alfa,
      outcome: { afterMs: 5 * MINUTE, kind: "rejected" },
      rateCdiBps: 10_400,
      termDays: 1,
    },
    {
      amountCents: 1_200_000_000n,
      borrower: mockWallets.beta,
      createdAgoMs: 20 * HOUR,
      lender: mockWallets.gama,
      outcome: { expireCalled: true, kind: "expired", validityMs: HOUR },
      rateCdiBps: 10_150,
      termDays: 1,
    },
    {
      amountCents: 3_000_000_000n,
      borrower: mockWallets.gama,
      createdAgoMs: 5 * HOUR,
      lender: mockWallets.beta,
      outcome: { afterMs: 9 * MINUTE, kind: "settled" },
      rateCdiBps: 10_200,
      termDays: 1,
    },
    {
      amountCents: 3_000_000_000n,
      borrower: mockWallets.alfa,
      createdAgoMs: 3 * HOUR,
      lender: mockWallets.beta,
      outcome: { expireCalled: false, kind: "expired", validityMs: 2 * HOUR },
      rateCdiBps: 10_200,
      termDays: 1,
    },
    {
      amountCents: 4_000_000_000n,
      borrower: mockWallets.beta,
      createdAgoMs: 10 * MINUTE,
      lender: mockWallets.alfa,
      outcome: { kind: "open", validityMs: HOUR },
      rateCdiBps: 10_500,
      termDays: 1,
    },
    {
      amountCents: 1_500_000_000n,
      borrower: mockWallets.alfa,
      createdAgoMs: 5 * MINUTE,
      lender: mockWallets.gama,
      outcome: { kind: "open", validityMs: HOUR },
      rateCdiBps: 10_350,
      termDays: 2,
    },
  ];

  const offers: OfferRecord[] = [];
  const settlements: SettlementRecord[] = [];

  seeds.forEach((seed, index) => {
    const onchainOfferId = BigInt(index + 1);
    const id = mockOfferId(index + 1);
    const createdAt = new Date(nowMs - seed.createdAgoMs);
    const validityMs =
      seed.outcome.kind === "open" || seed.outcome.kind === "expired"
        ? seed.outcome.validityMs
        : HOUR;
    const expiresAt = new Date(createdAt.getTime() + validityMs);
    const createTxHash = nextTx();
    const offer: OfferRecord = {
      amountCents: seed.amountCents,
      borrower: seed.borrower,
      createTxHash,
      createdAt,
      createdBlock: blockAt(createdAt),
      expiresAt,
      id,
      lender: seed.lender,
      onchainOfferId,
      onchainStatus: onchainStatusCodes.offered,
      rateCdiBps: seed.rateCdiBps,
      termDays: seed.termDays,
    };
    offers.push(offer);
    emit(
      createdAt,
      createTxHash,
      0,
      "OfferCreated",
      {
        amount: seed.amountCents.toString(),
        borrower: seed.borrower,
        expiresAt: String(Math.floor(expiresAt.getTime() / 1000)),
        lender: seed.lender,
        offerId: onchainOfferId.toString(),
        rateCDI: String(seed.rateCdiBps),
        term: String(seed.termDays),
      },
      id,
    );

    const outcome = seed.outcome;
    const unix = (at: Date): string => String(Math.floor(at.getTime() / 1000));
    switch (outcome.kind) {
      case "open":
        break;
      case "settled": {
        const at = new Date(createdAt.getTime() + outcome.afterMs);
        const txHash = nextTx();
        emit(
          at,
          txHash,
          0,
          "OfferAccepted",
          {
            borrower: seed.borrower,
            offerId: onchainOfferId.toString(),
            timestamp: unix(at),
          },
          id,
        );
        const settled = emit(
          at,
          txHash,
          1,
          "OfferSettled",
          {
            amount: seed.amountCents.toString(),
            borrower: seed.borrower,
            lender: seed.lender,
            offerId: onchainOfferId.toString(),
            positionTokenId: onchainOfferId.toString(),
            rateCDI: String(seed.rateCdiBps),
            term: String(seed.termDays),
            timestamp: unix(at),
          },
          id,
        );
        offer.onchainStatus = onchainStatusCodes.settled;
        settlements.push({
          blockHash: settled.blockHash,
          blockNumber: settled.blockNumber,
          offerId: id,
          positionTokenId: onchainOfferId,
          settledAt: at,
          txHash,
        });
        const borrowerState = walletByAddress.get(seed.borrower);
        if (borrowerState === undefined) throw new Error("tomador sem estado");
        setLimit(
          borrowerState,
          borrowerState.availableLimitCents - seed.amountCents,
          at,
          "settlement",
          { logIndex: 1, offerId: id, txHash },
        );
        break;
      }
      case "cancelled": {
        const at = new Date(createdAt.getTime() + outcome.afterMs);
        emit(
          at,
          nextTx(),
          0,
          "OfferCancelled",
          { offerId: onchainOfferId.toString(), timestamp: unix(at) },
          id,
        );
        offer.onchainStatus = onchainStatusCodes.cancelled;
        break;
      }
      case "rejected": {
        const at = new Date(createdAt.getTime() + outcome.afterMs);
        emit(
          at,
          nextTx(),
          0,
          "OfferRejected",
          {
            borrower: seed.borrower,
            offerId: onchainOfferId.toString(),
            timestamp: unix(at),
          },
          id,
        );
        offer.onchainStatus = onchainStatusCodes.rejected;
        break;
      }
      case "expired": {
        if (outcome.expireCalled) {
          const at = new Date(expiresAt.getTime() + 30 * MINUTE);
          emit(
            at,
            nextTx(),
            0,
            "OfferExpired",
            { offerId: onchainOfferId.toString(), timestamp: unix(at) },
            id,
          );
          offer.onchainStatus = onchainStatusCodes.expired;
        }
        break;
      }
    }
  });

  chainEvents.sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );
  creditLimitChanges.sort(
    (a, b) => a.blockTimestamp.getTime() - b.blockTimestamp.getTime(),
  );

  const syncedAt = new Date(nowMs - 4_000);
  const syncBlock = blockAt(syncedAt);

  return {
    chainEvents,
    creditLimitChanges,
    deployment,
    institutions,
    offers,
    settlements,
    syncCursor: {
      lastProcessedBlock: syncBlock,
      lastProcessedBlockHash: blockHash(syncBlock),
      lastSyncedAt: syncedAt,
    },
    wallets: [...walletByAddress.values()],
  };
}
