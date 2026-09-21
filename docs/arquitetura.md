# Arquitetura

Backend da PoC de crédito interfinanceiro (CDI) overnight — Banco Inter × Inteli Blockchain.

## Contexto

Bancos emprestam reservas entre si por um dia útil (overnight) para fechar o caixa dentro do mínimo regulatório. A taxa média dessas operações é o CDI. Hoje a negociação leva minutos e a liquidação leva horas, por conta de checagem manual de limite e conciliação. Nessa janela existe risco de contraparte: a operação foi combinada mas ainda não foi consumada.

A PoC elimina essa janela. O contrato inteligente valida o limite e executa a troca — token de crédito de um lado, ativo de liquidação do outro — em uma única transação atômica (DvP, *delivery versus payment*). Ou as duas pernas acontecem, ou nenhuma.

## Stack

| Camada | Escolha |
|---|---|
| Runtime | Node.js 24 LTS |
| Linguagem | TypeScript, modo estrito |
| HTTP | Fastify 5 |
| Banco | PostgreSQL |
| Acesso ao banco | `pg` + migrations SQL versionadas |
| Leitura on-chain | `viem` (somente leitura) |
| Rede | Sepolia (testnet) |

Sem ORM: a modelagem exige diagrama entidade-relacionamento explícito e migrations versionadas, e SQL puro deixa isso literal.

## Diagrama

