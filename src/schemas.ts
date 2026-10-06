import {
  chainEventNames,
  offerStatuses,
  transactionActions,
  transactionStatuses,
} from "./domain.js";
import { problemSchema } from "./problem.js";

/**
 * Esquemas JSON compartilhados. Cada um com `$id` vira um componente em
 * `components.schemas` do OpenAPI e é referenciado como `{ $ref: "Nome#" }`.
 */

export const patterns = {
  address: "^0x[0-9a-fA-F]{40}$",
  cents: "^(0|[1-9][0-9]{0,77})$",
  positiveCents: "^[1-9][0-9]{0,77}$",
  txHash: "^0x[0-9a-fA-F]{64}$",
  uuid: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
} as const;

const address = (description: string) =>
  ({ description, pattern: patterns.address, type: "string" }) as const;
const txHash = (description: string) =>
  ({ description, pattern: patterns.txHash, type: "string" }) as const;
const cents = (description: string) =>
  ({
    description: `${description} Centavos de BRLt como string decimal (uint256).`,
    pattern: patterns.cents,
    type: "string",
  }) as const;
const dateTime = (description: string) =>
  ({ description, format: "date-time", type: "string" }) as const;
const uuid = (description: string) =>
  ({ description, pattern: patterns.uuid, type: "string" }) as const;

const institutionSchema = {
  additionalProperties: false,
  description: "Banco dono da carteira. Dado apenas off-chain.",
  nullable: true,
  properties: {
    id: uuid("Id interno da instituição."),
    name: { description: "Nome de exibição.", type: "string" },
  },
  required: ["id", "name"],
  type: "object",
} as const;

const partySchema = {
  $id: "Party",
  additionalProperties: false,
  description:
    "Parte de uma oferta: carteira on-chain e, se houver vínculo cadastrado, a instituição.",
  properties: {
    institution: institutionSchema,
    wallet: address("Carteira em hexadecimal minúsculo."),
  },
  required: ["wallet", "institution"],
  type: "object",
} as const;

const offerSchema = {
  $id: "Offer",
  additionalProperties: false,
  description:
    "Oferta fictícia nesta versão; esquema previsto para uma projeção on-chain futura.",
  properties: {
    amountCents: cents("Valor emprestado."),
    borrower: { $ref: "Party#" },
    chainId: {
      description: "Id da rede (11155111 = Sepolia).",
      type: "integer",
    },
    contractAddress: address("Contrato CreditInterbankOffer."),
    createTxHash: txHash("Transação que criou a oferta."),
    createdAt: dateTime("Horário do bloco de criação."),
    createdBlock: { type: "integer" },
    expiresAt: dateTime("Fim da janela para aceitar, rejeitar ou cancelar."),
    id: uuid("Id da oferta na API."),
    lender: { $ref: "Party#" },
    onchainOfferId: {
      description: "offerId do contrato (uint256 como string).",
      pattern: patterns.positiveCents,
      type: "string",
    },
    onchainStatusCode: {
      description:
        "Status persistido no contrato: 0 Offered, 2 Settled, 3 Cancelled, 4 Expired, 5 Rejected.",
      enum: [0, 2, 3, 4, 5],
      type: "integer",
    },
    rateCdiBps: {
      description: "Percentual do CDI em pontos-base (10500 = 105% do CDI).",
      type: "integer",
    },
    settlement: {
      additionalProperties: false,
      description: "Liquidação DvP; null enquanto a oferta não foi liquidada.",
      nullable: true,
      properties: {
        blockNumber: { type: "integer" },
        positionTokenId: {
          description: "tokenId do NFT de posição (igual a onchainOfferId).",
          type: "string",
        },
        settledAt: dateTime("Horário do bloco da liquidação."),
        txHash: txHash("Transação de aceite e liquidação."),
      },
      required: ["txHash", "blockNumber", "positionTokenId", "settledAt"],
      type: "object",
    },
    status: {
      description:
        "Status apresentado. Uma oferta offered cujo expiresAt passou aparece como expired, mesmo sem OfferExpired on-chain (compare com onchainStatusCode).",
      enum: [...offerStatuses],
      type: "string",
    },
    termDays: { description: "Prazo do empréstimo em dias.", type: "integer" },
  },
  required: [
    "id",
    "onchainOfferId",
    "chainId",
    "contractAddress",
    "lender",
    "borrower",
    "amountCents",
    "rateCdiBps",
    "termDays",
    "status",
    "onchainStatusCode",
    "createdAt",
    "expiresAt",
    "createTxHash",
    "createdBlock",
    "settlement",
  ],
  type: "object",
} as const;

