# Deploy e operação

## Acesso e testes

- Swagger: <https://banco-inter-api.212-38-89-33.sslip.io/docs/>
- Ofertas: <https://banco-inter-api.212-38-89-33.sslip.io/api/offers>
- Saúde do processo: <https://banco-inter-api.212-38-89-33.sslip.io/health>
- Prontidão do banco: <https://banco-inter-api.212-38-89-33.sslip.io/ready>
- OpenAPI: <https://banco-inter-api.212-38-89-33.sslip.io/openapi.json>

A demonstração permite consultas públicas, sem login. O PostgreSQL contém 30 ofertas, 5 carteiras e 8 operações de quatro instituições fictícias. O listener está desligado: os endereços e hashes do seed não comprovam transações na Sepolia.

### Pelo navegador

1. Abra o Swagger e expanda **GET /api/offers**, identificado como **Listar ofertas**.
2. Clique em **Try it out**, preencha `limit` com `2` e clique em **Execute**.
3. Confira o status `200`, dois itens em `data`, `meta.total = 30` e `meta.source = postgres`.
4. Copie um `id` retornado e use-o em **GET /api/offers/{id}** e **GET /api/offers/{id}/events**.

O Swagger faz as chamadas no próprio endereço da API. Não é necessário alterar o DNS do navegador nem aceitar exceções de certificado. A raiz `/` não tem página inicial; use os links acima.

