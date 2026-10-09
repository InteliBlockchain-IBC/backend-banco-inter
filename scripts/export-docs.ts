/**
 * Gera os artefatos que o frontend consome sem subir a API:
 * - docs/openapi.json: contrato OpenAPI desta versão;
 * - docs/collection/backend-banco-inter.postman_collection.json: coleção
 *   Postman v2.1 com cada requisição e exemplos de resposta reais, obtidos
 *   chamando a própria API mock (inclui os erros mais comuns).
 *
 * Uso: npm run docs:export
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION, buildApp } from "../src/app.js";
import { mockOfferId, mockWallets } from "../src/demo/fixtures.js";

// dist/scripts/export-docs.js -> raiz do repositório
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLE_CLOCK = new Date("2026-09-29T12:00:00.000Z");

type Example = {
  body?: unknown;
  name: string;
  path: string;
  wallet?: string;
};

type Entry = {
  description?: string;
  examples?: Example[];
  method: "GET" | "POST";
  name: string;
  /** Caminho com variáveis Postman, ex.: /api/offers/{{openOfferId}}. */
  path: string;
  /** Caminho real usado para gerar o exemplo principal. */
  samplePath: string;
  body?: unknown;
  test?: string[];
  walletVar?: string;
};

type Folder = { description: string; items: Entry[]; name: string };

const vars = {
  baseUrl: "http://127.0.0.1:3000",
  borrowerWallet: mockWallets.beta,
  lenderWallet: mockWallets.alfa,
  openOfferId: mockOfferId(8),
  cancelOfferId: mockOfferId(9),
  mockOfferId: "",
  requestId: "",
  settledOfferId: mockOfferId(1),
  settledTxHash: "",
};

const createBody = {
  amountCents: "100000000",
  borrowerWallet: "{{borrowerWallet}}",
  rateCdiBps: 10500,
  termDays: 1,
  validitySeconds: 3600,
};
const mockBody = { lenderWallet: "{{lenderWallet}}", ...createBody };
const resolveVars = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String(vars[name as keyof typeof vars] ?? ""),
    ),
  );

