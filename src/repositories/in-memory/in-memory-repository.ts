import { randomUUID } from "node:crypto";
import {
  type Address,
  effectiveStatus,
  type Hash,
  type OfferRecord,
  type SettlementRecord,
  type TransactionAction,
  type TransactionRequestRecord,
  type WalletState,
  UINT256_MAX,
} from "../../domain/types.js";
import { problems } from "../../http/errors.js";
import {
  type CreditLimitFilter,
  type Repository,
  type OfferFilter,
  type OfferIntentInput,
  type Page,
  type Paged,
  REQUEST_TTL_MS,
} from "../repository.js";
import {
  creditLimitChangeView,
  creditLimitView,
  deploymentView,
  eventView,
  liveRequestStatus,
  offerView,
  operationView,
  party,
  requestView,
  syncStatusView,
  type ViewContext,
} from "../../domain/views.js";
import { createFixtures, type Fixtures } from "../../demo/fixtures.js";
import type { SimulatedOfferInput } from "../../domain/rules.js";
import { simulateAction, simulateCreate } from "./simulate.js";

export { REQUEST_TTL_MS } from "../repository.js";
export { SYNC_STALE_AFTER_SECONDS } from "../../domain/views.js";
export const MAX_MOCK_REQUESTS = 100;

const lower = (address: string): Address => address.toLowerCase() as Address;

function paginate<T>(items: T[], page: Page): Paged<T> {
  return {
    items: items.slice(page.offset, page.offset + page.limit),
    limit: page.limit,
    offset: page.offset,
    total: items.length,
  };
}

/** Estado fictício por instância; intenções não confirmam nada e comandos de
 * demonstração atualizam apenas as projeções em memória. */
export class InMemoryRepository implements Repository {
  readonly source = "mock" as const;
  #data: Fixtures;
  readonly #newId: () => string;
  readonly #now: () => Date;
  #requests: TransactionRequestRecord[] = [];

  constructor(now: () => Date, newId: () => string = randomUUID) {
    this.#newId = newId;
    this.#now = now;
    this.#data = createFixtures(now());
  }

  // -------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------

  deployment() {
    return deploymentView(this.#data.deployment);
  }

  syncStatus() {
    return syncStatusView(
      this.#data.deployment,
      this.#data.syncCursor,
      this.#now(),
    );
  }

  listOffers(filter: OfferFilter, page: Page) {
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

  listCreditLimits(filter: CreditLimitFilter) {
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

  createSimulatedOffer(input: SimulatedOfferInput) {
    const result = simulateCreate(this.#data, this.#now(), this.#newId, input);
    this.#data = result.data;
    return { offer: this.#offerView(result.offer), operation: null };
  }

  simulatedOfferAction(id: string, action: "accept" | "reject" | "cancel") {
    const result = simulateAction(this.#data, this.#now(), id, action);
    this.#data = result.data;
    return {
      offer: this.#offerView(result.offer),
      operation:
        result.settlement === null
          ? null
          : this.#operationView(result.offer, result.settlement),
    };
  }

  // -------------------------------------------------------------------
  // Intenções
  // -------------------------------------------------------------------

  createOfferIntent(requesterWallet: string, input: OfferIntentInput) {
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
    if (amount > UINT256_MAX) throw problems.invalidAmount();
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
    const updated: TransactionRequestRecord = {
      ...request,
      status: "submitted",
      txHash: hash,
      submittedAt: this.#now(),
    };
    this.#requests = this.#requests.map((item) =>
      item.id === request.id ? updated : item,
    );
    return this.#requestView(updated);
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
    return liveRequestStatus(request, this.#now());
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
    if (this.#requests.length >= MAX_MOCK_REQUESTS)
      throw problems.requestStoreFull();
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
    this.#requests = [...this.#requests, request];
    return request;
  }

  async check(): Promise<void> {}

  async close(): Promise<void> {}

  #context(): ViewContext {
    return {
      deployment: this.#data.deployment,
      now: this.#now(),
      party: (address) => this.#party(address),
    };
  }

  #party(address: Address) {
    const state = this.#data.wallets.find((item) => item.wallet === address);
    const institution =
      state?.institutionId === undefined || state.institutionId === null
        ? undefined
        : this.#data.institutions.find(
            (item) => item.id === state.institutionId,
          );
    return party(address, institution);
  }

  #offerView(offer: OfferRecord) {
    return offerView(
      this.#context(),
      offer,
      this.#data.settlements.find((item) => item.offerId === offer.id),
    );
  }

  #operationView(offer: OfferRecord, settlement: SettlementRecord) {
    return operationView(this.#context(), offer, settlement);
  }

  #eventView = eventView;

  #creditLimitView(state: WalletState) {
    return creditLimitView(state, this.#party(state.wallet));
  }

  #creditLimitChangeView = creditLimitChangeView;

  #requestView(request: TransactionRequestRecord) {
    const offer =
      request.offerId === null
        ? undefined
        : this.#data.offers.find((item) => item.id === request.offerId);
    return requestView(this.#context(), request, offer?.onchainOfferId);
  }
}
