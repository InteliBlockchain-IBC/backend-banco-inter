# Arquitetura

Backend da PoC de crédito interfinanceiro (CDI) overnight — Banco Inter × Inteli Blockchain.

## Contexto

Bancos emprestam reservas entre si por um dia útil (overnight) para fechar o caixa dentro do mínimo regulatório. A taxa média dessas operações é o CDI. Hoje a negociação leva minutos e a liquidação leva horas, por conta de checagem manual de limite e conciliação. Nessa janela existe risco de contraparte: a operação foi combinada mas ainda não foi consumada.

O objetivo da PoC é reduzir essa janela: o contrato inteligente valida o limite e executa a troca — posição de crédito CDIP e ativo de liquidação BRLt — em uma transação atômica (DvP, *delivery versus payment*). Essa propriedade do contrato não implica que o backend já esteja integrado ao fluxo.

## Stack e alternativas

| Camada | Escolha | Situação nesta base | Alternativa e trade-off |
|---|---|---|---|
| Runtime | Node.js 24 LTS, TypeScript estrito | API e testes executáveis (`package.json`, `.nvmrc`) | Java/Spring traz ecossistema corporativo maior, mas exige outra toolchain e mais configuração para esta PoC; Python/FastAPI facilita prototipagem, mas fragmentaria os tipos compartilhados com o cliente JS. Nenhum benchmark comparativo foi executado. |
| HTTP | Fastify 5 com schemas e OpenAPI | Implementado em `src/app.ts` e `src/http/routes/` | Express tem ecossistema amplo, porém validação e OpenAPI precisariam de composição adicional nesta base. |
| Persistência | PostgreSQL 17 no Compose/VPS e 16 no CI; `pg` e SQL versionado | Migrations, runner e seed (`src/database/`) e `PgRepository` (`src/repositories/postgres/`); testes de paridade, concorrência e prontidão em PostgreSQL real. A suíte também foi executada em PG17 antes do deploy | SQLite não exercitaria as mesmas constraints, locks e transações. Um ORM acrescentaria mapeamentos a revisar para `numeric(78,0)` e chaves compostas. |
| Rede | Sepolia (testnet) | Listener disponível no código; ambiente público atual serve apenas o seed sintético | Rede permissionada mudaria as premissas de finalização e infraestrutura; está fora da PoC. |
| Leitura on-chain | `viem` | Instalado; listener em `src/blockchain/`, acionado separadamente | `ethers` é alternativa, sem necessidade de troca para o deploy atual. |

Sem ORM e sem serviço de fila nesta etapa. `npm run db:setup` aplica as migrations e o seed ao `DATABASE_URL`; provas on-chain, autenticação e replay continuam fora do escopo da migration. O código segue uma arquitetura em camadas, no estilo de Clean Architecture/hexagonal, dentro de um único serviço (monolito):

| Camada | Pasta | Responsabilidade | Depende de |
| --- | --- | --- | --- |
| HTTP | `src/http/` | Rotas Fastify (papel de controllers), schemas JSON/OpenAPI, Problem Details e envelope de resposta | domínio, interface de repositório |
| Domínio | `src/domain/` | Tipos e unidades do contrato DvP, regras puras (validação, transições, argumentos de evento) e montagem do payload | nada de HTTP ou banco* |
| Repositórios | `src/repositories/` | Interface `Repository` e duas implementações: `PgRepository` (SQL parametrizado, transações, advisory lock nas escritas que leem antes de gravar) e `InMemoryRepository` (testes HTTP rápidos e desenvolvimento sem banco) | domínio |
| Banco | `src/database/` | Runner de migrations e seed de demonstração | dados de `src/demo/` |

As rotas conhecem só a interface `Repository`; `src/app.ts` escolhe a implementação pela presença de `DATABASE_URL`. As duas implementações montam o JSON pelo mesmo módulo (`domain/views.ts`) e aplicam as mesmas regras (`domain/rules.ts`), e um teste de paridade garante respostas idênticas.

\* Exceção conhecida: as regras lançam `ApiProblem` (`http/errors.ts`), que já carrega o status HTTP. Separar erros de domínio dos códigos HTTP é um refinamento possível, não necessário para a PoC.

## Diagrama

