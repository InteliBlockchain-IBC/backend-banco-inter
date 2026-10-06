# Arquitetura

Backend da PoC de crédito interfinanceiro (CDI) overnight — Banco Inter × Inteli Blockchain.

## Contexto

Bancos emprestam reservas entre si por um dia útil (overnight) para fechar o caixa dentro do mínimo regulatório. A taxa média dessas operações é o CDI. Hoje a negociação leva minutos e a liquidação leva horas, por conta de checagem manual de limite e conciliação. Nessa janela existe risco de contraparte: a operação foi combinada mas ainda não foi consumada.

O objetivo da PoC é reduzir essa janela: o contrato inteligente valida o limite e executa a troca — posição de crédito CDIP e ativo de liquidação BRLt — em uma transação atômica (DvP, *delivery versus payment*). Essa propriedade do contrato não implica que o backend já esteja integrado ao fluxo.

## Stack e alternativas

| Camada | Escolha | Situação nesta base | Alternativa e trade-off |
|---|---|---|---|
| Runtime | Node.js 24 LTS, TypeScript estrito | API e testes executáveis (`package.json`, `.nvmrc`) | Java/Spring traz ecossistema corporativo maior, mas exige outra toolchain e mais configuração para esta PoC; Python/FastAPI facilita prototipagem, mas fragmentaria os tipos compartilhados com o cliente JS. Nenhum benchmark comparativo foi executado. |
| HTTP | Fastify 5 com schemas e OpenAPI | Implementado em `src/app.ts` e `src/routes/` | Express tem ecossistema amplo, porém validação e OpenAPI precisariam de composição adicional nesta base. |
| Persistência | PostgreSQL 16 no CI; `pg` e SQL versionado | Schema, runner, seed e `PgStore` (`src/db/`): **rotas leem e gravam no banco** com `DATABASE_URL`; testes de paridade, concorrência e prontidão em PostgreSQL real | SQLite simplificaria instalação local, mas não exercitaria as mesmas constraints, locks e transações previstas para a projeção compartilhada. Um ORM acrescentaria mapeamentos a revisar para `numeric(78,0)` e chaves compostas; SQL direto mantém esses invariantes explícitos. |
| Rede | Sepolia (testnet) | Apenas endereços e eventos sintéticos em fixtures | Rede permissionada mudaria as premissas de finalização e infraestrutura; está fora da PoC. |
| Leitura on-chain | `viem` candidato | **Não instalado**; listener/RPC/ABI pendentes | `ethers` é opção viável; escolher após validar ABI, suporte a logs e requisitos de replay. |

Sem ORM e sem serviço de fila nesta etapa. `npm run db:setup` aplica as migrations e o seed ao `DATABASE_URL`; provas on-chain, autenticação e replay continuam fora do escopo da migration. As rotas dependem da interface `DataStore` (`src/store.ts`), implementada por `PgStore` (SQL parametrizado, transações, advisory lock nas escritas que leem-e-depois-gravam) e por `MockStore` (memória, para testes HTTP rápidos e desenvolvimento sem banco). Os dois montam o JSON pelo mesmo módulo (`src/views.ts`) e aplicam as mesmas regras de simulação (`src/mock/simulate.ts`).

## Diagrama

