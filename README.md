# Backend — Protocolo de crédito interfinanceiro

API e camada de persistência PostgreSQL da prova de conceito de crédito interbancário overnight, desenvolvidos pelo **Inteli Blockchain** com o **Banco Inter** (Digital Assets & Emerging Technologies).

> Projeto acadêmico e experimental. Opera exclusivamente em testnet (Sepolia), sem conexão com sistemas de produção e sem movimentação de ativos reais.

---

## O problema

Bancos emprestam reservas entre si por um dia útil para fechar o caixa dentro do mínimo regulatório — a taxa média dessas operações é o CDI. Hoje a negociação leva minutos e a liquidação leva horas, por causa de checagem manual de limite e conciliação. Nessa janela existe **risco de contraparte**: a operação foi combinada mas ainda não foi consumada.

A PoC propõe reduzir essa janela. No fluxo on-chain pretendido, o contrato inteligente valida o limite e executa a troca — token de crédito de um lado, ativo de liquidação do outro — em uma única transação atômica (DvP, *delivery versus payment*). Ou as duas pernas acontecem, ou nenhuma; a API deste repositório ainda não executa esse fluxo.

## O papel deste repositório

O projeto tem três repositórios: contratos, frontend e este. Aqui fica a camada Web2 — a que guarda o que não pode ir para uma rede pública e a que traduz o que acontece on-chain.

Neste repositório estão a API, a projeção PostgreSQL dos eventos do contrato (migrations, seed de demonstração e consultas), as intenções de assinatura e os comandos de simulação DvP. O backend não assina, transmite ou confirma transações; o listener que alimentará a projeção a partir da Sepolia é a próxima entrega.

## Estado atual

Versão `0.4.0`. **As rotas leem e gravam no PostgreSQL** quando `DATABASE_URL` está definida: ofertas, eventos, liquidações, limites, histórico, cursor e intenções são persistidos com timestamp, partes, taxa e hash, e sobrevivem a reinícios da API. Ainda não existe RPC nem listener: o conteúdo do banco vem do seed de demonstração e das simulações, então hashes, blocos e endereços continuam **sintéticos**, não prova de liquidação.

| Ambiente | `DATABASE_URL` | Fonte de dados | `X-Data-Source` |
| --- | --- | --- | --- |
| `production` | obrigatória (sem ela o servidor não sobe) | PostgreSQL | `postgres` |
| `development` / `test` | definida | PostgreSQL | `postgres` |
| `development` / `test` | ausente | memória da instância (fixtures) | `mock` |

Toda resposta **bem-sucedida** de `/api/*` traz `X-Data-Source` e `meta.source` com a origem; erros são `application/problem+json`. O payload é idêntico nas duas fontes — um teste de integração executa a mesma sequência de leituras, intenções e simulações em memória e no PostgreSQL e exige respostas iguais.

Em `development`/`test`, `/api/mock/offers` cria ofertas e `/api/mock/offers/:id/{accept,reject,cancel}` registra a transição (oferta, eventos, liquidação, débito do limite, histórico e cursor) na fonte de dados ativa, numa única transação. Nesse ambiente também existem intenções de assinatura sob `/api/offers` e envio de hash sob `/api/transaction-requests`. `X-Wallet-Address` é dado fornecido pelo cliente, **não autenticação**; uma intenção não liquida nada sem listener. Em `production` todos os `POST` são 404 e não aparecem no OpenAPI servido. Sem `NODE_ENV`, tanto `buildApp()` quanto o servidor usam **production** por segurança.

## Começando

### Com Docker Compose — API, banco e seed em um comando

Requisito: Docker com o plugin Docker Compose. Na raiz do repositório:

```bash
docker compose up --build -d
```

O Compose constrói a imagem com Node.js 24 e sobe, nesta ordem:

1. `db` — PostgreSQL 17, com volume persistente;
2. `setup` — aplica as migrations versionadas (`schema_migrations`) e grava a massa de demonstração; termina sozinho;
3. `api` — sobe conectada ao banco pelo host `db`, em `NODE_ENV=development` (expõe as simulações e intenções).

Não é necessário instalar Node.js ou PostgreSQL no computador.

- API: <http://localhost:3000> — confira `X-Data-Source: postgres` nas respostas
- Documentação interativa: <http://localhost:3000/docs>
- Prontidão (testa o banco): <http://localhost:3000/ready>
- PostgreSQL: `localhost:5432`, banco `banco_inter`, usuário `banco_inter`, senha local `banco_inter_local`.

As portas publicadas ficam acessíveis apenas no próprio computador. Para alterar portas, credenciais ou o seed, copie `.env.example` para `.env` e ajuste `API_PORT`, `POSTGRES_*`, `API_NODE_ENV` e `SEED_DEMO`. O comando funciona também sem `.env`, usando esses padrões.

**Seed de demonstração.** Os horários da massa são relativos ao momento do seed, então logo depois dele há duas ofertas abertas (validade de 1 hora), liquidações, cancelamento, rejeição e vencimentos. `SEED_DEMO=if-empty` (padrão) grava só no primeiro `up` e preserva o que você criar depois. Para recriar a massa com horários renovados — por exemplo, antes de uma demonstração:

```bash
docker compose run --rm -e SEED_DEMO=reset setup
```

Para consultar o estado, acompanhar logs, abrir o banco e encerrar o ambiente:

```bash
docker compose ps
docker compose logs -f api setup
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose down
```

`docker compose down` preserva os dados do PostgreSQL; `docker compose down -v` apaga o volume e o próximo `up` recria esquema e seed.

> **Já usava o compose da versão 0.3.0?** Aquele volume foi criado pelo `docker-entrypoint-initdb.d`, sem `schema_migrations`, e o `setup` falharia com "relation already exists". Rode `docker compose down -v` uma vez antes do novo `up`.

### Com Node.js instalado no computador

Requisitos: **Node.js 24** (fixado em [`.nvmrc`](.nvmrc)) e npm.

Com um PostgreSQL acessível (por exemplo, só o banco do compose: `docker compose up -d db`), copie [`.env.example`](.env.example) para `.env` — ele já aponta `DATABASE_URL` para esse banco — e rode:

```bash
npm ci
npm run build
node --env-file=.env dist/scripts/setup-db.js   # migrations + seed
node --env-file=.env dist/src/server.js
```

Sem `DATABASE_URL`, `NODE_ENV=development npm run start` sobe com os dados em memória (`X-Data-Source: mock`), útil para trabalhar sem banco. O servidor sobe em `HOST` e `PORT` (padrão `127.0.0.1:3000`).

### Scripts

| Comando | O que faz |
| --- | --- |
| `npm run build` | Compila o TypeScript para `dist/` |
| `npm run start` | Sobe o servidor compilado |
| `npm run db:setup` | Migrations + seed com `DATABASE_URL` (`SEED_DEMO=if-empty\|reset\|off`) |
| `npm run db:migrate` | Só as migrations SQL com `DATABASE_URL` |
| `npm run db:seed` | Só o seed; `npm run db:seed -- --reset` recria a massa |
| `npm run test:db` | Migrations e integração PostgreSQL em schemas descartáveis (`TEST_DATABASE_URL`) |
| `npm run docs:export` | Regera `docs/openapi.json` e a coleção Postman |
| `npm test` | Roda a suíte de testes |
| `npm run coverage` | Roda os testes com cobertura (exige `TEST_DATABASE_URL`) |
| `npm run typecheck` | Verifica os tipos sem gerar arquivos |
| `npm run lint` | Analisa o código com o Biome |
| `npm run format` | Formata o código |
| `npm run format:check` | Verifica a formatação sem alterar arquivos |
| `npm run openapi:validate` | Valida o contrato OpenAPI gerado |

## API

Referência completa, com payloads, erros e exemplos: **[`docs/api.md`](docs/api.md)**. Para testar sem ler código, importe a coleção [`docs/collection/backend-banco-inter.postman_collection.json`](docs/collection/backend-banco-inter.postman_collection.json) no Postman, Bruno ou Insomnia.

| Método | Caminho | Disponibilidade |
| --- | --- | --- |
| GET | `/api/deployment`, `/api/sync-status` | Deployment e cursor da projeção (endereços sintéticos do seed) |
| GET | `/api/offers`, `/api/offers/:id`, `/api/offers/:id/events` | Ofertas e eventos persistidos |
| GET | `/api/operations`, `/api/operations/:txHash` | Liquidações e comprovantes persistidos |
| GET | `/api/credit-limits`, `/api/credit-limits/:wallet`, `/api/credit-limits/:wallet/history` | Limites e histórico persistidos |
| GET | `/api/transaction-requests/:id` | Intenções persistidas |
| POST | `/api/mock/offers`, `/api/mock/offers/:id/{accept,reject,cancel}` | **Somente development/test**; simulação sem autenticação ou transação |
| POST | `/api/offers`, `/api/offers/:id/{accept,reject,cancel}`, `/api/transaction-requests/:id/submission` | **Somente development/test**; intenções, não execução |
| GET | `/health`, `/ready`, `/openapi.json`, `/docs` | Liveness, prontidão (`SELECT 1` no banco; 503 se cair) e documentação |

O OpenAPI exportado e a coleção Postman representam o ambiente `development`. O OpenAPI servido em `production` omite as operações POST. Sem deployment no banco (migrations aplicadas, seed não), `/api/*` responde 503 `deployment-not-configured` até `npm run db:setup`.