async function main(): Promise<void> {
  let nextId = 0;
  const app = await buildApp({
    logger: false,
    nodeEnv: "development",
    // ids fixos para o arquivo gerado não mudar a cada export
    newId: () =>
      `f0000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    now: () => EXAMPLE_CLOCK,
  });
  await app.ready();

  const settled = await app.inject({
    method: "GET",
    url: "/api/operations?limit=1",
  });
  vars.settledTxHash = settled.json().data[0].txHash;

  const folders: Folder[] = [
    {
      description: "Endereços e cursor fictícios, sem deploy ou listener.",
      items: [
        {
          method: "GET",
          name: "Endereços fictícios",
          path: "/api/deployment",
          samplePath: "/api/deployment",
        },
        {
          method: "GET",
          name: "Cursor simulado",
          path: "/api/sync-status",
          samplePath: "/api/sync-status",
        },
      ],
      name: "Rede",
    },
    {
      description:
        "Leitura de ofertas e intenções fictícias em development/test. contractCall traz endereços sintéticos; não assinar nem enviar.",
      items: [
        {
          examples: [
            { name: "Página de 2", path: "/api/offers?limit=2" },
            {
              name: "400 - status desconhecido",
              path: "/api/offers?status=accepted",
            },
          ],
          method: "GET",
          name: "Listar ofertas",
          path: "/api/offers",
          samplePath: "/api/offers",
        },
        {
          method: "GET",
          name: "Ofertas abertas recebidas pelo tomador",
          path: "/api/offers?status=offered&wallet={{borrowerWallet}}&role=borrower",
          samplePath: `/api/offers?status=offered&wallet=${vars.borrowerWallet}&role=borrower`,
        },
        {
          examples: [
            { name: "Liquidada", path: `/api/offers/${vars.settledOfferId}` },
            {
              name: "404 - oferta inexistente",
              path: `/api/offers/${mockOfferId(999)}`,
            },
          ],
          method: "GET",
          name: "Detalhar oferta",
          path: "/api/offers/{{openOfferId}}",
          samplePath: `/api/offers/${vars.openOfferId}`,
        },
        {
          method: "GET",
          name: "Histórico da oferta",
          path: "/api/offers/{{settledOfferId}}/events",
          samplePath: `/api/offers/${vars.settledOfferId}/events`,
        },
        {
          body: createBody,
          description:
            "Salva o id da intenção em {{requestId}} para a requisição de envio do hash.",
          examples: [
            {
              body: { ...createBody, amountCents: "99900000000" },
              name: "422 - limite insuficiente",
              path: "/api/offers",
              wallet: vars.lenderWallet,
            },
            {
              body: { ...createBody, borrowerWallet: vars.lenderWallet },
              name: "422 - tomador igual ao ofertante",
              path: "/api/offers",
              wallet: vars.lenderWallet,
            },
            {
              body: createBody,
              name: "403 - carteira revogada",
              path: "/api/offers",
              wallet: mockWallets.delta,
            },
            {
              body: { ...createBody, amountCents: 100000000 },
              name: "400 - amountCents como número",
              path: "/api/offers",
              wallet: vars.lenderWallet,
            },
          ],
          method: "POST",
          name: "Criar oferta (intenção)",
          path: "/api/offers",
          samplePath: "/api/offers",
          test: [
            "if (pm.response.code === 202) {",
            '  pm.collectionVariables.set("requestId", pm.response.json().data.id);',
            "}",
          ],
          walletVar: "lenderWallet",
        },
        {
          examples: [
            {
              name: "403 - quem aceita não é o tomador",
              path: `/api/offers/${vars.openOfferId}/accept`,
              wallet: vars.lenderWallet,
            },
            {
              name: "409 - oferta já liquidada",
              path: `/api/offers/${vars.settledOfferId}/accept`,
              wallet: vars.borrowerWallet,
            },
            {
              name: "409 - oferta vencida",
              path: `/api/offers/${mockOfferId(7)}/accept`,
              wallet: vars.lenderWallet,
            },
          ],
          method: "POST",
          name: "Aceitar oferta (intenção)",
          path: "/api/offers/{{openOfferId}}/accept",
          samplePath: `/api/offers/${vars.openOfferId}/accept`,
          walletVar: "borrowerWallet",
        },
        {
          method: "POST",
          name: "Rejeitar oferta (intenção)",
          path: "/api/offers/{{openOfferId}}/reject",
          samplePath: `/api/offers/${vars.openOfferId}/reject`,
          walletVar: "borrowerWallet",
        },
        {
          examples: [
            {
              name: "403 - quem cancela não é o ofertante",
              path: `/api/offers/${vars.openOfferId}/cancel`,
              wallet: vars.borrowerWallet,
            },
          ],
          method: "POST",
          name: "Cancelar oferta (intenção)",
          path: "/api/offers/{{openOfferId}}/cancel",
          samplePath: `/api/offers/${vars.openOfferId}/cancel`,
          walletVar: "lenderWallet",
        },
      ],
      name: "Ofertas",
    },
    {
      description:
        "Somente development/test: transições DvP sintéticas, sem autenticação ou transações reais. Criar preenche {{mockOfferId}}.",
      items: [
        {
          body: mockBody,
          method: "POST",
          name: "Criar oferta fictícia",
          path: "/api/mock/offers",
          samplePath: "/api/mock/offers",
          test: [
            "if (pm.response.code === 201) {",
            '  pm.collectionVariables.set("mockOfferId", pm.response.json().data.offer.id);',
            "}",
          ],
        },
        {
          method: "POST",
          name: "Aceitar oferta fictícia",
          path: "/api/mock/offers/{{mockOfferId}}/accept",
          samplePath: "/api/mock/offers/{{mockOfferId}}/accept",
        },
        {
          method: "POST",
          name: "Rejeitar oferta fictícia",
          path: "/api/mock/offers/{{openOfferId}}/reject",
          samplePath: `/api/mock/offers/${vars.openOfferId}/reject`,
        },
        {
          method: "POST",
          name: "Cancelar oferta fictícia",
          path: "/api/mock/offers/{{cancelOfferId}}/cancel",
          samplePath: `/api/mock/offers/${vars.cancelOfferId}/cancel`,
        },
      ],
      name: "Simulação DvP",
    },
    {
      description:
        "Rode 'Criar oferta (intenção)' antes: ele preenche {{requestId}}.",
      items: [
        {
          method: "GET",
          name: "Consultar intenção",
          path: "/api/transaction-requests/{{requestId}}",
          samplePath: "/api/transaction-requests/{{requestId}}",
        },
        {
          body: { txHash: `0x${"ab".repeat(32)}` },
          method: "POST",
          name: "Informar hash da transação",
          path: "/api/transaction-requests/{{requestId}}/submission",
          samplePath: "/api/transaction-requests/{{requestId}}/submission",
          walletVar: "lenderWallet",
        },
      ],
      name: "Intenções",
    },
    {
      description: "Operações fictícias, sem liquidação on-chain.",
      items: [
        {
          method: "GET",
          name: "Listar operações",
          path: "/api/operations?wallet={{lenderWallet}}",
          samplePath: `/api/operations?wallet=${vars.lenderWallet}`,
        },
        {
          examples: [
            { name: "400 - hash malformado", path: "/api/operations/0x1234" },
          ],
          method: "GET",
          name: "Detalhar operação",
          path: "/api/operations/{{settledTxHash}}",
          samplePath: `/api/operations/${vars.settledTxHash}`,
        },
      ],
      name: "Operações",
    },
    {
      description: "Limites por carteira e histórico de mudanças.",
      items: [
        {
          examples: [
            { name: "Todas as carteiras", path: "/api/credit-limits" },
          ],
          method: "GET",
          name: "Tomadores elegíveis para uma oferta",
          path: "/api/credit-limits?registered=true&minAvailableCents=100000000&excludeWallet={{lenderWallet}}",
          samplePath: `/api/credit-limits?registered=true&minAvailableCents=100000000&excludeWallet=${vars.lenderWallet}`,
        },
        {
          method: "GET",
          name: "Detalhar limite",
          path: "/api/credit-limits/{{borrowerWallet}}",
          samplePath: `/api/credit-limits/${vars.borrowerWallet}`,
        },
        {
          method: "GET",
          name: "Histórico de limite",
          path: "/api/credit-limits/{{borrowerWallet}}/history",
          samplePath: `/api/credit-limits/${vars.borrowerWallet}/history`,
        },
      ],
      name: "Limites",
    },
    {
      description: "Processo e contrato da API.",
      items: [
        {
          method: "GET",
          name: "Liveness",
          path: "/health",
          samplePath: "/health",
        },
        {
          method: "GET",
          name: "Readiness",
          path: "/ready",
          samplePath: "/ready",
        },
        {
          method: "GET",
          name: "Contrato OpenAPI",
          path: "/openapi.json",
          samplePath: "/openapi.json",
        },
      ],
      name: "Saúde e documentação",
    },
  ];

  const toPostmanUrl = (path: string) => {
    const [pathname = "", query] = path.split("?");
    return {
      host: ["{{baseUrl}}"],
      path: pathname.split("/").filter(Boolean),
      ...(query === undefined
        ? {}
        : {
            query: query.split("&").map((pair) => {
              const [key = "", value = ""] = pair.split("=");
              return { key, value };
            }),
          }),
      raw: `{{baseUrl}}${path}`,
    };
  };

  const headersFor = (
    walletVar: string | undefined,
    hasBody: boolean,
    wallet?: string,
  ) => [
    ...(walletVar === undefined
      ? []
      : [
          {
            key: "X-Wallet-Address",
            value:
              wallet === undefined ||
              wallet === vars[walletVar as keyof typeof vars]
                ? `{{${walletVar}}}`
                : wallet,
          },
        ]),
    ...(hasBody ? [{ key: "Content-Type", value: "application/json" }] : []),
  ];

  const run = async (
    method: "GET" | "POST",
    path: string,
    body: unknown,
    wallet?: string,
  ) => {
    const response = await app.inject({
      headers: wallet === undefined ? {} : { "x-wallet-address": wallet },
      method,
      url: String(resolveVars(path)),
      ...(body === undefined ? {} : { payload: resolveVars(body) as object }),
    });
    return response;
  };

  const exampleFrom = async (
    entry: Entry,
    name: string,
    path: string,
    body: unknown,
    wallet: string | undefined,
  ) => {
    const response = await run(entry.method, path, body, wallet);
    const isOpenApi = path === "/openapi.json";
    return {
      body: isOpenApi
        ? "(documento OpenAPI completo; veja docs/openapi.json)"
        : JSON.stringify(response.json(), null, 2),
      code: response.statusCode,
      header: [
        {
          key: "Content-Type",
          value: String(response.headers["content-type"]),
        },
        ...(response.headers["x-data-source"] === undefined
          ? []
          : [{ key: "X-Data-Source", value: "mock" }]),
      ],
      name: /^\d{3} /.test(name) ? name : `${response.statusCode} - ${name}`,
      originalRequest: {
        header: headersFor(entry.walletVar, body !== undefined, wallet),
        method: entry.method,
        url: toPostmanUrl(path),
        ...(body === undefined
          ? {}
          : {
              body: {
                mode: "raw",
                options: { raw: { language: "json" } },
                raw: JSON.stringify(body, null, 2),
              },
            }),
      },
      status: response.statusMessage ?? "",
    };
  };

  const collectionFolders = [];
  const covered: string[] = [];
  for (const folder of folders) {
    const items = [];
    for (const entry of folder.items) {
      covered.push(`${entry.method} ${entry.path.split("?")[0]}`);
      const wallet =
        entry.walletVar === undefined
          ? undefined
          : String(vars[entry.walletVar as keyof typeof vars]);
      if (entry.path === "/api/offers" && entry.method === "POST") {
        // gera requestId real para os exemplos da pasta Intenções
        const created = await run("POST", "/api/offers", createBody, wallet);
        vars.requestId = created.json().data.id;
      }
      const responses = [
        await exampleFrom(
          entry,
          "exemplo",
          entry.samplePath,
          entry.body,
          wallet,
        ),
      ];
      if (entry.path === "/api/mock/offers" && entry.method === "POST") {
        vars.mockOfferId = JSON.parse(responses[0]?.body ?? "{}").data.offer.id;
      }
      for (const example of entry.examples ?? []) {
        responses.push(
          await exampleFrom(
            entry,
            example.name,
            example.path,
            example.body,
            example.wallet,
          ),
        );
      }
      const expectedStatus = responses[0]?.code;
      if (expectedStatus === undefined)
        throw new Error(`Exemplo principal ausente: ${entry.name}`);
      items.push({
        event: [
          {
            listen: "test",
            script: {
              exec: [
                'pm.test("Status HTTP esperado", () => {',
                `  pm.response.to.have.status(${expectedStatus});`,
                "});",
                ...(entry.test ?? []),
              ],
              type: "text/javascript",
            },
          },
        ],
        name: entry.name,
        request: {
          ...(entry.body === undefined
            ? {}
            : {
                body: {
                  mode: "raw",
                  options: { raw: { language: "json" } },
                  raw: JSON.stringify(entry.body, null, 2),
                },
              }),
          ...(entry.description === undefined
            ? {}
            : { description: entry.description }),
          header: headersFor(entry.walletVar, entry.body !== undefined),
          method: entry.method,
          url: toPostmanUrl(entry.path),
        },
        response: responses,
      });
    }
    collectionFolders.push({
      description: folder.description,
      item: items,
      name: folder.name,
    });
  }

  const collection = {
    info: {
      description: [
        `API do backend Banco Inter, versão ${API_VERSION}. Funciona com a API em memória ou com PostgreSQL (docker compose up).`,
        "",
        "X-Data-Source indica a origem: postgres (persistido) ou mock (memória). Os dados são sintéticos; erros são Problem Details.",
        "Ambiente local com banco: docker compose up (porta 3000). Ajuste {{baseUrl}} se necessário.",
        "Carteiras de exemplo: lenderWallet = Banco Alfa, borrowerWallet = Banco Beta.",
        "Somente intenções de assinatura exigem X-Wallet-Address, sem autenticar a carteira.",
        "POST só existe em development/test; production serve apenas consultas.",
        "Guia completo em docs/api.md.",
      ].join("\n"),
      name: "Backend Banco Inter - API",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      version: API_VERSION,
    },
    item: collectionFolders,
    variable: Object.entries({ ...vars, requestId: "", mockOfferId: "" }).map(
      ([key, value]) => ({
        key,
        value,
      }),
    ),
  };

  await mkdir(resolve(ROOT, "docs/collection"), { recursive: true });
  await writeFile(
    resolve(
      ROOT,
      "docs/collection/backend-banco-inter.postman_collection.json",
    ),
    `${JSON.stringify(collection, null, 2)}\n`,
  );
  await writeFile(
    resolve(ROOT, "docs/openapi.json"),
    `${JSON.stringify(app.swagger(), null, 2)}\n`,
  );
  await app.close();
  console.log(
    `Coleção e OpenAPI ${API_VERSION} gerados (${covered.length} requisições).`,
  );
}

await main();
