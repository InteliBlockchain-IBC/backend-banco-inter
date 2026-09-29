import { randomUUID } from "node:crypto";
import {
  type Address,
  type ChainEventRecord,
  type CreditLimitChangeRecord,
  effectiveStatus,
  type Hash,
  type OfferRecord,
  type OfferStatus,
  type SettlementRecord,
  type TransactionAction,
  type TransactionRequestRecord,
  type WalletState,
} from "../domain.js";
import { problems } from "../problem.js";
import { createFixtures, type Fixtures } from "./fixtures.js";

/** Validade de uma intenção até o frontend informar o hash assinado. */
export const REQUEST_TTL_MS = 15 * 60_000;
/** Acima disso sem sincronizar, a API sinaliza o listener como atrasado. */
export const SYNC_STALE_AFTER_SECONDS = 60;

const EXPLORER = "https://sepolia.etherscan.io";

export type Page = { limit: number; offset: number };
export type Paged<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

const iso = (date: Date): string => date.toISOString();
const lower = (address: string): Address => address.toLowerCase() as Address;

function paginate<T>(items: T[], page: Page): Paged<T> {
  return {
    items: items.slice(page.offset, page.offset + page.limit),
    limit: page.limit,
    offset: page.offset,
    total: items.length,
  };
}

const functionNames: Record<TransactionAction, string> = {
  accept_offer: "acceptOffer",
  cancel_offer: "cancelOffer",
  create_offer: "createOffer",
  reject_offer: "rejectOffer",
};

/**
 * Estado em memória que imita o Postgres. Cada `buildApp` ganha o seu, então
 * testes não vazam estado entre si. As intenções mudam aqui (pending ->
 * submitted); ofertas, limites e eventos só mudariam pelo listener, que ainda
 * não existe, então ficam fixos.
 */
export class MockStore {
  readonly #data: Fixtures;
  readonly #newId: () => string;
  readonly #now: () => Date;
  readonly #requests: TransactionRequestRecord[] = [];

  constructor(now: () => Date, newId: () => string = randomUUID) {
    this.#newId = newId;
    this.#now = now;
    this.#data = createFixtures(now());
  }

  // -------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------

  deployment() {
    const d = this.#data.deployment;
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

  syncStatus() {
    const cursor = this.#data.syncCursor;
    const lagSeconds = Math.max(
      0,
      Math.floor(
        (this.#now().getTime() - cursor.lastSyncedAt.getTime()) / 1000,
      ),
    );
    return {
      chainId: this.#data.deployment.chainId,
      contractAddress: this.#data.deployment.contractAddress,
      lagSeconds,
      lastProcessedBlock: cursor.lastProcessedBlock,
      lastProcessedBlockHash: cursor.lastProcessedBlockHash,
      lastSyncedAt: iso(cursor.lastSyncedAt),
      stale: lagSeconds > SYNC_STALE_AFTER_SECONDS,
    };
  }

  listOffers(
    filter: {
      status?: OfferStatus;
      wallet?: string;
      role?: "lender" | "borrower" | "any";
    },
    page: Page,
  ) {
    const now = this.#now();
    const wallet =
      filter.wallet === undefined ? undefined : lower(filter.wallet);
    const role = filter.role ?? "any";
    const items = this.#data.offers
      .filter((offer) => {
        if (
          filter.status !== undefined &&
          effectiveStatus(offer, now) !== filter.status
        ) {
          return false;
        }
        if (wallet === undefined) return true;
        const isLender = offer.lender === wallet;
        const isBorrower = offer.borrower === wallet;
        if (role === "lender") return isLender;
        if (role === "borrower") return isBorrower;
        return isLender || isBorrower;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return this.#mapPage(paginate(items, page), (offer) =>
      this.#offerView(offer),
    );
  }

  getOffer(id: string) {
    return this.#offerView(this.#offer(id));
  }

  offerEvents(id: string) {
    const offer = this.#offer(id);
    return this.#data.chainEvents
      .filter((event) => event.offerId === offer.id)
      .map((event) => this.#eventView(event));
  }

  listOperations(filter: { wallet?: string }, page: Page) {
    const wallet =
      filter.wallet === undefined ? undefined : lower(filter.wallet);
    const items = this.#data.settlements
      .map((settlement) => ({
        offer: this.#offer(settlement.offerId),
        settlement,
      }))
      .filter(
        ({ offer }) =>
          wallet === undefined ||
          offer.lender === wallet ||
          offer.borrower === wallet,
      )
      .sort(
        (a, b) =>
          b.settlement.settledAt.getTime() - a.settlement.settledAt.getTime(),
      );
    return this.#mapPage(paginate(items, page), ({ offer, settlement }) =>
      this.#operationView(offer, settlement),
    );
  }

  getOperation(txHash: string) {
    const hash = txHash.toLowerCase();
    const settlement = this.#data.settlements.find(
      (item) => item.txHash === hash,
    );
    if (settlement === undefined) throw problems.notFound("A operação");
    return this.#operationView(this.#offer(settlement.offerId), settlement);
  }

  listCreditLimits(filter: {
    excludeWallet?: string;
    minAvailableCents?: string;
    registered?: boolean;
  }) {
    const exclude =
      filter.excludeWallet === undefined
        ? undefined
        : lower(filter.excludeWallet);
    const min =
      filter.minAvailableCents === undefined
        ? undefined
        : BigInt(filter.minAvailableCents);
    return this.#data.wallets
      .filter(
        (state) =>
          (filter.registered === undefined ||
            state.isRegistered === filter.registered) &&
          (min === undefined || state.availableLimitCents >= min) &&
          state.wallet !== exclude,
      )
      .sort((a, b) =>
        a.availableLimitCents === b.availableLimitCents
          ? a.wallet.localeCompare(b.wallet)
          : a.availableLimitCents > b.availableLimitCents
            ? -1
            : 1,
      )
      .map((state) => this.#creditLimitView(state));
  }

  getCreditLimit(wallet: string) {
    return this.#creditLimitView(this.#wallet(wallet));
  }

  creditLimitHistory(wallet: string) {
    const state = this.#wallet(wallet);
    return this.#data.creditLimitChanges
      .filter((change) => change.wallet === state.wallet)
      .sort((a, b) => b.blockTimestamp.getTime() - a.blockTimestamp.getTime())
      .map((change) => this.#creditLimitChangeView(change));
  }

  getTransactionRequest(id: string) {
    return this.#requestView(this.#request(id));
  }

  // -------------------------------------------------------------------
  // Intenções
  // -------------------------------------------------------------------

  createOfferIntent(
    requesterWallet: string,
    input: {
      amountCents: string;
      borrowerWallet: string;
      rateCdiBps: number;
      termDays: number;
      validitySeconds: number;
    },
  ) {
    const requester = this.#requireRegistered(requesterWallet);
    const borrowerAddress = lower(input.borrowerWallet);
    if (borrowerAddress === requester.wallet)
      throw problems.invalidCounterparty();
    const borrower = this.#data.wallets.find(
      (state) => state.wallet === borrowerAddress,
    );
    if (borrower === undefined || !borrower.isRegistered) {
      throw problems.notRegistered("counterparty");
    }
    const amount = BigInt(input.amountCents);
    if (borrower.availableLimitCents < amount) {
      throw problems.insufficientLimit(borrower.availableLimitCents, amount);
    }
    return this.#requestView(
      this.#pushRequest({
        action: "create_offer",
        amountCents: amount,
        borrowerWallet: borrowerAddress,
        offerId: null,
        rateCdiBps: input.rateCdiBps,
        requesterWallet: requester.wallet,
        termDays: input.termDays,
        validitySeconds: input.validitySeconds,
      }),
    );
  }