O ambiente público usa `NODE_ENV=production`: as rotas de escrita retornam `404` e não aparecem no Swagger. Para exercitar criação, aceite, rejeição e cancelamento simulados, use o ambiente local descrito no [README](../README.md#começando). A coleção Postman do repositório inclui essas escritas locais; não espere que elas funcionem na demonstração pública.

### Pelo terminal

```bash
BASE=https://banco-inter-api.212-38-89-33.sslip.io
curl --fail-with-body --silent --show-error --max-time 30 "$BASE/health"
curl --fail-with-body --silent --show-error --max-time 30 "$BASE/ready"
curl --fail-with-body --silent --show-error --max-time 30 -D - "$BASE/api/offers?limit=2"
curl --fail-with-body --silent --show-error --max-time 30 "$BASE/openapi.json"
```

| Verificação | Resultado esperado |
| --- | --- |
| `/health` | 200, `{"status":"ok"}` |
| `/ready` | 200, dependência `postgres` com status `up` |
| `/api/offers` | 200, `meta.total = 30`, `X-Data-Source: postgres` |
| Detalhe e eventos de uma oferta da listagem | 200 |
| `/api/operations`, `/api/credit-limits` | 200, com operações e limites fictícios |
| `/api/deployment`, `/api/sync-status` | 200, com configuração e cursor sintéticos |
| `/docs/`, `/openapi.json` | 200; contrato público somente de leitura |
| POST `/api/offers` e `/api/mock/offers`, com JSON `{}` | 404 |
| Consulta inválida, como `/api/offers?limit=101` | 400, `application/problem+json` |
| `/.env`, `/.git/config` e `/src/config.ts` | 404, sem conteúdo dos arquivos |

`/health` testa o processo. `/ready` executa `SELECT 1`; não verifica migrations, conteúdo do seed ou sincronização on-chain. Por isso, a conferência após uma mudança também deve consultar os dados e executar uma chamada no Swagger.

## Configuração do serviço

A API roda em Node.js 24 como usuário sem privilégios. O PostgreSQL 17 usa armazenamento persistente. O proxy recebe HTTPS e encaminha as chamadas à porta interna `3000`; o banco atende apenas na rede interna, na porta `5432`.

No Easypanel, mantenha o PostgreSQL com **Exposed Port = 0**. Não habilite acesso público ao banco ou a um gerenciador de banco. A API também não precisa de porta exposta diretamente no host.

Configure as variáveis somente no ambiente privado do serviço:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
SEED_DEMO=if-empty
DATABASE_URL=<URL privada do banco>
```

Substitua o placeholder pela conexão interna, com senha exclusiva. Deixe **Create env file** desmarcado e não copie credenciais para documentos, imagens ou logs.

Comando de inicialização:

```sh
sh -c "node dist/scripts/setup-db.js && exec node dist/src/server.js"
```

O setup aplica migrations pendentes e o seed antes de iniciar o servidor. Se falhar, a API não inicia. `if-empty` preserva os dados nos próximos starts; não use `SEED_DEMO=reset` no serviço remoto.

Em **Domains**, mantenha o endereço indicado neste guia, HTTPS habilitado e destino HTTP interno na porta **3000**, caminho `/`. Após mudar o domínio, espere a emissão do certificado e valide o acesso sem `curl -k`, DNS forçado ou exceções no navegador. O endereço atual depende do serviço DNS `sslip.io`; uma futura mudança de domínio precisa da mesma verificação.

| Serviço | Reserva de memória | Limite de memória | Limite de CPU |
| --- | --- | --- | --- |
| API, uma réplica | 128 MB | 512 MB | 0,5 core |
| PostgreSQL | 128 MB | 512 MB | 1 core |

## Atualização e reinício

1. Execute os testes, a cobertura e as verificações de qualidade. Antes de alterar dados ou migrations, tenha um backup externo com restauração comprovada.
2. Confira espaço em disco e memória. A VPS foi encontrada com 90,5% do disco ocupado; faça uma nova leitura antes de cada atualização. Não remova volumes nem recursos de outros serviços.
3. Confira as variáveis, o comando de inicialização e a compatibilidade das migrations antes de iniciar a atualização. O envio pelo painel pode disparar a atualização imediatamente.
4. Acompanhe os logs de setup e inicialização. Não imprima a conexão do banco ou outras credenciais.
5. Repita as consultas da seção de testes, incluindo o Swagger em uma sessão nova do navegador.
6. Para verificar persistência, guarde as respostas de ofertas, operações e limites, reinicie somente a API e compare as respostas após `/ready` voltar a `200`.

A opção **Zero Downtime** está habilitada. A instância anterior pode continuar atendendo enquanto a nova executa o setup; as migrations precisam ser compatíveis com ambas. Sem healthcheck de container, essa opção não comprova ausência de indisponibilidade.

O `compose.yaml` é voltado ao desenvolvimento local. Seu padrão habilita escritas sem autenticação; não o exponha diretamente na internet.

## Backup e restauração

Não há backup externo ou agendamento configurado. O armazenamento persistente sobrevive a um reinício, mas não à perda da VPS. Resolva essa pendência antes de passar a depender dos dados ou executar migrations que os alterem.

1. Defina um destino externo privado e um caminho exclusivo para o banco em **Settings → Storage Providers**. A retenção não deve alcançar arquivos de outros serviços.
2. Confira a disponibilidade de agendamento na licença. Em **Backups**, configure destino e retenção, execute **Manual Run** e verifique o log e o arquivo no destino. Se não houver agendamento disponível, estabeleça um procedimento externo; não presuma que exista uma rotina automática.
3. Restaure uma cópia em outro PostgreSQL 17, vazio e isolado. A restauração substitui dados: confirme o destino antes de executá-la e nunca ensaie no banco usado pela API pública.
4. Compare tabelas, contagens, conteúdo e `schema_migrations`. Execute uma aplicação compatível com o schema restaurado e repita as consultas de verificação.
5. Registre o arquivo utilizado, o resultado e o responsável em um registro operacional privado.

O ensaio local de `pg_dump` em formato custom e `pg_restore --exit-on-error` recuperou 30 ofertas, 5 carteiras e 3 migrations. Ainda falta validar o destino externo e a restauração pelo painel.

## Recuperação de falhas

- Para reverter a aplicação, preserve o banco e use uma versão compatível com todas as migrations já aplicadas, inclusive nomes e checksums. Repita os testes de acesso. A reversão remota ainda não foi ensaiada.
- Se uma migration falhar, não altere arquivos já aplicados nem edite o ledger para forçar a subida. O runner faz uma transação por arquivo; os arquivos anteriores permanecem aplicados. Prefira uma correção aditiva revisada. Restaurar o banco exige backup verificado e autorização para substituir os dados.
- Se o banco ficar indisponível, `/health` pode continuar respondendo enquanto `/ready` falha. Confira disco, logs e conexão interna, sem expor o PostgreSQL.
- Se o setup parar, verifique o banco e os advisory locks. Os clientes de migration e seed não têm deadline próprio; não dispare várias inicializações nem encerre sessões de outros serviços.
- Para uma demonstração local independente, use `docker compose up --build -d`. Esse banco não recebe automaticamente os dados da VPS.

## Limites operacionais

As leituras são públicas e não há autenticação ou rate limit no aplicativo. Mantenha apenas dados fictícios e as escritas desativadas. A revisão de respostas e caminhos sensíveis não substitui uma auditoria completa da VPS.

CORS está configurado em `src/app.ts` com `@fastify/cors` para o frontend `https://frontend-banco-inter.onrender.com`. O Swagger continua funcionando no endereço da própria API. Para usar outro domínio de frontend, ajuste a origem permitida no backend. Essa configuração libera a leitura das respostas pelo navegador; erros 500 de `/api/deployment` ou `/api/credit-limits` devem ser investigados nos logs do backend pelo `correlationId` e pelo campo `code`.

Backup externo, alertas e acompanhamento do espaço em disco continuam pendentes. Não há monitoramento contínuo ou prova de capacidade sob carga. O listener desligado também impede usar esta demonstração como evidência de liquidação Sepolia ou da meta de latência RNF02.

## Referências

- [Easypanel: App service](https://easypanel.io/docs/services/app)
- [Easypanel: Postgres service](https://easypanel.io/docs/services/postgres)
- [Easypanel: database backups](https://easypanel.io/docs/backups/database)
- [Dockerfile](../Dockerfile), [setup do banco](../scripts/setup-db.ts), [migrations](../src/database/migrate.ts), [seed](../src/database/seed.ts) e [healthchecks](../src/http/routes/health.ts).
