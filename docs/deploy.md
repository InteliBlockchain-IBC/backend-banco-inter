# Plano de deploy

Como publicar o backend da PoC (API + PostgreSQL) numa URL pública com healthcheck, para a entrega de **17/10** e o demo day de **21/10**. O ambiente é de demonstração em testnet: dados sintéticos, sem ativos reais.

## Resumo das decisões

| Decisão | Escolha | Motivo |
| --- | --- | --- |
| Provedor | **Render** (API e banco no mesmo painel) | Deploy direto do GitHub a partir do `Dockerfile` existente, Postgres gerenciado, plano gratuito e configuração versionada em [`render.yaml`](../render.yaml). |
| API | Web Service, runtime Docker, plano **free** | Mesma imagem do `docker compose`: o que roda local é o que vai ao ar. |
| Banco | Render Postgres 17, plano **free** | Mesma versão do compose. Conexão pela rede interna do Render. |
| Região | `virginia` | O Render não tem região na América do Sul; Virginia (leste dos EUA) é a mais próxima do Brasil. API e banco precisam estar na mesma região. |
| Migrations | No comando de start (`setup-db.js` antes do servidor) | O plano free não executa *pre-deploy command*; o `setup-db` é idempotente. |
| Ambiente | `NODE_ENV=production` | Só leituras (`GET`) ficam públicas; as rotas `/api/mock` e de intenção, sem autenticação, não são expostas na internet. |
| Branch | `main`, com auto-deploy | Cada merge na `main` publica. O CI precisa passar antes do merge. |

## Limites do plano gratuito e como lidar

Condições do Render consultadas em 06/10/2026 (fontes no fim do documento). Confirme antes de criar, porque mudam.