  offerActionIntent(
    action: Exclude<TransactionAction, "create_offer">,
    requesterWallet: string,
    offerId: string,
  ) {
    const offer = this.#offer(offerId);
    const status = effectiveStatus(offer, this.#now());
    if (status === "expired" && offer.onchainStatus === 0)
      throw problems.offerExpired();
    if (status !== "offered") throw problems.invalidOfferStatus(status);

    const requester = lower(requesterWallet);
    if (action === "cancel_offer" && requester !== offer.lender) {
      throw problems.forbiddenNotLender();
    }
    if (action !== "cancel_offer" && requester !== offer.borrower) {
      throw problems.forbiddenNotBorrower();
    }
    // Como no contrato: só o aceite exige as duas carteiras ainda cadastradas.
    if (action === "accept_offer") {
      this.#requireRegistered(requester);
      const lender = this.#data.wallets.find(
        (state) => state.wallet === offer.lender,
      );
      if (lender === undefined || !lender.isRegistered) {
        throw problems.notRegistered("counterparty");
      }
      const borrower = this.#wallet(offer.borrower);
      if (borrower.availableLimitCents < offer.amountCents) {
        throw problems.insufficientLimit(
          borrower.availableLimitCents,
          offer.amountCents,
        );
      }
    }

    const inProgress = this.#requests.find(
      (request) =>
        request.offerId === offer.id &&
        request.action === action &&
        this.#liveStatus(request) !== "expired" &&
        (request.status === "pending" || request.status === "submitted"),
    );
    if (inProgress !== undefined)
      throw problems.requestInProgress(inProgress.id);