Erros usam `application/problem+json`, com `type`, `title`, `status`, `detail` e `correlationId`; a lista de tipos está em [`docs/api.md`](docs/api.md#3-erros). Nenhuma resposta ou log expõe stack trace, SQL, `DATABASE_URL`, URL de RPC ou variável de ambiente.

`/docs` é registrado como plugin de UI, não como rota com schema, então não aparece em `document.paths` do `/openapi.json`.

## Arquitetura

O diagrama separa o que esta base executa (setas sólidas) das integrações pretendidas (tracejadas). O frontend e o contrato ficam em repositórios separados.

```mermaid
flowchart LR
    FE["Frontend (externo)"]
    W["Carteira do operador"]
    RPC["RPC Sepolia"]
    DVP["Contrato DvP"]
    BRL["BRLt · ERC-20"]
    CDIP["CDIP · NFT ERC-721"]
    API["Fastify · TypeScript"]
    STORE["DataStore · PgStore / MockStore"]
    MIG["setup: migrations + seed"]
    DB[("PostgreSQL")]
    LIS["Listener planejado"]

    FE -.->|"integração futura"| API
    FE -.-> W
    W -.-> RPC
    RPC -.-> DVP
    DVP -.-> BRL
    DVP -.-> CDIP
    API --> STORE
    STORE -->|"consultas e transações"| DB
    MIG -->|"antes da API"| DB
    LIS -.->|"leitura futura"| RPC
    LIS -.->|"projeção futura"| DB
```

O contrato é a autoridade financeira. O banco é uma projeção reconstruível de eventos, não executor da troca; hoje ela é alimentada pelo seed e pela simulação, e o listener passará a alimentá-la a partir da Sepolia. Antes de expor mutações reais, faltam autenticação de carteira e autorização institucional, listener com replay/reorg e integração de consumidor. Orçamento de latência é uma hipótese de projeto, **não** um SLO medido.

Tecnologias, alternativas e riscos: [`docs/arquitetura.md`](docs/arquitetura.md).

## Estrutura

```
src/
  app.ts              composição do Fastify, ambientes, erros e OpenAPI
  server.ts           bootstrap e ciclo de vida
  domain.ts           tipos e unidades do contrato DvP
  schemas.ts          schemas JSON/OpenAPI
  store.ts            interface DataStore entre rotas e fonte de dados
  views.ts            montagem do payload, comum às duas fontes
  db/pg-store.ts      PgStore: consultas e transações no PostgreSQL
  db/migrate.ts       runner PostgreSQL versionado e serializado
  db/seed.ts          massa de demonstração (if-empty | reset)
  mock/               fixtures, store em memória e regras da simulação DvP
  routes/             consultas, intenções e simulação
scripts/
  setup-db.ts         migrations + seed (serviço setup do compose)
  migrate.ts, seed.ts comandos isolados
  export-docs.ts      OpenAPI e coleção Postman do ambiente development
migrations/           esquema SQL versionado
test/                 testes HTTP e integração PostgreSQL opcional
docs/                 arquitetura, modelagem e referência de API
```

## Testes e CI

`npm test` executa os testes HTTP com `app.inject()` sobre o store em memória e, quando `TEST_DATABASE_URL` está definida, os testes de PostgreSQL. Cada teste de banco cria e apaga o próprio schema; não aponte para um banco com dados que importam. `npm run test:db` e `npm run coverage` **exigem** a variável. Os testes de banco cobrem:

- paridade: a mesma sequência de leituras, intenções (com conflitos, duplicidade e vencimento) e simulações produz respostas idênticas em memória e no PostgreSQL;
- persistência: o que foi gravado continua lá depois de reiniciar a API;
- concorrência: cinco aceites simultâneos liquidam a oferta uma única vez;
- prontidão: `/ready` responde 503 com o banco fora do ar, sem vazar credenciais;
- banco vazio: 503 até o seed, e seed idempotente;
- migrations: aplicação real, idempotência, concorrência e rollback.

Localmente, o banco do compose serve: `docker compose up -d db` e `TEST_DATABASE_URL=postgresql://banco_inter:banco_inter_local@127.0.0.1:5432/banco_inter npm test`. O CI provisiona PostgreSQL 16 efêmero.

O workflow em [`.github/workflows/ci.yml`](.github/workflows/ci.yml) executa formatação, lint, typecheck, build, cobertura, OpenAPI, testes de banco e auditoria de dependências. A aprovação local não substitui o resultado do CI remoto.

## Escopo dos requisitos

| Requisito | Estado nesta base |
| --- | --- |
| RF04/05 | Consultas e histórico persistidos no PostgreSQL (dados sintéticos); sem indexação on-chain |
| RF06 | Cancelamento **simulado** e persistido; o contrato real não é chamado |
| RNF01 | Fixtures rotuladas Sepolia; sem conexão RPC |
| RNF02 | Meta de latência pendente de listener, integração e medição |
| RNF03 | Trilha persistida (timestamp, partes, taxa, hash, eventos); ainda sintética, não observada on-chain |
| RNF04 | Código e licença MIT disponíveis no repositório |

RF01–RF03 dependem do trabalho de contratos e da validação entre equipes; não são concluídos por esta API.

## Documentação
- [`docs/arquitetura.md`](docs/arquitetura.md) — arquitetura atual e alvo, decisões e trade-offs.
- [`docs/api.md`](docs/api.md) — contrato HTTP, fontes de dados e exemplos.
- [`docs/openapi.json`](docs/openapi.json) e [`docs/collection/`](docs/collection/) — artefatos de `npm run docs:export` para `development`.
- [`docs/modelagem-banco.md`](docs/modelagem-banco.md) — modelo ER; esquema em [`migrations/001_initial_schema.sql`](migrations/001_initial_schema.sql).

## Licença

MIT. Veja [`LICENSE`](LICENSE).