const chainEventSchema = {
  $id: "ChainEvent",
  additionalProperties: false,
  description:
    "Evento fictício nesta versão; estrutura prevista para logs indexados.",
  properties: {
    args: {
      additionalProperties: { type: "string" },
      description:
        "Argumentos do evento como vieram do ABI; inteiros e endereços como string.",
      type: "object",
    },
    blockHash: txHash("Hash do bloco."),
    blockNumber: { type: "integer" },
    blockTimestamp: dateTime("Horário do bloco."),
    eventName: { enum: [...chainEventNames], type: "string" },
    logIndex: { type: "integer" },
    offerId: {
      ...uuid("Oferta relacionada; null em eventos de cadastro e limite."),
      nullable: true,
    },
    txHash: txHash("Transação que emitiu o log."),
  },
  required: [
    "eventName",
    "txHash",
    "logIndex",
    "blockNumber",
    "blockHash",
    "blockTimestamp",
    "offerId",
    "args",
  ],
  type: "object",
} as const;

export const operationSchema = {
  $id: "Operation",
  additionalProperties: false,
  description:
    "Comprovante fictício nesta versão: hash e bloco sintéticos, sem prova on-chain.",
  properties: {
    amountCents: cents("Valor liquidado."),
    blockHash: txHash("Hash do bloco da liquidação."),
    blockNumber: { type: "integer" },
    borrower: { $ref: "Party#" },
    chainId: { type: "integer" },
    contractAddress: address("Contrato CreditInterbankOffer."),
    explorerUrl: {
      description: "Link da transação no Etherscan da Sepolia.",
      type: "string",
    },
    lender: { $ref: "Party#" },
    offerId: uuid("Oferta liquidada."),
    onchainOfferId: { type: "string" },
    positionTokenId: {
      description: "tokenId do NFT CDIP emitido ao ofertante.",
      type: "string",
    },
    rateCdiBps: { type: "integer" },
    settledAt: dateTime("Horário do bloco da liquidação."),
    termDays: { type: "integer" },
    txHash: txHash("Transação de aceite e liquidação."),
  },
  required: [
    "txHash",
    "offerId",
    "onchainOfferId",
    "chainId",
    "contractAddress",
    "lender",
    "borrower",
    "amountCents",
    "rateCdiBps",
    "termDays",
    "positionTokenId",
    "blockNumber",
    "blockHash",
    "settledAt",
    "explorerUrl",
  ],
  type: "object",
} as const;

const creditLimitSchema = {
  $id: "CreditLimit",
  additionalProperties: false,
  description:
    "Limite fictício nesta versão; futuro espelho de availableLimit().",
  properties: {
    availableLimitCents: cents("Limite disponível para tomar."),
    institution: institutionSchema,
    isRegistered: {
      description: "Carteira autorizada no contrato (INSTITUTION_ROLE).",
      type: "boolean",
    },
    observedAt: dateTime("Quando o listener observou este valor."),
    observedBlock: { type: "integer" },
    wallet: address("Carteira em hexadecimal minúsculo."),
  },
  required: [
    "wallet",
    "institution",
    "isRegistered",
    "availableLimitCents",
    "observedBlock",
    "observedAt",
  ],
  type: "object",
} as const;