| Limite | Impacto | Como lidar |
| --- | --- | --- |
| Postgres free **expira 30 dias após a criação** (mais 14 dias de carência para virar pago); só 1 banco free por workspace; 1 GB | Criado em 06–10/10, vale até ~05–09/11: cobre 17/10 e 21/10. | Não criar antes de 06/10. Se o ambiente precisar durar além de novembro, migrar para o plano pago ou para o Neon (abaixo). |
| API free **hiberna após 15 min sem tráfego**; acordar leva ~1 min | A primeira requisição depois de um intervalo demora. No demo day isso aparece como "travou". | Acessar `/health` uns 5 minutos antes de apresentar e manter uma aba aberta. Alternativa segura: plano pago da API (instância Starter) só na semana do demo; conferir o valor em [render.com/pricing](https://render.com/pricing). |
| 750 horas de instância grátis por mês, por workspace | Suficiente para uma API. | Não criar outros serviços free no mesmo workspace. |
| Sem *pre-deploy command* | Migrations rodam a cada start. | Já tratado: `setup-db` só aplica o que falta, sob advisory lock. |

**Alternativa sem expiração:** banco no [Neon](https://neon.com/pricing) (plano free permanente, 1 GB por projeto, hiberna após 5 min) e API no Render. Muda só o `DATABASE_URL`, que passa a ser uma variável manual com `?sslmode=require`.

## Variáveis de ambiente

| Variável | Valor em produção | Quem define | Observação |
| --- | --- | --- | --- |
| `DATABASE_URL` | URL interna do banco | Render (`fromDatabase` no blueprint) | **Obrigatória** em production: sem ela a API não sobe. Nunca commitar. |
| `NODE_ENV` | `production` | blueprint | Desliga `/api/mock` e os POST de intenção. |
| `HOST` | `0.0.0.0` | blueprint | O padrão (`127.0.0.1`) não aceita conexões de fora do container. |
| `PORT` | definida pelo Render | Render | `src/config.ts` já lê `PORT`. |
| `SEED_DEMO` | `if-empty` | blueprint | Grava a massa de demonstração só no primeiro start. `reset` recria a cada start: **não deixar ligado**. |

Futuro (não existem ainda no código): `SEPOLIA_RPC_URL` e endereço/ABI do contrato quando o listener entrar (Semana 4), e a origem do frontend quando a API ganhar CORS.

## Passo a passo

### 1. Pré-requisitos

- O PR desta entrega mergeado na `main`, com CI verde.
- Conta no [Render](https://render.com) com acesso à organização `InteliBlockchain-IBC` no GitHub (o Render pede autorização para ler o repositório).
- `docker compose up --build` funcionando localmente: é a mesma imagem que vai ao ar.

### 2. Criar a API e o banco pelo blueprint

1. Render Dashboard → **New** → **Blueprint**.
2. Selecione o repositório `backend-banco-inter`. O Render lê o [`render.yaml`](../render.yaml) e mostra o serviço `backend-banco-inter` e o banco `banco-inter-db`.
3. Confirme em **Apply**. O Render cria o banco, constrói a imagem pelo `Dockerfile` e sobe a API com `DATABASE_URL` já ligada ao banco.
4. No primeiro start, o log deve mostrar:
   ```
   Migrações aplicadas: 001_initial_schema.sql, 002_institution_wallets.sql
   Seed de demonstração gravado (9 ofertas, modo if-empty).
   ... "dataSource":"postgres" ... fonte de dados configurada
   ... Server listening at http://0.0.0.0:10000
   ```

Sem blueprint, dá para criar à mão: **New → Postgres** (free, Virginia, versão 17) e depois **New → Web Service** (Docker, free, Virginia), com as variáveis da tabela acima, *Docker Command* igual ao `dockerCommand` do `render.yaml` e *Health Check Path* `/health`.

### 3. Verificar

Com a URL pública (`https://backend-banco-inter.onrender.com` ou a que o Render atribuir):

| Verificação | Esperado |
| --- | --- |
| `GET /health` | `200 {"status":"ok"}` |
| `GET /ready` | `200`, com `{"name":"postgres","status":"up"}` em `dependencies` |
| `GET /api/offers` | `200`, cabeçalho `X-Data-Source: postgres`, `meta.total` = 9 |
| `GET /api/credit-limits` | 5 carteiras, duas do Banco Alfa |
| `POST /api/mock/offers` | `404` (production não expõe simulação) |
| `GET /docs` | Swagger UI |

Registre a URL no README principal e no board do projeto.

### 4. Atualizações

- **Código:** merge na `main` → o Render reconstrói e publica sozinho. Se o healthcheck falhar, a versão anterior continua no ar.
- **Migration nova:** só criar o arquivo `migrations/NNN_nome.sql`. O próximo start aplica.
- **Renovar a massa de demonstração** (horários relativos ao seed, então as ofertas abertas vencem em 1 hora): copie a *External Database URL* do banco no painel do Render e rode localmente:
  ```bash
  DATABASE_URL="<external url>?sslmode=require" npm run db:seed -- --reset
  ```
  No PowerShell: `$env:DATABASE_URL="<external url>?sslmode=require"; npm run db:seed -- --reset`. Não precisa reiniciar a API.

  A conexão externa do Render exige TLS. Se o driver recusar o certificado, troque por `?sslmode=no-verify` (aceitável aqui porque os dados são sintéticos; não use com dados reais).

### 5. Reverter

- **Código:** no painel do serviço, **Events** → deploy anterior → **Rollback**.
- **Dados:** como tudo é sintético, o caminho é recriar a massa com o seed `--reset` (passo 4). O plano free não tem backup automático; não guardar nada que não possa ser recriado.

## Checklist do demo day (21/10)

- [ ] Até 20/10: banco ainda dentro dos 30 dias (data de criação no painel).
- [ ] No dia: seed `--reset` cerca de 30 minutos antes, para haver ofertas abertas.
- [ ] 5 minutos antes: abrir `/ready` para acordar a API e confirmar o banco.
- [ ] Manter `/docs` aberto numa aba como plano B para mostrar a API.
- [ ] Ter o `docker compose up` rodando num notebook como contingência se o Render cair.

## Riscos e limites

- **Hibernação e expiração** do plano free (tabela acima). Eliminar os dois exige instância paga da API e banco pago; valores em [render.com/pricing](https://render.com/pricing), a confirmar com quem for pagar antes de contratar.
- **Dados sintéticos em URL pública.** Hashes e endereços não existem na Sepolia; a API marca a origem (`X-Data-Source`). Não divulgar a URL como se mostrasse operações reais.
- **Sem autenticação.** Em production as leituras são públicas; nenhum dado real deve ir para este banco.
- **CORS ainda não configurado.** Quando o frontend chamar a API pelo navegador (Semana 4), a API precisa liberar a origem do frontend. Pendência registrada para a integração.
- **Latência:** a região Virginia acrescenta a ida e volta Brasil–EUA a cada chamada. Aceitável para a PoC; não usar estas medidas como evidência do RNF02.

## Fontes

- [Render — Deploy for Free](https://render.com/docs/free) (hibernação de 15 min, ~1 min para acordar, 750 h/mês, Postgres free expira em 30 dias + 14 de carência, 1 GB, 1 banco por workspace)
- [Render — Deploys](https://render.com/docs/deploys) ("The pre-deploy command is available for paid web services…")
- [Render — Blueprint YAML Reference](https://render.com/docs/blueprint-spec) (campos do `render.yaml` e regiões)
- [Neon — Pricing](https://neon.com/pricing) (plano free permanente, 1 GB por projeto, hiberna após 5 min)
