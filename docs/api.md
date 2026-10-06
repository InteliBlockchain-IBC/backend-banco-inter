# API — referência HTTP (v0.4.0)

Contrato da API para a PoC. Com `DATABASE_URL`, leituras, intenções e simulações usam o **PostgreSQL** (`X-Data-Source: postgres`); sem ela, em `development`/`test`, usam fixtures em memória (`X-Data-Source: mock`). O payload é o mesmo nas duas fontes. Ainda **não há RPC nem listener**: os dados do banco vêm do seed de demonstração e da simulação, com hashes e endereços sintéticos. O payload de integração real poderá mudar após autenticação e validação com o frontend/Web3. `production` registra apenas GETs; a coleção e o OpenAPI exportados representam `development`.

| Artefato | Para quê |
| --- | --- |
| [`docs/openapi.json`](openapi.json) | Contrato OpenAPI 3.0 (gerar tipos, validar) |
| [`docs/collection/backend-banco-inter.postman_collection.json`](collection/backend-banco-inter.postman_collection.json) | Coleção Postman v2.1 com exemplos reais de sucesso e erro |
| `GET /docs` | Swagger UI com a API rodando |
| `GET /openapi.json` | O mesmo contrato servido pela aplicação |

Os arquivos são gerados pela própria API (`npm run docs:export` no ambiente `development`). Um teste compara o OpenAPI exportado ao servido nesse ambiente e verifica a cobertura de rotas pela coleção.

**Alinhamento preliminar:** contrato `CreditInterbankOffer` da branch `feat/escopo-reduzido-dvp` do repositório de contratos (commit `b68cf40`) e esquema de [`migrations/001_initial_schema.sql`](../migrations/001_initial_schema.sql). A ABI final e o deploy não foram verificados.

---

## Sumário