O diagrama de componentes fica no [README](../README.md#arquitetura), fonte única. Esta seção descreve o que ele mostra.

O caminho de uma operação, do clique à tela:

1. O frontend registra a intenção na API, que grava a oferta como `pendente` e devolve os argumentos normalizados (valor em wei, taxa em basis points, endereço do contrato).
2. A carteira do operador monta e assina a chamada ao contrato. O backend não participa deste passo.
3. O contrato valida o limite e executa o swap atômico na mesma transação.
4. O contrato emite o evento. O listener recebe por `eth_subscribe`, grava no Postgres e dispara `NOTIFY`.
5. A API, escutando via `LISTEN`, empurra a mudança para o frontend.

## Componentes

### Mesa de Operações (React)

Exibe ofertas abertas, limites disponíveis e status das operações (RF04). Não decide nada: renderiza o que a API devolve. Descobre mudanças de status perguntando à API periodicamente.

### Carteira (MetaMask)

Guarda a chave privada do operador e assina as transações. É ela — não o backend — que chama o contrato. A interface precisa tratar três recusas comuns: assinatura negada, rede errada e saldo de gas insuficiente.

### API (Fastify)

Rotas de oferta, aceite, cancelamento e histórico (RF05, RF06). As rotas de oferta e aceite **registram a intenção** e devolvem ao frontend o que ele precisa para montar a chamada ao contrato; elas não executam a operação. A execução é on-chain.

### Listener de eventos (viem)

Lê os eventos do contrato na Sepolia e grava o resultado no Postgres: status, hash da transação, número do bloco, timestamp, partes e taxa (RNF03). É a costura entre Web3 e Web2, e o componente mais crítico do backend.

### PostgreSQL

Contrapartes, limites, histórico de operações e o cursor de sincronização. É sempre um espelho atrasado da chain, nunca a fonte de verdade.

### RPC provider

Nó de terceiro (Alchemy/Infura) pelo qual frontend e listener alcançam a Sepolia.

### Contratos (Solidity/Foundry)

Contrato de liquidação DvP e token ERC-20 fictício representando o crédito. Fora do escopo deste repositório; o backend consome apenas o ABI publicado.

## Decisões

### O backend não assina transações

`viem` é usado somente para leitura. Quem assina é a carteira do operador.

Alternativa descartada: backend com chave custodial (relayer). Seria mais fácil de demonstrar, mas colocaria o backend no caminho crítico da liquidação e enfraqueceria o argumento central do projeto — a operação acontece no contrato, sem intermediário confiável.

Consequência: o backend é fonte de verdade off-chain e indexador, nunca executor.

### O listener é um cursor, não um watcher

Um watcher (`watchContractEvent`) só entrega o que acontece enquanto está ligado. Qualquer parada — deploy, restart, oscilação de rede — perde os eventos daquele intervalo de forma definitiva.

O listener guarda no Postgres o último bloco processado e, a cada ciclo, busca os logs do intervalo pendente:

```
ultimo = lê cursor do banco
atual  = client.getBlockNumber()
logs   = client.getLogs({ address, fromBlock: ultimo + 1, toBlock: atual })
grava logs com UPSERT
escreve cursor = atual
```

Se o processo cair em qualquer ponto, ele recomeça do último bloco confirmado.

### A gravação é idempotente

`UPSERT` por chave natural `(tx_hash, log_index)`. O mesmo evento será reprocessado — em restart, em retry do RPC, em reorg — e reprocessar não pode duplicar histórico.

Efeito colateral relevante: idempotência é também o que permite rodar mais de uma instância do listener em paralelo, caso um dia seja preciso redundância.

### WebSocket para o gatilho, cursor como rede de segurança

O listener recebe os eventos por `eth_subscribe` (transport `webSocket` do `viem`), que entrega assim que o evento aparece, em vez de perguntar a cada intervalo.

WebSocket falha de um jeito específico: a conexão pode permanecer aberta e parar de entregar, sem erro. O `viem` reconecta sozinho, mas todo evento ocorrido durante a queda se perde — nenhum mecanismo de push recupera o que passou enquanto ele estava fora.

É o cursor que resolve isso. Na conexão e em cada reconexão, o listener busca o intervalo entre o último bloco processado e o atual antes de voltar a escutar. WebSocket entrega rápido; o cursor garante que nada se perde. Os dois juntos, não um no lugar do outro.

Alternativa descartada: polling HTTP a cada 4 segundos. Mais simples, e suficiente para o RNF02, mas desperdiça chamadas de RPC e adiciona latência sem necessidade.

O gatilho do ciclo fica isolado em uma função. Trocar para polling, se o WebSocket se mostrar instável na Sepolia, é uma alteração de uma linha que não toca no restante do listener.

### Sem proteção contra reorg

A Sepolia pode reorganizar os últimos blocos. A proteção usual é processar com atraso de alguns blocos, ao custo de ~24s de latência adicional — o que estouraria o orçamento do RNF02.

Mitigação adotada: o `block_number` é registrado em cada operação, permitindo auditoria posterior. O risco é aceito e documentado.

## Orçamento de latência (RNF02: 30 segundos)

| Etapa | Pior caso |
|---|---|
| Transação incluída em bloco (Sepolia) | ~12s |
| Listener recebe o evento (WebSocket) | ~0s |
| Gravação no Postgres | ~ms |
| Frontend percebe a mudança (polling 3s) | 3s |
| **Total** | **~15s** |

A folga é de cerca de 15 segundos. Quase todo o orçamento é consumido pelo tempo de bloco da Sepolia, que não está sob controle do backend.

## Riscos conhecidos

**O listener falha em silêncio.** Se ele parar, o sistema continua aparentemente funcionando: a chain avança, o banco congela, a interface mostra dados desatualizados sem indicar erro. Mitigação: registrar o timestamp da última sincronização e expô-lo na API, sinalizando na interface quando ultrapassar um minuto.

**Estado órfão.** A oferta é gravada como `ofertada` no passo 1, mas o operador pode não assinar no passo 3. Mitigação: estado `pendente` com validade, promovido a `ofertada` apenas quando o evento correspondente for indexado.

**Limite de crédito em duas fontes.** O contrato valida um limite on-chain; o Postgres guarda outro para exibição. Divergência faz o aceite falhar sem explicação na interface. Exige definição, junto ao time de contratos, de quem sincroniza e com que frequência.

**Queda silenciosa da conexão WebSocket.** A conexão pode parar de entregar sem fechar. Mitigação: reconexão automática do `viem`, ressincronização pelo cursor a cada reconexão, e o timestamp da última sincronização exposto na API.

## Caminho para produção

As decisões acima são adequadas a uma PoC em testnet pública. Um sistema em produção no Inter partiria de premissas diferentes:

**Nó próprio, não provedor de terceiro.** Infraestrutura de liquidação não depende de RPC externo. Com nó dedicado, desaparecem o rate limit, o custo por chamada e o limite de conexões simultâneas que um provedor compartilhado impõe.

**Rede permissionada, não Sepolia.** Redes com finalização imediata (Besu/QBFT e similares) não sofrem reorg, o que elimina uma classe inteira de preocupações do indexador. A escolha da rede é objeto do benchmark entregue em paralelo a este repositório.

**Conexão mais estável, mesmo desenho.** O gatilho por WebSocket sobre cursor já é o desenho adotado; com nó dedicado ele deixa de sofrer as quedas típicas de um RPC compartilhado. O cursor continua obrigatório: nenhum mecanismo de push sobrevive a um deploy sem perder eventos.

**Listener redundante.** Mais de uma instância, viável sem alteração de código graças à idempotência da gravação.

**Indexer dedicado.** Com dezenas de contratos, o listener artesanal dá lugar a uma solução própria ou pronta (Ponder, Subsquid), com fila entre leitura e gravação, dead-letter e reprocessamento seletivo.