    return this.#requestView(
      this.#pushRequest({
        action,
        amountCents: null,
        borrowerWallet: null,
        offerId: offer.id,
        rateCdiBps: null,
        requesterWallet: requester,
        termDays: null,
        validitySeconds: null,
      }),
    );
  }

  submitTransaction(
    requestId: string,
    requesterWallet: string,
    txHash: string,
  ) {
    const request = this.#request(requestId);
    if (lower(requesterWallet) !== request.requesterWallet) {
      throw problems.forbiddenNotRequester();
    }
    const status = this.#liveStatus(request);
    if (status === "expired") throw problems.requestExpired();
    if (status !== "pending") throw problems.invalidRequestStatus(status);
    const hash = txHash.toLowerCase() as Hash;
    if (this.#requests.some((other) => other.txHash === hash)) {
      throw problems.duplicateTransaction(hash);
    }
    request.status = "submitted";
    request.txHash = hash;
    request.submittedAt = this.#now();
    return this.#requestView(request);
  }

  // -------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------

  #mapPage<T, U>(page: Paged<T>, map: (item: T) => U): Paged<U> {
    return { ...page, items: page.items.map(map) };
  }

  #offer(id: string): OfferRecord {
    const offer = this.#data.offers.find(
      (item) => item.id === id.toLowerCase(),
    );
    if (offer === undefined) throw problems.notFound("A oferta");
    return offer;
  }

  #wallet(address: string): WalletState {
    const state = this.#data.wallets.find(
      (item) => item.wallet === lower(address),
    );
    if (state === undefined) throw problems.notFound("A carteira");
    return state;
  }

  #request(id: string): TransactionRequestRecord {
    const request = this.#requests.find((item) => item.id === id.toLowerCase());
    if (request === undefined) throw problems.notFound("A intenção");
    return request;
  }

  #requireRegistered(address: string): WalletState {
    const state = this.#data.wallets.find(
      (item) => item.wallet === lower(address),
    );
    if (state === undefined || !state.isRegistered)
      throw problems.notRegistered("requester");
    return state;
  }

  #liveStatus(request: TransactionRequestRecord) {
    if (
      request.status === "pending" &&
      request.expiresAt.getTime() <= this.#now().getTime()
    ) {
      return "expired" as const;
    }
    return request.status;
  }

  #pushRequest(
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
  ): TransactionRequestRecord {
    const createdAt = this.#now();
    const request: TransactionRequestRecord = {
      ...input,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + REQUEST_TTL_MS),
      failureCode: null,
      id: this.#newId(),
      status: "pending",
      submittedAt: null,
      txHash: null,
    };
    this.#requests.push(request);
    return request;
  }

  #party(address: Address) {
    const state = this.#data.wallets.find((item) => item.wallet === address);
    const institution =
      state?.institutionId === undefined || state.institutionId === null
        ? undefined
        : this.#data.institutions.find(
            (item) => item.id === state.institutionId,
          );
    return {
      institution:
        institution === undefined
          ? null
          : { id: institution.id, name: institution.name },
      wallet: address,
    };
  }

  #offerView(offer: OfferRecord) {
    const settlement = this.#data.settlements.find(
      (item) => item.offerId === offer.id,
    );
    return {
      amountCents: offer.amountCents.toString(),
      borrower: this.#party(offer.borrower),
      chainId: this.#data.deployment.chainId,
      contractAddress: this.#data.deployment.contractAddress,
      createTxHash: offer.createTxHash,
      createdAt: iso(offer.createdAt),
      createdBlock: offer.createdBlock,
      expiresAt: iso(offer.expiresAt),
      id: offer.id,
      lender: this.#party(offer.lender),
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
      status: effectiveStatus(offer, this.#now()),
      termDays: offer.termDays,
    };
  }

  #operationView(offer: OfferRecord, settlement: SettlementRecord) {
    return {
      amountCents: offer.amountCents.toString(),
      blockHash: settlement.blockHash,
      blockNumber: settlement.blockNumber,
      borrower: this.#party(offer.borrower),
      chainId: this.#data.deployment.chainId,
      contractAddress: this.#data.deployment.contractAddress,
      explorerUrl: `${EXPLORER}/tx/${settlement.txHash}`,
      lender: this.#party(offer.lender),
      offerId: offer.id,
      onchainOfferId: offer.onchainOfferId.toString(),
      positionTokenId: settlement.positionTokenId.toString(),
      rateCdiBps: offer.rateCdiBps,
      settledAt: iso(settlement.settledAt),
      termDays: offer.termDays,
      txHash: settlement.txHash,
    };
  }

  #eventView(event: ChainEventRecord) {
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

  #creditLimitView(state: WalletState) {
    const party = this.#party(state.wallet);
    return {
      availableLimitCents: state.availableLimitCents.toString(),
      institution: party.institution,
      isRegistered: state.isRegistered,
      observedAt: iso(state.observedAt),
      observedBlock: state.observedBlock,
      wallet: state.wallet,
    };
  }

  #creditLimitChangeView(change: CreditLimitChangeRecord) {
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

  #requestView(request: TransactionRequestRecord) {
    const offer =
      request.offerId === null
        ? undefined
        : this.#data.offers.find((item) => item.id === request.offerId);
    const args =
      request.action === "create_offer"
        ? [
            request.borrowerWallet ?? "",
            request.amountCents?.toString() ?? "",
            String(request.rateCdiBps),
            String(request.termDays),
            String(request.validitySeconds),
          ]
        : [offer?.onchainOfferId.toString() ?? ""];
    return {
      action: request.action,
      contractCall: {
        args,
        chainId: this.#data.deployment.chainId,
        contractAddress: this.#data.deployment.contractAddress,
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
      status: this.#liveStatus(request),
      submittedAt:
        request.submittedAt === null ? null : iso(request.submittedAt),
      txHash: request.txHash,
    };
  }
}
