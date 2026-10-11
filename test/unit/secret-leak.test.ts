import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  chainErrorLog,
  safeChainErrorMessage,
} from "../../src/blockchain/logging.js";
import { type ChainReader, syncChain } from "../../src/blockchain/sync.js";
import { runChainWorker } from "../../src/blockchain/worker.js";

/**
 * Guarda contra vazamento de segredos em log, por classe e não por caso.
 *
 * 1. Matriz: cada formato de URL secreta (chave no path, no subdomínio, na
 *    query, em usuario:senha@, IPv6, banco) cruzado com cada forma como
 *    bibliotecas ecoam a URL em erros (viem, fetch, DNS, pg, JSON, URL
 *    codificada, logger em maiúsculas). Nenhum token sensível pode sobrar.
 * 2. Ponta a ponta: os scripts reais do worker rodam com segredos no ambiente
 *    e falhas reais de DNS; tudo o que sai em stdout/stderr é inspecionado.
 *
 * Um formato novo de provedor ou de mensagem entra como uma linha em
 * SECRETS ou TEMPLATES, e passa a ser verificado contra todos os outros.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type Secret = Readonly<{
  name: string;
  tokens: readonly string[];
  url: string;
}>;

/** URLs secretas e os trechos que, sozinhos, já entregam a credencial. */
const SECRETS: readonly Secret[] = [
  {
    name: "chave no path",
    tokens: ["Kp9xQ2LmZ7vRt4Wb8NcY1dFs"],
    url: "https://eth-sepolia.provider-a.example/v2/Kp9xQ2LmZ7vRt4Wb8NcY1dFs",
  },
  {
    name: "chave no subdomínio",
    tokens: ["apiKey123secret"],
    url: "https://apiKey123secret.rpc.provider-b.example/",
  },
  {
    name: "endpoint nomeado com token no path",
    tokens: ["misty-wild-river", "3f9a2b7c1d8e4f60a5b2c9d7e1f3a4b5"],
    url: "https://misty-wild-river.sepolia.provider-c.example/3f9a2b7c1d8e4f60a5b2c9d7e1f3a4b5/",
  },
  {
    name: "chave na query",
    tokens: ["QzX8vN2mL5kP9wR3"],
    url: "https://rpc.provider-d.example/rpc?apikey=QzX8vN2mL5kP9wR3&chain=sepolia",
  },
  {
    name: "basic auth",
    tokens: ["projectid99", "projsecretAbc123"],
    url: "https://projectid99:projsecretAbc123@rpc.provider-e.example/",
  },
  {
    name: "IPv6 com chave no path",
    tokens: ["ipv6SecretKey42"],
    url: "http://[fd00::1234]:8545/ipv6SecretKey42",
  },
  {
    name: "websocket",
    tokens: ["WsSecretToken555"],
    url: "wss://ws.provider-f.example/v3/WsSecretToken555",
  },
  {
    name: "banco com usuário, senha e host interno",
    tokens: ["operador_db", "Senh4-Forte-Db", "db-interno-prod"],
    url: "postgresql://operador_db:Senh4-Forte-Db@db-interno-prod.example:6543/banco",
  },
  {
    name: "banco com senha percent-encoded",
    tokens: ["p%40ss%2Fw0rd-longa", "p@ss/w0rd-longa"],
    url: "postgresql://app:p%40ss%2Fw0rd-longa@10.0.0.5:5432/x",
  },
];

/** Formas reais de uma URL aparecer numa mensagem de erro. */
const TEMPLATES: ReadonlyArray<
  readonly [string, (url: URL, raw: string, token: string) => string]