O diagrama de componentes fica no [README](../README.md#arquitetura), fonte única. Esta seção descreve o que ele mostra.

Fluxo **alvo**, não execução já disponível:

1. O cliente prepara/assina uma transação em sua própria carteira, sem custódia do backend. Uma API futura autenticada pode persistir intenção e expor argumentos, mas os POSTs de intenção atuais são apenas desenvolvimento/teste e usam identidade autodeclarada.
2. O contrato DvP valida registro, limite e saldo/allowance do ativo de liquidação; aceite e liquidação ocorrem na mesma transação.
3. Um listener ainda a construir lê logs confirmados na Sepolia, detecta divergência de blocos, reprocessa projeções e avança o cursor em uma transação de banco.
4. O cliente consulta a API para ver a projeção; hoje a projeção no PostgreSQL é alimentada pelo seed e pela simulação `/api/mock`, não pela chain.

## Componentes

### Mesa de Operações (React, repositório externo)

A interface não está integrada à API deste repositório. Apresentar estados e limites com identidade institucional verificável depende de um contrato de integração e de autenticação.

### Carteira (externa)

O operador assina transações na carteira; o backend não guarda chaves nem transmite transações. A validação on-chain continua soberana, inclusive quando uma consulta local aprovar uma intenção.

### API (Fastify, implementada)

Consultas e histórico no PostgreSQL (ou em memória, sem `DATABASE_URL` em development/test); comandos DvP sintéticos sob `/api/mock` e intenções de assinatura sob `/api` só em `development`/`test`. Em `production`, nenhum POST é registrado. O cabeçalho de carteira é autodeclarado e não concede autorização.

### Listener (não implementado)

Deverá ler logs por intervalo de blocos, persistir eventos e projeções com cursor e tratar reorg. `GET /api/sync-status` expõe apenas um cursor sintético por enquanto.

### PostgreSQL (integrado à API)

As nove tabelas de domínio e `schema_migrations` são criadas pelo runner (`setup` no compose). A API lê todas e grava ofertas, eventos, liquidações, limites, histórico, cursor e intenções. `/ready` executa `SELECT 1` e responde 503 se o banco cair; em `production` o servidor não sobe sem `DATABASE_URL`. Quando o listener existir, ele passará a ser o escritor da projeção, sujeito a replay e correção de reorg.

### RPC provider

Um provedor Sepolia poderá atender o frontend e o futuro listener; o backend não configura nem usa RPC atualmente.

### Contratos (Solidity/Foundry)

Contrato DvP, BRLt ERC-20 de liquidação e posição CDIP ERC-721, em repositório externo; nenhuma chamada ABI/RPC é feita neste backend.

## Decisões

### O backend não assina transações

`viem` é um candidato para leitura futura, não uma dependência instalada. O operador mantém a chave na própria carteira.

Alternativa descartada: backend com chave custodial (relayer). Seria mais fácil de demonstrar, mas colocaria o backend no caminho crítico da liquidação e enfraqueceria o argumento central do projeto — a operação acontece no contrato, sem intermediário confiável.

Consequência: a chain é autoridade financeira; o backend será indexador e fonte de dados *off-chain* autorizada, não executor.

### Cursor, idempotência e reorg: desenho para o listener

Um consumidor de eventos precisa recuperar intervalos perdidos após paradas. Polling com cursor persistido permite repetir um intervalo e confirmar avanços somente após a projeção do lote; WebSocket sem cursor não resolve perda de eventos. Isso ainda não está implementado nem medido.

Para cada `(chain_id, contract_address, tx_hash, log_index)`, a projeção só deve aplicar o evento se o log foi inserido; evento, limite derivado, oferta/liquidação e cursor precisam compartilhar uma transação. A chave primária em `chain_events` sustenta idempotência de *logs idênticos*, mas **não** resolve reorg por si só.

Um reorg substitui logs que podem ter o mesmo número de bloco e outro hash. A implementação precisará guardar hashes suficientes para uma janela de verificação, detectar divergência, reverter projeções afetadas e reproduzir o ramo canônico antes de avançar o cursor. A migration inicial guarda só o hash do cursor, não essa janela nem o algoritmo. Executar instâncias concorrentes do listener exigirá coordenação adicional; a chave idempotente sozinha não basta.

## Orçamento de latência (RNF02: meta de 30 segundos)

`tempo até confirmação da transação + intervalo de polling do listener + escrita + polling do cliente` deve caber na meta de 30 s **se** a chain produzir blocos, o RPC estiver disponível e a política de reorg permitir. Os tempos da Sepolia são variáveis; uma janela de confirmação/replay consome parte do orçamento. Não há listener ou cliente integrado nesta base, portanto **nenhum SLO de ponta a ponta foi medido**. Medir distribuição de latências e atraso do cursor é pré-requisito para afirmar RNF02.

## Riscos conhecidos

**Dados sintéticos confundidos com liquidação.** Sucessos HTTP marcam a origem (`postgres` ou `mock`), mas mesmo persistidos os hashes e links de explorer do seed e da simulação são sintéticos. Erros não carregam o marcador porque usam Problem Details.

**Identidade não verificada.** Cabeçalho de carteira e endereços no body são autodeclarados. POSTs não são registrados em `production`; não exponha `development` como serviço financeiro.

**Projeção congelada ou divergente.** Sem listener e sem proteção de reorg, o status não acompanha a chain. A leitura de `sync-status` é simulada; alerta operacional real requer conectar e medir cursor/bloco.

**Limite em duas representações.** A chain decidirá o limite na execução; uma projeção atrasada pode sugerir aceite que será revertido. UI deve apresentar o erro e reconciliar estado.

## Caminho para produção

Uma implantação fora da testnet exigiria outra revisão de ameaça, controle de identidade, nó/rede adequados, reconciliação e observabilidade. Não há suporte a produção financeira neste repositório. Escalar para múltiplos contratos ou listener redundante depende primeiro de medir volume, consistência e comportamento sob reorg.