1. [Como a API funciona](#1-como-a-api-funciona)
2. [Convenções](#2-convenções)
3. [Erros](#3-erros)
4. [Rotas](#4-rotas)
5. [Recursos](#5-recursos)
6. [Estados](#6-estados)
7. [Massa de dados mock](#7-massa-de-dados-mock)
8. [Usando a coleção](#8-usando-a-coleção)
9. [O que muda quando os mocks saírem](#9-o-que-muda-quando-os-mocks-saírem)

---

## 1. Como a API funciona

A API não assina nem envia transações. Os GETs leem a projeção (seed sintético mais o que foi simulado). Dois fluxos distintos só existem em `development`/`test`:

- **`POST /api/mock/offers...`** grava ofertas, eventos, liquidação, débito de limite, histórico e cursor **numa única transação** na fonte de dados ativa, com hashes e blocos sintéticos. No PostgreSQL isso persiste entre reinícios. `lenderWallet` é autodeclarado; estas rotas não autentificam carteira nem substituem uma transação.
- **`POST /api/offers...`** devolve uma intenção `pending` e `contractCall`; `POST .../submission` só registra o hash informado pelo chamador. Essas ações **não** criam, liquidam ou alteram ofertas. Sem listener, intenções `submitted` não chegam a `confirmed` e as listas não são atualizadas.

O fluxo de carteira, contrato e listener é **arquitetura alvo**, não comportamento implementado nesta versão; a persistência em PostgreSQL já está implementada. Uma integração futura exige autorização de carteira/instituição e verificação do ABI/endereço implantado antes de construir qualquer chamada real. Não use os endereços/hash das fixtures para enviar uma transação. Na execução on-chain, o ofertante precisará ter BRLt e allowance suficientes; o backend não checa saldo nem aprovação.

---

## 2. Convenções

### Envelope

Toda resposta 2xx de `/api/*` tem o cabeçalho `X-Data-Source` e este formato:

```json
{ "data": { }, "meta": { "source": "postgres" } }
```

`source` é `postgres` (persistido no banco) ou `mock` (memória da instância, só em `development`/`test` sem `DATABASE_URL`). Os exemplos abaixo mostram `mock`; o resto do corpo é idêntico.

Listas paginadas (`/api/offers`, `/api/operations`) trazem também `total`, `limit` e `offset` em `meta`. As outras listas vêm inteiras.

Respostas de erro **não** têm envelope nem `X-Data-Source` (veja [Erros](#3-erros)).

### Tipos e unidades

| Campo | Formato | Exemplo |
| --- | --- | --- |
| `*Cents` | string decimal, centavos de BRLt (uint256) | `"100000000"` = R$ 1.000.000,00 |
| `rateCdiBps` | inteiro, pontos-base do CDI | `10500` = 105% do CDI |
| `termDays` | inteiro, prazo do empréstimo em dias | `1` = overnight |
| `validitySeconds` | inteiro, janela da oferta em segundos | `3600` |
| `onchainOfferId`, `positionTokenId` | string decimal (uint256) | `"8"` |
| carteira / endereço | `0x` + 40 hex; a API aceita qualquer caixa e devolve minúsculo | `0xa1a1…a1` |
| `txHash`, `blockHash` | `0x` + 64 hex | |
| ids da API | UUID | `a0000000-0000-4000-8000-000000000008` |
| datas | ISO 8601 em UTC | `2026-09-29T12:00:00.000Z` |

**Por que valores em string?** Inteiros do contrato são uint256 e passam de `Number.MAX_SAFE_INTEGER`. Converta com `BigInt(valor)`. Para exibir: `(BigInt(c) / 100n)` reais e `c % 100n` centavos, ou `Number(c) / 100` se o valor couber. `amountCents` enviado como número no corpo é recusado com 400.

### Identificação da carteira

Só os POSTs de **intenção** exigem `X-Wallet-Address`; trata-se de texto autodeclarado, não prova de posse da chave nem controle de acesso. As rotas `/api/mock` não recebem identidade: exercitam somente transições fictícias. Todos os POSTs retornam 404 e são omitidos do OpenAPI servido em `production`. Nunca exponha esses comandos como API financeira real.

### Paginação

`limit` (1 a 100, padrão 50) e `offset` (padrão 0). Ordem: mais recente primeiro.

### Validação

Parâmetros desconhecidos em query ou corpo dão 400, e não são ignorados. Corpo JSON limitado a 16 KiB.

---

## 3. Erros

Formato [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457), `Content-Type: application/problem+json`:

```json
{
  "type": "https://api.example.invalid/problems/insufficient-limit",
  "title": "Limite insuficiente",
  "status": 422,
  "detail": "O tomador tem 15000000000 centavos de limite disponível e a oferta pede 99900000000.",
  "correlationId": "req-e"
}
```

Use `type` (ou o final dele) para decidir o que mostrar; `detail` é texto para pessoas e pode mudar. `correlationId` é o id da requisição no log.

| Status | `type` (final da URI) | Quando |
| --- | --- | --- |
| 400 | `validation-error`, `invalid-amount`, `invalid-expiry`, `invalid-counterparty` | Schema inválido, valor acima de uint256, data fora do alcance do simulador ou partes iguais/nulas |
| 403 | `not-registered-institution`, `not-eligible-borrower`, `not-offer-owner`, `not-request-owner` | **Somente intenção:** carteira declarada não satisfaz a checagem feita sobre as fixtures; não comprova identidade |
| 404 | `not-found` | Recurso/rota inexistente, inclusive qualquer POST em `production` |
| 409 | `invalid-offer-status`, `offer-expired`, `request-in-progress`, `invalid-request-status`, `request-expired`, `duplicate-transaction` | Estado terminal, vencimento ou duplicidade |
| 422 | `not-registered-institution`, `invalid-counterparty`, `insufficient-limit` | Contraparte não cadastrada ou limite fictício insuficiente |
| 503 | `database-unavailable`, `deployment-not-configured` | PostgreSQL fora do ar (`/ready`) ou banco sem deployment: rode `npm run db:setup` |
| 503 | `mock-store-full`, `request-store-full` | **Só memória:** máximo de 100 ofertas (incluindo fixtures) ou 100 intenções por instância |
| 500 | `internal-error` | Falha inesperada sem detalhes internos |

As validações de intenção evitam erros evidentes, mas não provam autorização ou sucesso de uma transação. Na simulação, um conflito ou erro não altera eventos, limite ou estado.

---

## 4. Rotas

| Método | Caminho | Descrição | Sucesso |
| --- | --- | --- | --- |
| GET | `/api/deployment` | Endereços sintéticos das fixtures | 200 `Deployment` |
| GET | `/api/sync-status` | Cursor da projeção, avançado pela simulação (sem listener) | 200 `SyncStatus` |
| GET | `/api/offers` | Listar ofertas | 200 `Offer[]` paginado |
| POST | `/api/offers` | Intenção de criar oferta | 202 `TransactionRequest` |
| GET | `/api/offers/{id}` | Detalhar oferta | 200 `Offer` |
| GET | `/api/offers/{id}/events` | Histórico sintético da oferta | 200 `ChainEvent[]` |
| POST | `/api/offers/{id}/accept` | Intenção de aceitar | 202 `TransactionRequest` |
| POST | `/api/offers/{id}/reject` | Intenção de rejeitar | 202 `TransactionRequest` |
| POST | `/api/offers/{id}/cancel` | Intenção de cancelar | 202 `TransactionRequest` |
| GET | `/api/transaction-requests/{id}` | Consultar intenção | 200 `TransactionRequest` |
| POST | `/api/transaction-requests/{id}/submission` | Informar hash assinado | 200 `TransactionRequest` |
| POST | `/api/mock/offers` | Criação de oferta fictícia no store | 201 `{ offer, operation: null }` |
| POST | `/api/mock/offers/{id}/accept` | Aceite e liquidação fictícios atômicos | 200 `{ offer, operation }` |
| POST | `/api/mock/offers/{id}/reject` | Rejeição fictícia | 200 `{ offer, operation: null }` |
| POST | `/api/mock/offers/{id}/cancel` | Cancelamento fictício | 200 `{ offer, operation: null }` |
| GET | `/api/operations` | Operações liquidadas | 200 `Operation[]` paginado |
| GET | `/api/operations/{txHash}` | Comprovante da operação | 200 `Operation` |
| GET | `/api/credit-limits` | Limites por carteira | 200 `CreditLimit[]` |
| GET | `/api/credit-limits/{wallet}` | Limite de uma carteira | 200 `CreditLimit` |
| GET | `/api/credit-limits/{wallet}/history` | Histórico de limite | 200 `CreditLimitChange[]` |
| GET | `/health` | Liveness | 200 |
| GET | `/ready` | Readiness | 200 |
| GET | `/openapi.json` | Contrato OpenAPI | 200 |
| GET | `/docs` | Swagger UI | 200 |

### Rede

#### `GET /api/deployment`

Endereços sintéticos de fixtures e `chainId` ficticiamente marcado como 11155111 (Sepolia). **Não use para montar chamadas reais nem para inferir que os contratos foram implantados.**

```json
{
  "data": {
    "chainId": 11155111,
    "network": "sepolia",
    "contractAddress": "0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c",
    "brlTokenAddress": "0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
    "positionTokenAddress": "0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e",
    "startBlock": 9128000,
    "explorerUrl": "https://sepolia.etherscan.io/address/0x0c0c…0c"
  },
  "meta": { "source": "mock" }
}
```

#### `GET /api/sync-status`

Bloco e atraso **sintéticos**, sem listener. `stale` só reflete tempo decorrido desde o cursor fictício; não monitora a Sepolia nem prova atualização da API.

```json
{
  "data": {
    "chainId": 11155111,
    "contractAddress": "0x0c0c…0c",
    "lastProcessedBlock": 9199999,
    "lastProcessedBlockHash": "0xb000…617f",
    "lastSyncedAt": "2026-09-29T11:59:56.000Z",
    "lagSeconds": 4,
    "stale": false
  },
  "meta": { "source": "mock" }
}
```

### Ofertas

#### `GET /api/offers`

| Query | Tipo | Descrição |
| --- | --- | --- |
| `status` | `offered` \| `settled` \| `cancelled` \| `expired` \| `rejected` | Status apresentado |
| `wallet` | endereço | Só ofertas em que a carteira é parte |
| `role` | `lender` \| `borrower` \| `any` (padrão) | Lado da carteira; só vale com `wallet` |
| `limit`, `offset` | inteiros | Paginação |

Receitas úteis:

- ofertas abertas recebidas pelo meu banco: `?status=offered&wallet=<minha>&role=borrower`
- ofertas que eu fiz: `?wallet=<minha>&role=lender`

Resposta: `data` é `Offer[]`, `meta` tem `total`, `limit`, `offset`.

#### `GET /api/offers/{id}`

Uma `Offer`. Exemplo de oferta aberta:

```json
{
  "data": {
    "id": "a0000000-0000-4000-8000-000000000008",
    "onchainOfferId": "8",
    "chainId": 11155111,
    "contractAddress": "0x0c0c…0c",
    "lender": {
      "wallet": "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      "institution": { "id": "b0000000-0000-4000-8000-000000000001", "name": "Banco Alfa S.A. (fictício)" }
    },
    "borrower": {
      "wallet": "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
      "institution": { "id": "b0000000-0000-4000-8000-000000000002", "name": "Banco Beta S.A. (fictício)" }
    },
    "amountCents": "4000000000",
    "rateCdiBps": 10500,
    "termDays": 1,
    "status": "offered",
    "onchainStatusCode": 0,
    "createdAt": "2026-09-29T11:50:00.000Z",
    "expiresAt": "2026-09-29T12:50:00.000Z",
    "createTxHash": "0x7000…0017",
    "createdBlock": 9199950,
    "settlement": null
  },
  "meta": { "source": "mock" }
}
```

Em oferta liquidada, `settlement` vem preenchido:

```json
"settlement": {
  "txHash": "0x7000…000b",
  "blockNumber": 9178460,
  "positionTokenId": "1",
  "settledAt": "2026-09-26T12:12:00.000Z"
}
```

Erros: 400 (id não é UUID), 404.

#### `GET /api/offers/{id}/events`

Histórico fictício da oferta em ordem de bloco e `logIndex`. Na simulação do aceite, `OfferAccepted` e `OfferSettled` compartilham o mesmo hash sintético (logs 0 e 1); `args` usa strings.

```json
{
  "data": [
    { "eventName": "OfferCreated",  "logIndex": 0, "txHash": "0x…0a", "args": { "offerId": "1", "lender": "0xa1…", "borrower": "0xb2…", "amount": "5000000000", "rateCDI": "10250", "term": "1", "expiresAt": "1790427600" }, "…": "…" },
    { "eventName": "OfferAccepted", "logIndex": 0, "txHash": "0x…0b", "args": { "offerId": "1", "borrower": "0xb2…", "timestamp": "1790424720" }, "…": "…" },
    { "eventName": "OfferSettled",  "logIndex": 1, "txHash": "0x…0b", "args": { "offerId": "1", "positionTokenId": "1", "…": "…" }, "…": "…" }
  ],
  "meta": { "source": "mock" }
}
```

Erros: 400, 404.

#### `POST /api/offers`

Intenção de criar uma oferta **direcionada**. Cabeçalho `X-Wallet-Address` = carteira do ofertante.

| Campo | Tipo | Regra |
| --- | --- | --- |
| `borrowerWallet` | endereço | Cadastrado, diferente do ofertante |
| `amountCents` | string | Inteiro > 0 em string; ≤ limite disponível do tomador |
| `rateCdiBps` | inteiro | 1 a 100000 |
| `termDays` | inteiro | 1 a 365 |
| `validitySeconds` | inteiro | 60 a 86400 |

```json
{
  "borrowerWallet": "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  "amountCents": "100000000",
  "rateCdiBps": 10500,
  "termDays": 1,
  "validitySeconds": 3600
}
```

Os tetos de taxa, prazo e janela acima são uma escolha da rota de intenção para dados de demonstração, **não** limites impostos pelo Solidity. `amountCents` aceita string decimal positiva até `2^256−1` (até 78 dígitos), mas o limite fictício do tomador continua sendo revalidado.

Resposta **202**:

```json
{
  "data": {
    "id": "f0000000-0000-4000-8000-000000000001",
    "action": "create_offer",
    "status": "pending",
    "requesterWallet": "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    "offerId": null,
    "params": {
      "borrowerWallet": "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
      "amountCents": "100000000",
      "rateCdiBps": 10500,
      "termDays": 1,
      "validitySeconds": 3600
    },
    "txHash": null,
    "createdAt": "2026-09-29T12:00:00.000Z",
    "expiresAt": "2026-09-29T12:15:00.000Z",
    "submittedAt": null,
    "failureCode": null,
    "contractCall": {
      "chainId": 11155111,
      "contractAddress": "0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c",
      "functionName": "createOffer",
      "args": ["0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", "100000000", "10500", "1", "3600"]
    }
  },
  "meta": { "source": "mock" }
}
```

A intenção não altera `GET /api/offers` sem listener. Para achar o tomador fictício, use `GET /api/credit-limits?registered=true&minAvailableCents=<valor>&excludeWallet=<minha>`.

Erros: 400, 403 `not-registered-institution`, 422 `invalid-counterparty` / `not-registered-institution` / `insufficient-limit`.

#### `POST /api/offers/{id}/accept` · `/reject` · `/cancel`

Sem corpo. Cabeçalho `X-Wallet-Address` obrigatório. **Não envie `Content-Type: application/json` sem corpo**: o Fastify responde 400.

| Ação | Quem pode | Checagens extras | `contractCall` |
| --- | --- | --- | --- |
| `accept` | tomador | Ofertante e tomador cadastrados, limite do tomador ≥ valor | `acceptOffer(onchainOfferId)` |
| `reject` | tomador | — | `rejectOffer(onchainOfferId)` |
| `cancel` | ofertante | — | `cancelOffer(onchainOfferId)` |

Todas exigem oferta `offered` e dentro de `expiresAt`. A resposta é uma `TransactionRequest` com `offerId` preenchido e `params: null`.

Erros: 400, 403 (`not-eligible-borrower`, `not-offer-owner`, `not-registered-institution`), 404, 409 (`invalid-offer-status`, `offer-expired`, `request-in-progress`), 422 (`insufficient-limit`, `not-registered-institution`).

> Não há rota para `expireOffer`. Oferta vencida já aparece como `expired` na API; chamar `expireOffer` on-chain é opcional e pode ser feito por qualquer conta.

### Intenções

#### `GET /api/transaction-requests/{id}`

Estado atual da intenção. Depois do listener, `status` chegará a `confirmed` ou `failed` (com `failureCode`). Uma intenção `pending` cujo `expiresAt` passou aparece como `expired`.

#### `POST /api/transaction-requests/{id}/submission`

Cabeçalho `X-Wallet-Address` = a mesma carteira que criou a intenção.

```json
{ "txHash": "0xabababababababababababababababababababababababababababababababab" }
```

Resposta 200: a intenção com `status: "submitted"`, `txHash` e `submittedAt`.

Erros: 400, 403 `not-request-owner`, 404, 409 (`invalid-request-status`, `request-expired`, `duplicate-transaction`).

### Simulação DvP (`development`/`test` somente)

`POST /api/mock/offers` recebe:

```json
{
  "lenderWallet": "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  "borrowerWallet": "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  "amountCents": "100000000",
  "rateCdiBps": 10500,
  "termDays": 1,
  "validitySeconds": 3600
}
```

Retorna 201 com `{ data: { offer: Offer, operation: null }, meta: { source: "mock" } }`. Ofertante e tomador são apenas endereços fictícios escolhidos no body, diferentes e cadastrados nas fixtures. `amountCents` é decimal canônico > 0 e ≤ `2^256−1`; taxa, prazo e validade são inteiros positivos seguros em JavaScript. Datas além do ano 9999 são rejeitadas por limitação de representação do simulador. Criação não debita limite.

`POST /api/mock/offers/{id}/accept`, `/reject` e `/cancel` não recebem body nem cabeçalho de identidade. Só uma oferta `offered` e não vencida aceita uma transição. O aceite revalida registro e limite do tomador, debita-o e devolve `{ offer: Offer, operation: Operation }` com `OfferAccepted` e `OfferSettled` no **mesmo hash sintético**; rejeição/cancelamento devolvem `operation: null` e não debitam limite. `GET /api/offers/{id}`, `/events`, `/api/operations/{txHash}` e `/api/credit-limits/{wallet}/history` mostram o novo estado (no PostgreSQL, para qualquer instância e depois de reiniciar). `expiresAt <= now` dá 409; ler uma oferta vencida não inventa evento `OfferExpired`. Repetir ação terminal também dá 409.

O teto por instância é 100 ofertas incluindo nove fixtures; quando cheio, retorna 503 sem alterar o estado. Não há persistência, autenticação, rate limiting ou transferência real. Cada reinício restaura as fixtures. O OpenAPI servido em `production` omite os quatro POSTs.

### Operações

#### `GET /api/operations`

Operações liquidadas (RF05), mais recentes primeiro. Query: `wallet` (ofertante ou tomador), `limit`, `offset`.

#### `GET /api/operations/{txHash}`

Comprovante **fictício**, com partes, valor, taxa, prazo, horário, bloco, hash sintético e NFT de posição representado no mock. Não comprova liquidação na Sepolia.

```json
{
  "data": {
    "txHash": "0x7000…0015",
    "offerId": "a0000000-0000-4000-8000-000000000006",
    "onchainOfferId": "6",
    "chainId": 11155111,
    "contractAddress": "0x0c0c…0c",
    "lender": { "wallet": "0xb2b2…b2", "institution": { "id": "b0000000-…-000000000002", "name": "Banco Beta S.A. (fictício)" } },
    "borrower": { "wallet": "0xc3c3…c3", "institution": { "id": "b0000000-…-000000000003", "name": "Banco Gama S.A. (fictício)" } },
    "amountCents": "3000000000",
    "rateCdiBps": 10200,
    "termDays": 1,
    "positionTokenId": "6",
    "blockNumber": 9198545,
    "blockHash": "0xb000…5bd1",
    "settledAt": "2026-09-29T07:09:00.000Z",
    "explorerUrl": "https://sepolia.etherscan.io/tx/0x7000…0015"
  },
  "meta": { "source": "mock" }
}
```

O hash sintético é aceito em qualquer caixa. Erros: 400, 404.

> A restrição futura a participantes autenticados ainda depende de política aprovada e implementação de autenticação; hoje o histórico fictício é público na API.

### Limites

#### `GET /api/credit-limits`

Limites por carteira, maior primeiro (RF04). Lista inteira, sem paginação.

| Query | Tipo | Descrição |
| --- | --- | --- |
| `registered` | boolean | `true`: só carteiras cadastradas nas fixtures |
| `minAvailableCents` | string | Limite disponível ≥ valor |
| `excludeWallet` | endereço | Tira uma carteira da lista (a do operador) |

#### `GET /api/credit-limits/{wallet}`

Uma `CreditLimit`. Uma carteira revogada nas fixtures mantém seu limite fictício, mas tem `isRegistered: false`.

#### `GET /api/credit-limits/{wallet}/history`

Mudanças fictícias de limite, mais recentes primeiro. `admin_update` representa `CreditLimitUpdated`; `settlement` é o débito associado a `OfferSettled` no simulador (o contrato não emite evento de limite nesse débito).

```json
{
  "data": [
    { "changeKind": "settlement", "previousLimitCents": "20000000000", "newLimitCents": "15000000000", "offerId": "a0000000-…-000000000001", "txHash": "0x…0b", "logIndex": 1, "blockTimestamp": "2026-09-26T12:12:00.000Z" },
    { "changeKind": "admin_update", "previousLimitCents": "0", "newLimitCents": "20000000000", "offerId": null, "txHash": "0x…04", "logIndex": 0, "blockTimestamp": "2026-09-20T13:10:00.000Z" }
  ],
  "meta": { "source": "mock" }
}
```

### Saúde e documentação

| Rota | Resposta |
| --- | --- |
| `GET /health` | `{ "status": "ok" }` |
| `GET /ready` | `{ "status": "ready", "dependencies": [] }` |
| `GET /openapi.json` | Contrato OpenAPI |
| `GET /docs` | Swagger UI (fora do `openapi.json`) |

Essas rotas não usam envelope nem `X-Data-Source`.

---

## 5. Recursos

Esquemas completos (com descrição de cada campo) em `components.schemas` do [`openapi.json`](openapi.json). Resumo e origem no banco:

| Recurso | Campos principais | Tabelas |
| --- | --- | --- |
| `Party` | `wallet`, `institution { id, name } \| null` | `contract_wallet_state` + `institutions` |
| `Offer` | `id`, `onchainOfferId`, `lender`, `borrower`, `amountCents`, `rateCdiBps`, `termDays`, `status`, `onchainStatusCode`, `createdAt`, `expiresAt`, `createTxHash`, `createdBlock`, `settlement` | `offers` + `settlements` |
| `ChainEvent` | `eventName`, `txHash`, `logIndex`, `blockNumber`, `blockHash`, `blockTimestamp`, `offerId`, `args` | `chain_events` |
| `Operation` | `txHash`, `offerId`, partes, `amountCents`, `rateCdiBps`, `termDays`, `positionTokenId`, `blockNumber`, `blockHash`, `settledAt`, `explorerUrl` | `settlements` + `offers` |
| `CreditLimit` | `wallet`, `institution`, `isRegistered`, `availableLimitCents`, `observedBlock`, `observedAt` | `contract_wallet_state` |
| `CreditLimitChange` | `changeKind`, `previousLimitCents`, `newLimitCents`, `offerId`, `txHash`, `logIndex`, `blockTimestamp` | `credit_limit_history` |
| `TransactionRequest` | `id`, `action`, `status`, `requesterWallet`, `offerId`, `params`, `txHash`, `createdAt`, `expiresAt`, `submittedAt`, `failureCode`, `contractCall` | `transaction_requests` |
| `Deployment` | `chainId`, `network`, endereços dos 3 contratos, `startBlock` | `contract_deployments` |
| `SyncStatus` | `lastProcessedBlock`, `lastSyncedAt`, `lagSeconds`, `stale` | `sync_cursors` |

Campos que podem ser `null` sempre vêm presentes (nunca omitidos).

---

## 6. Estados

### Oferta

| `status` (API) | `onchainStatusCode` | Significado | Evento que fecha |
| --- | --- | --- | --- |
| `offered` | 0 | Aberta, dentro da validade | — |
| `settled` | 2 | Aceita e liquidada na mesma transação | `OfferSettled` |
| `cancelled` | 3 | Retirada pelo ofertante | `OfferCancelled` |
| `expired` | 4 | Vencida com evento sintético `OfferExpired` na fixture | `OfferExpired` |
| `expired` | 0 | Vencida, mas ninguém chamou `expireOffer` | — |
| `rejected` | 5 | Recusada pelo tomador | `OfferRejected` |

`Accepted` (código 1) nunca é persistido: aceite e liquidação são uma transação só. Se a liquidação falha, a transação inteira reverte e a oferta continua `offered`.

### Intenção

```mermaid
stateDiagram-v2
    [*] --> pending: POST de intenção
    pending --> submitted: POST .../submission
    pending --> expired: expiresAt passou (15 min)
    submitted --> confirmed: listener viu o evento
    submitted --> failed: transação reverteu
```

Sem listener, só existem `pending`, `submitted` e `expired`.

---

## 7. Massa de dados de demonstração

A mesma massa serve as duas fontes: em memória ela é criada quando a API sobe; no PostgreSQL, gravada pelo seed (`npm run db:setup`, serviço `setup` do compose). Os horários são relativos a esse momento, então logo depois há ofertas abertas; para renová-los no banco, `docker compose run --rm -e SEED_DEMO=reset setup` ou `npm run db:seed -- --reset`. Nomes e endereços são fictícios.

| Banco | Carteira | Limite disponível | Situação |
| --- | --- | --- | --- |
| Banco Alfa | `0xa1a1…a1` (`0xa1` × 20) | R$ 300.000.000,00 | cadastrado |
| Banco Beta | `0xb2b2…b2` | R$ 150.000.000,00 | cadastrado |
| Banco Gama | `0xc3c3…c3` | R$ 80.000.000,00 | cadastrado |
| Banco Delta | `0xd4d4…d4` | R$ 50.000.000,00 | **revogado** |

| `onchainOfferId` | Ofertante → tomador | Valor | Taxa | Status |
| --- | --- | --- | --- | --- |
| 1 | Alfa → Beta | R$ 50 mi | 102,5% CDI | `settled` |
| 2 | Gama → Alfa | R$ 25 mi | 101% | `settled` |
| 3 | Beta → Gama | R$ 10 mi | 103% | `cancelled` |
| 4 | Alfa → Gama | R$ 70 mi | 104% | `rejected` |
| 5 | Gama → Beta | R$ 12 mi | 101,5% | `expired` (código 4) |
| 6 | Beta → Gama | R$ 30 mi | 102% | `settled` |
| 7 | Beta → Alfa | R$ 30 mi | 102% | `expired` (código 0) |
| 8 | Alfa → Beta | R$ 40 mi | 105% | `offered` (vence ~50 min após subir) |
| 9 | Gama → Alfa | R$ 15 mi, 2 dias | 103,5% | `offered` (vence ~55 min após subir) |

O id da oferta N na API é `a0000000-0000-4000-8000-00000000000N`. Comandos `/api/mock` adicionam ofertas além das nove fixtures; intenções não alteram a lista. Em memória há teto de 100 ofertas e tudo se perde ao reiniciar; no PostgreSQL não há teto e os dados persistem.

---

## 8. Usando a coleção

1. Suba a API em modo local explícito: `npm run build && NODE_ENV=development npm run start` (padrão `http://127.0.0.1:3000`). Sem `NODE_ENV`, o servidor sobe em `production` e só oferece GETs.
2. No Postman: **Import** → `docs/collection/backend-banco-inter.postman_collection.json`. Bruno e Insomnia também importam coleções Postman v2.1.
3. Variáveis: `baseUrl`, `lenderWallet` (Alfa), `borrowerWallet` (Beta), `openOfferId`, `cancelOfferId`, `settledOfferId`, `settledTxHash`, `requestId` e `mockOfferId`.
4. Rode **Simulação DvP → Criar oferta fictícia** para preencher `mockOfferId`, depois **Aceitar oferta fictícia**; consultar oferta, eventos, limites e operação reflete o novo estado (persistido, com PostgreSQL). Rode **Ofertas → Criar oferta (intenção)** para preencher `requestId` antes de **Intenções**. Esses comandos só existem no ambiente `development`/`test`.

Cada requisição traz exemplos salvos (sucesso e erros comuns), então dá para ler as respostas sem subir a API.

Depois de mudar rotas ou esquemas, regenere e comite:

```bash
npm run docs:export
```

---

## 9. Limites e integração futura

As rotas persistem no PostgreSQL, mas o conteúdo ainda é sintético: não existe fonte confiável de identidade, confirmação on-chain, prova de reserva, listener, política implementada de reorg ou isolamento institucional na API. Antes de tratar os dados como reais, frontend e backend precisam acordar contrato de autenticação, rastreabilidade, versão do ABI, medição de latência e semântica de falha. A mudança para uma API financeira não preserva necessariamente os códigos ou campos atuais.