const creditLimitChangeSchema = {
  $id: "CreditLimitChange",
  additionalProperties: false,
  description:
    "Mudança de limite: ajuste do admin (CreditLimitUpdated) ou débito da liquidação (OfferSettled).",
  properties: {
    blockTimestamp: dateTime("Horário do bloco."),
    changeKind: { enum: ["admin_update", "settlement"], type: "string" },
    logIndex: { type: "integer" },
    newLimitCents: cents("Limite depois da mudança."),
    offerId: {
      ...uuid("Oferta que consumiu o limite; null em admin_update."),
      nullable: true,
    },
    previousLimitCents: cents("Limite antes da mudança."),
    txHash: txHash("Transação de origem."),
  },
  required: [
    "changeKind",
    "previousLimitCents",
    "newLimitCents",
    "offerId",
    "txHash",
    "logIndex",
    "blockTimestamp",
  ],
  type: "object",
} as const;

const transactionRequestSchema = {
  $id: "TransactionRequest",
  additionalProperties: false,
  description:
    "Intenção registrada pela API antes da assinatura. O frontend usa contractCall para montar a transação na carteira e depois informa o hash.",
  properties: {
    action: { enum: [...transactionActions], type: "string" },
    contractCall: {
      additionalProperties: false,
      description: "Chamada pronta para writeContract (viem/wagmi).",
      properties: {
        args: {
          description:
            "Argumentos na ordem do ABI. uint256 como string decimal: converta com BigInt().",
          items: { type: "string" },
          type: "array",
        },
        chainId: { type: "integer" },
        contractAddress: address("Contrato a chamar."),
        functionName: {
          enum: ["createOffer", "acceptOffer", "rejectOffer", "cancelOffer"],
          type: "string",
        },
      },
      required: ["chainId", "contractAddress", "functionName", "args"],
      type: "object",
    },
    createdAt: dateTime("Criação da intenção."),
    expiresAt: dateTime(
      "Prazo para informar o hash; depois disso fica expired.",
    ),
    failureCode: {
      description:
        "Motivo da falha informado pelo listener; null se não falhou.",
      nullable: true,
      type: "string",
    },
    id: uuid("Id da intenção."),
    offerId: {
      ...uuid("Oferta alvo; null em create_offer."),
      nullable: true,
    },
    params: {
      additionalProperties: false,
      description: "Parâmetros de create_offer; null nas outras ações.",
      nullable: true,
      properties: {
        amountCents: cents("Valor ofertado."),
        borrowerWallet: address("Tomador."),
        rateCdiBps: { type: "integer" },
        termDays: { type: "integer" },
        validitySeconds: { type: "integer" },
      },
      required: [
        "borrowerWallet",
        "amountCents",
        "rateCdiBps",
        "termDays",
        "validitySeconds",
      ],
      type: "object",
    },
    requesterWallet: address("Carteira que vai assinar."),
    status: {
      description:
        "pending: aguardando hash. submitted: hash recebido. confirmed/failed: definidos pelo listener. expired: hash não chegou a tempo.",
      enum: [...transactionStatuses],
      type: "string",
    },
    submittedAt: {
      ...dateTime("Quando o hash foi informado."),
      nullable: true,
    },
    txHash: { ...txHash("Hash informado pelo frontend."), nullable: true },
  },
  required: [
    "id",
    "action",
    "status",
    "requesterWallet",
    "offerId",
    "params",
    "txHash",
    "createdAt",
    "expiresAt",
    "submittedAt",
    "failureCode",
    "contractCall",
  ],
  type: "object",
} as const;

const deploymentSchema = {
  $id: "Deployment",
  additionalProperties: false,
  description:
    "Endereços sintéticos de fixtures, não implantação verificada na Sepolia.",
  properties: {
    brlTokenAddress: address("ERC-20 BRLt (2 casas decimais)."),
    chainId: { type: "integer" },
    contractAddress: address("CreditInterbankOffer."),
    explorerUrl: { type: "string" },
    network: { enum: ["sepolia"], type: "string" },
    positionTokenAddress: address("ERC-721 CDIP (posição de crédito)."),
    startBlock: {
      description: "Bloco a partir do qual o listener indexa.",
      type: "integer",
    },
  },
  required: [
    "chainId",
    "network",
    "contractAddress",
    "brlTokenAddress",
    "positionTokenAddress",
    "startBlock",
    "explorerUrl",
  ],
  type: "object",
} as const;