> = [
  [
    "viem HttpRequestError",
    (_u, raw) =>
      `HTTP request failed.\n\nURL: ${raw}\nRequest body: {"method":"eth_chainId"}\n\nDetails: fetch failed`,
  ],
  ["URL normalizada (host em minúsculas)", (u) => `URL: ${u.href}`],
  ["DNS (só o host)", (u) => `getaddrinfo ENOTFOUND ${u.hostname}`],
  ["conexão recusada (host:porta)", (u) => `connect ECONNREFUSED ${u.host}`],
  ["fetch", (u) => `request to ${u.href} failed, reason: socket hang up`],
  [
    "pg autenticação",
    (u) =>
      `password authentication failed for user "${decodeURIComponent(u.username)}"`,
  ],
  [
    "log de requisição (path e query)",
    (u) => `GET ${u.pathname}${u.search} 401`,
  ],
  ["JSON", (_u, raw) => JSON.stringify({ error: { url: raw } })],
  [
    "URL como parâmetro codificado",
    (_u, raw) => `callback=${encodeURIComponent(raw)}`,
  ],
  ["logger em maiúsculas", (_u, raw) => `ERRO: ${raw}`.toUpperCase()],
  ["token sozinho", (_u, _raw, token) => `Authorization: Bearer ${token}`],
];

/** Falha se qualquer token (ou sua forma codificada) aparecer, sem caixa. */
function assertNoLeak(
  output: string,
  secrets: readonly Secret[],
  where: string,
) {
  const haystack = output.toLowerCase();
  for (const secret of secrets)
    for (const token of secret.tokens)
      for (const form of new Set([token, encodeURIComponent(token)]))
        assert.ok(
          !haystack.includes(form.toLowerCase()),
          `${where}: "${secret.name}" vazou "${form}" em:\n${output}`,
        );
}

for (const secret of SECRETS) {
  test(`no log leaks a secret with ${secret.name}`, () => {
    const url = new URL(secret.url);
    for (const [template, render] of TEMPLATES)
      for (const token of secret.tokens) {
        const text = render(url, secret.url, token);
        const message = safeChainErrorMessage(new Error(text), [secret.url]);
        assertNoLeak(message, [secret], template);
        const line = JSON.stringify(
          chainErrorLog(new Error(text), "falha", [secret.url]),
        );
        assertNoLeak(line, [secret], `${template} (linha JSON)`);
      }
  });
}

/** Formas que trazem a URL inteira e legível, onde a regex de URL atua. */
const FULL_URL_TEMPLATES = new Set([
  "viem HttpRequestError",
  "URL normalizada (host em minúsculas)",
  "fetch",
  "JSON",
  "logger em maiúsculas",
]);

for (const secret of SECRETS) {
  test(`an unknown URL with ${secret.name} still loses path, query and credentials`, () => {
    // A URL não está entre os segredos configurados (outro provedor, outra
    // variável): só a regex protege. O host fica visível de propósito.
    const url = new URL(secret.url);
    const outsideHost = secret.tokens.filter(
      (token) => !url.hostname.toLowerCase().includes(token.toLowerCase()),
    );
    const scoped = { ...secret, tokens: outsideHost };
    for (const [template, render] of TEMPLATES) {
      if (!FULL_URL_TEMPLATES.has(template)) continue;
      const text = render(url, secret.url, "");
      assertNoLeak(
        safeChainErrorMessage(new Error(text), []),
        [scoped],
        template,
      );
    }
  });
}