O diagrama de componentes fica no [README](../README.md#arquitetura), fonte única. Esta seção descreve o que ele mostra.

Fluxo **alvo**, não execução já disponível:

1. O cliente prepara/assina uma transação em sua própria carteira, sem custódia do backend. Uma API futura autenticada pode persistir intenção e expor argumentos, mas os POSTs de intenção atuais são apenas desenvolvimento/teste e usam identidade autodeclarada.
2. O contrato DvP valida registro, limite e saldo/allowance do ativo de liquidação; aceite e liquidação ocorrem na mesma transação.
3. O listener implementado lê logs confirmados na Sepolia e grava o lote com o cursor na mesma transação. Detecta reorg e interrompe o lote; o reparo automático ainda não está implementado.
4. O cliente consulta a API para ver a projeção. No ambiente público de demonstração, o listener está desligado e os dados vêm do seed.

## Componentes

### Mesa de Operações (React, repositório externo)

A interface não está integrada à API deste repositório. Apresentar estados e limites com identidade institucional verificável depende de um contrato de integração e de autenticação.

### Carteira (externa)

O operador assina transações na carteira; o backend não guarda chaves nem transmite transações. A validação on-chain continua soberana, inclusive quando uma consulta local aprovar uma intenção.

### API (Fastify, implementada)

Consultas e histórico no PostgreSQL (ou em memória, sem `DATABASE_URL` em development/test); comandos DvP sintéticos sob `/api/mock` e intenções de assinatura sob `/api` só em `development`/`test`. Em `production`, nenhum POST é registrado. O cabeçalho de carteira é autodeclarado e não concede autorização.

### Listener (implementado, `src/blockchain/`)

`chain:watch` lê logs do contrato em lotes de até 10 blocos, com 12 confirmações, e grava eventos, ofertas, liquidações, limites, histórico e cursor numa transação por lote. Antes de cada passe confere o chain ID do RPC e se o bloco do cursor ainda é canônico; cada log precisa vir do bloco canônico do seu número. Divergência, evento de oferta órfão ou limite inconsistente desfazem o lote e param o cursor (falha fechada, com `code` no log). A reversão automática de reorg fica para uma próxima entrega. Detalhes no README, seção "Listener Sepolia".

### PostgreSQL (integrado à API)

As dez tabelas de domínio e `schema_migrations` são criadas pelas migrations versionadas (`001_initial_schema.sql`, `002_institution_wallets.sql`, `003_deployment_source.sql`), aplicadas pelo runner (`setup` no Compose). Uma instituição opera várias carteiras (`institution_wallets`); cadastro e limite on-chain são por carteira (`contract_wallet_state`). A API lê essas tabelas; escritas HTTP só existem em development/test. `/ready` executa `SELECT 1` e responde 503 se o banco cair; em `production` o servidor exige `DATABASE_URL`. O worker, quando habilitado, escreve a projeção dos eventos da Sepolia.

### RPC provider

O listener usa um endpoint HTTP da Sepolia (`SEPOLIA_RPC_URL`), só para leitura. A URL carrega a chave do provedor e nunca aparece em log.

### Contratos (Solidity/Foundry)

Contrato DvP, BRLt ERC-20 de liquidação e posição CDIP ERC-721 ficam no repositório Web3. O listener deste backend faz leituras ABI/RPC; não assina nem transmite transações. O ambiente público atual não executa o listener.

## Decisões

### O backend não assina transações

`viem` é a dependência usada pelo listener para leitura. O operador mantém a chave na própria carteira.

Alternativa descartada: backend com chave custodial (relayer). Seria mais fácil de demonstrar, mas colocaria o backend no caminho crítico da liquidação e enfraqueceria o argumento central do projeto — a operação acontece no contrato, sem intermediário confiável.

Consequência: a chain é autoridade financeira; o backend será indexador e fonte de dados *off-chain* autorizada, não executor.

### Cursor, idempotência e reorg

O listener implementa polling com cursor persistido e confirma avanços somente após gravar o lote. Os testes de integração exercitam retomada, replay sem duplicação e rollback de lote com falha RPC; não medem a latência da Sepolia.

Para cada `(chain_id, contract_address, tx_hash, log_index)`, a projeção só deve aplicar o evento se o log foi inserido; evento, limite derivado, oferta/liquidação e cursor precisam compartilhar uma transação. A chave primária em `chain_events` sustenta idempotência de *logs idênticos*, mas **não** resolve reorg por si só.

Um reorg pode substituir logs no mesmo número de bloco. O listener guarda o hash do cursor, verifica a canonicidade e para diante de divergência. Ainda faltam a janela de hashes e o reparo automático. Os passes concorrentes são serializados por advisory lock; a chave idempotente sozinha não resolve reorg.

## Orçamento de latência (RNF02: meta de 30 segundos)

`tempo até confirmação da transação + intervalo de polling do listener + escrita + polling do cliente` precisa ser medido no fluxo integrado para avaliar a meta de 30 segundos. O listener usa 12 confirmações por padrão; o ambiente publicado não o executa. Nenhum SLO de ponta a ponta foi medido, e o smoke de deploy não comprova RNF02.

## Riscos conhecidos

**Dados sintéticos confundidos com liquidação.** Sucessos HTTP marcam a origem (`postgres` ou `mock`), mas mesmo persistidos os hashes e links de explorer do seed e da simulação são sintéticos. Erros não carregam o marcador porque usam Problem Details.

**Identidade não verificada.** Cabeçalho de carteira e endereços no body são autodeclarados. POSTs não são registrados em `production`; não exponha `development` como serviço financeiro.

**Projeção congelada ou divergente.** O ambiente público serve dados sintéticos sem listener; `sync-status` não comprova sincronização real. Ao ativar o worker, acompanhar atraso do cursor e falhas de reorg; o reparo automático continua pendente.

**Limite em duas representações.** A chain decidirá o limite na execução; uma projeção atrasada pode sugerir aceite que será revertido. UI deve apresentar o erro e reconciliar estado.

## Implantação de demonstração

O proxy recebe HTTPS e encaminha as chamadas à porta interna 3000 da API. O PostgreSQL 17 tem armazenamento persistente e não publica porta externa. A aplicação usa banco e credenciais próprios; a rede interna é compartilhada com outros serviços da VPS.

A API roda como usuário `node` e inicia com `setup-db.js` seguido de `server.js`. O seed `if-empty` preserva os dados em reinícios. O ambiente permite apenas leituras públicas de dados fictícios e não executa o listener. O [guia de deploy](deploy.md) reúne os endereços de acesso, testes e procedimentos de operação, além das pendências de backup, rate limit, CORS e monitoramento.

## Caminho para produção

Uma implantação fora da testnet exigiria outra revisão de ameaça, controle de identidade, nó/rede adequados, reconciliação e observabilidade. Não há suporte a produção financeira neste repositório. Escalar para múltiplos contratos ou listener redundante depende primeiro de medir volume, consistência e comportamento sob reorg.