const syncStatusSchema = {
  $id: "SyncStatus",
  additionalProperties: false,
  description:
    "Cursor fictício nesta versão; não indica sincronização real de listener.",
  properties: {
    chainId: { type: "integer" },
    contractAddress: address("Contrato sincronizado."),
    lagSeconds: {
      description: "Segundos desde a última sincronização.",
      type: "integer",
    },
    lastProcessedBlock: { type: "integer" },
    lastProcessedBlockHash: txHash("Hash do último bloco processado."),
    lastSyncedAt: dateTime("Última sincronização."),
    stale: {
      description: "true quando lagSeconds passa de 60.",
      type: "boolean",
    },
  },
  required: [
    "chainId",
    "contractAddress",
    "lastProcessedBlock",
    "lastProcessedBlockHash",
    "lastSyncedAt",
    "lagSeconds",
    "stale",
  ],
  type: "object",
} as const;

const metaSchema = {
  $id: "Meta",
  additionalProperties: false,
  description: "Metadados. source=mock indica dado fictício.",
  properties: { source: { enum: ["mock"], type: "string" } },
  required: ["source"],
  type: "object",
} as const;

const listMetaSchema = {
  $id: "ListMeta",
  additionalProperties: false,
  description: "Metadados de lista paginada.",
  properties: {
    limit: { type: "integer" },
    offset: { type: "integer" },
    source: { enum: ["mock"], type: "string" },
    total: {
      description: "Total de itens com os filtros aplicados.",
      type: "integer",
    },
  },
  required: ["source", "total", "limit", "offset"],
  type: "object",
} as const;

export const sharedSchemas = [
  problemSchema,
  partySchema,
  offerSchema,
  chainEventSchema,
  operationSchema,
  creditLimitSchema,
  creditLimitChangeSchema,
  transactionRequestSchema,
  deploymentSchema,
  syncStatusSchema,
  metaSchema,
  listMetaSchema,
] as const;

// ---------------------------------------------------------------------
// Blocos reutilizados pelas rotas
// ---------------------------------------------------------------------

export const problemRef = { $ref: "Problem#" } as const;

export function dataEnvelope(data: unknown) {
  return {
    additionalProperties: false,
    properties: { data, meta: { $ref: "Meta#" } },
    required: ["data", "meta"],
    type: "object",
  } as const;
}

export function listEnvelope(itemRef: string) {
  return {
    additionalProperties: false,
    properties: {
      data: { items: { $ref: `${itemRef}#` }, type: "array" },
      meta: { $ref: "ListMeta#" },
    },
    required: ["data", "meta"],
    type: "object",
  } as const;
}

export const paginationProperties = {
  limit: {
    default: 50,
    description: "Itens por página (1 a 100).",
    maximum: 100,
    minimum: 1,
    type: "integer",
  },
  offset: {
    default: 0,
    description: "Itens a pular.",
    minimum: 0,
    type: "integer",
  },
} as const;

export const walletHeaderSchema = {
  properties: {
    "x-wallet-address": {
      description:
        "Carteira autodeclarada do solicitante da intenção em development/test; não autentica posse da chave.",
      pattern: patterns.address,
      type: "string",
    },
  },
  required: ["x-wallet-address"],
  type: "object",
} as const;

export const offerIdParams = {
  additionalProperties: false,
  properties: { id: uuid("Id da oferta na API.") },
  required: ["id"],
  type: "object",
} as const;

export const walletParams = {
  additionalProperties: false,
  properties: { wallet: address("Carteira (qualquer caixa).") },
  required: ["wallet"],
  type: "object",
} as const;

export const txHashParams = {
  additionalProperties: false,
  properties: { txHash: txHash("Hash da transação de liquidação.") },
  required: ["txHash"],
  type: "object",
} as const;

export const requestIdParams = {
  additionalProperties: false,
  properties: { id: uuid("Id da intenção.") },
  required: ["id"],
  type: "object",
} as const;

export const errorResponses = (...codes: number[]) =>
  Object.fromEntries(
    [...new Set([...codes, 500])].map((code) => [code, problemRef]),
  );
