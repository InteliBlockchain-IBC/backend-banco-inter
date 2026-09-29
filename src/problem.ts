export type Problem = Readonly<{
  correlationId: string;
  detail: string;
  status: number;
  title: string;
  type: string;
}>;

export const PROBLEM_BASE_URI = "https://api.example.invalid/problems/";

export const problemSchema = {
  $id: "Problem",
  additionalProperties: false,
  description:
    "Erro no formato RFC 9457 (Problem Details), servido como application/problem+json.",
  properties: {
    correlationId: {
      description: "Id da requisição, igual ao registrado no log do servidor.",
      type: "string",
    },
    detail: { description: "Explicação legível do erro.", type: "string" },
    status: { description: "Código HTTP repetido no corpo.", type: "integer" },
    title: { description: "Resumo curto e estável do erro.", type: "string" },
    type: {
      description: `URI estável do tipo de erro. Os tipos possíveis estão em docs/api.md; todos começam com ${PROBLEM_BASE_URI}.`,
      type: "string",
    },
  },
  required: ["type", "title", "status", "detail", "correlationId"],
  type: "object",
} as const;

export function createProblem(
  correlationId: string,
  status: number,
  title: string,
  detail: string,
  type: string,
): Problem {
  return { correlationId, detail, status, title, type };
}

/**
 * Erro de negócio lançado pelas rotas e convertido em Problem Details pelo
 * error handler. `slug` vira o final da URI `type`.
 */
export class ApiProblem extends Error {
  readonly slug: string;
  readonly status: number;
  readonly title: string;

  constructor(status: number, slug: string, title: string, detail: string) {
    super(detail);
    this.name = "ApiProblem";
    this.slug = slug;
    this.status = status;
    this.title = title;
  }
}

export const problems = {
  duplicateTransaction: (txHash: string) =>
    new ApiProblem(
      409,
      "duplicate-transaction",
      "Hash de transação já registrado",
      `O hash ${txHash} já está associado a outra intenção.`,
    ),
  forbiddenNotBorrower: () =>
    new ApiProblem(
      403,
      "not-eligible-borrower",
      "Carteira não é a tomadora",
      "Somente a carteira tomadora indicada na oferta pode aceitá-la ou rejeitá-la.",
    ),
  forbiddenNotLender: () =>
    new ApiProblem(
      403,
      "not-offer-owner",
      "Carteira não é a ofertante",
      "Somente a carteira ofertante pode cancelar a oferta.",
    ),
  forbiddenNotRequester: () =>
    new ApiProblem(
      403,
      "not-request-owner",
      "Carteira não é a solicitante",
      "Somente a carteira que criou a intenção pode informar o hash da transação.",
    ),
  insufficientLimit: (available: bigint, requested: bigint) =>
    new ApiProblem(
      422,
      "insufficient-limit",
      "Limite insuficiente",
      `O tomador tem ${available} centavos de limite disponível e a oferta pede ${requested}.`,
    ),
  invalidCounterparty: () =>
    new ApiProblem(
      422,
      "invalid-counterparty",
      "Contraparte inválida",
      "A carteira tomadora não pode ser a mesma da ofertante.",
    ),
  invalidOfferStatus: (status: string) =>
    new ApiProblem(
      409,
      "invalid-offer-status",
      "Estado da oferta não permite a ação",
      `A oferta está ${status}; a ação exige uma oferta em offered.`,
    ),
  invalidRequestStatus: (status: string) =>
    new ApiProblem(
      409,
      "invalid-request-status",
      "Estado da intenção não permite a ação",
      `A intenção está ${status}; só intenções pending recebem hash.`,
    ),
  notFound: (what: string) =>
    new ApiProblem(
      404,
      "not-found",
      "Recurso não encontrado",
      `${what} não existe.`,
    ),
  notRegistered: (role: "requester" | "counterparty") =>
    new ApiProblem(
      role === "requester" ? 403 : 422,
      "not-registered-institution",
      "Carteira não cadastrada",
      role === "requester"
        ? "A carteira informada em X-Wallet-Address não está autorizada no contrato."
        : "A carteira da contraparte não está autorizada no contrato.",
    ),
  offerExpired: () =>
    new ApiProblem(
      409,
      "offer-expired",
      "Oferta vencida",
      "A janela de validade da oferta terminou; ela não pode mais ser aceita, rejeitada ou cancelada.",
    ),
  requestExpired: () =>
    new ApiProblem(
      409,
      "request-expired",
      "Intenção vencida",
      "A intenção expirou antes de receber o hash; crie uma nova.",
    ),
  requestInProgress: (requestId: string) =>
    new ApiProblem(
      409,
      "request-in-progress",
      "Já existe uma intenção em andamento",
      `A intenção ${requestId} para esta ação ainda está pending ou submitted.`,
    ),
} as const;