test("secrets are read from the environment when none are passed", () => {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL,
  };
  const [rpc, , , , , , , db] = SECRETS;
  assert.ok(rpc && db);
  process.env.SEPOLIA_RPC_URL = rpc.url;
  process.env.DATABASE_URL = db.url;
  try {
    const text = `getaddrinfo ENOTFOUND db-interno-prod.example | path /v2/${rpc.tokens[0]} | auth "operador_db"`;
    assertNoLeak(safeChainErrorMessage(new Error(text)), [rpc, db], "env");
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Ponta a ponta: falhas reais, saída real
// ---------------------------------------------------------------------------

// Hosts .invalid nunca resolvem (RFC 6761): falha de DNS real e imediata.
const RPC_SECRET: Secret = {
  name: "RPC com chave no subdomínio e no path",
  tokens: ["rpcSubdomainKey77", "PathKeyZ9y8X7w6V5u4"],
  url: "https://rpcSubdomainKey77.provider.invalid/v2/PathKeyZ9y8X7w6V5u4",
};
const DB_SECRET: Secret = {
  name: "banco com host secreto",
  tokens: ["usuario_secreto", "SenhaDoBanco-987", "dbhostsecreto"],
  url: "postgresql://usuario_secreto:SenhaDoBanco-987@dbhostsecreto.invalid:5432/banco",
};

const listenerEnv = (extra: Record<string, string> = {}) => ({
  BRL_TOKEN_ADDRESS: "0x00000000000000000000000000000000000000b1",
  CDI_POSITION_TOKEN_ADDRESS: "0x00000000000000000000000000000000000000d1",
  CHAIN_SYNC_INTERVAL_MS: "1000",
  CREDIT_INTERBANK_OFFER_ADDRESS: "0x00000000000000000000000000000000000000c1",
  CREDIT_INTERBANK_OFFER_START_BLOCK: "100",
  DATABASE_URL: DB_SECRET.url,
  PATH: process.env.PATH ?? "",
  SEPOLIA_RPC_URL: RPC_SECRET.url,
  ...extra,
});

/** Executa um script compilado e devolve tudo o que ele escreveu. */
function run(
  script: string,
  env: Record<string, string>,
  stopAfterMs?: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [resolve(ROOT, "dist/scripts", script)],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer =
      stopAfterMs === undefined
        ? setTimeout(() => child.kill("SIGKILL"), 60_000)
        : setTimeout(() => child.kill("SIGTERM"), stopAfterMs);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

test("the running worker never prints the RPC or database secrets", async () => {
  const { code, output } = await run("watch-chain.js", listenerEnv(), 4_000);
  assertNoLeak(output, [RPC_SECRET, DB_SECRET], "watch-chain");
  const errors = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(errors.length >= 1, output);
  for (const line of errors) {
    assert.equal(line.message, "falha na sincronização da blockchain");
    assert.equal(line.level, "error");
  }
  assert.equal(code, 0, "SIGTERM encerra o worker de forma limpa");
});

test("a one-off sync failure exits 1 without printing secrets", async () => {
  const { code, output } = await run("sync-chain.js", listenerEnv());
  assert.equal(code, 1);
  assertNoLeak(output, [RPC_SECRET, DB_SECRET], "sync-chain");
  assert.match(output, /falha na sincronização da blockchain/);
});

test("invalid configuration aborts the boot without printing values", async () => {
  const wss: Secret = {
    name: "RPC wss inválido",
    tokens: ["WssBootSecret31337"],
    url: "wss://boot.provider.invalid/WssBootSecret31337",
  };
  const { code, output } = await run(
    "watch-chain.js",
    listenerEnv({
      CREDIT_INTERBANK_OFFER_START_BLOCK: "abc",
      SEPOLIA_RPC_URL: wss.url,
    }),
  );
  assert.notEqual(code, 0);
  assert.match(output, /SEPOLIA_RPC_URL/);
  assert.match(output, /CREDIT_INTERBANK_OFFER_START_BLOCK/);
  assertNoLeak(output, [wss, DB_SECRET], "boot");
});

test("a real database DNS failure inside syncChain is logged without secrets", async () => {
  // RPC respondendo Sepolia; o banco é que não resolve. As variáveis ficam no
  // ambiente, como no worker de verdade, e a linha é inspecionada crua.
  const chain = {
    getBlock: async () => ({ hash: `0x${"1".repeat(64)}`, timestamp: 1n }),
    getBlockNumber: async () => 200n,
    getChainId: async () => 11155111,
    getLogs: async () => [],
  } as unknown as ChainReader;
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL,
  };
  process.env.DATABASE_URL = DB_SECRET.url;
  process.env.SEPOLIA_RPC_URL = RPC_SECRET.url;
  const lines: string[] = [];
  const controller = new AbortController();
  try {
    await runChainWorker({
      intervalMs: 1_000,
      options: {
        brlTokenAddress: "0x00000000000000000000000000000000000000b1",
        client: chain,
        confirmations: 12,
        contractAddress: "0x00000000000000000000000000000000000000c1",
        databaseUrl: DB_SECRET.url,
        positionTokenAddress: "0x00000000000000000000000000000000000000d1",
        rpcUrl: RPC_SECRET.url,
        startBlock: 100,
      },
      signal: controller.signal,
      sync: async (options) => {
        try {
          return await syncChain(options);
        } finally {
          controller.abort();
        }
      },
      write: (_stream, line) => lines.push(line),
    });
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /ENOTFOUND|EAI_AGAIN/);
  assertNoLeak(lines.join("\n"), [DB_SECRET, RPC_SECRET], "syncChain/pg");
});
