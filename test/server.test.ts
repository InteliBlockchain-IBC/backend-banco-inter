import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entryPoint = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/server.js",
);

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() =>
      resolve(
        typeof address === "object" && address !== null ? address.port : 0,
      ),
    );
  });
  return promise;
}

/**
 * Espera o evento, não um relógio: o processo anuncia a porta no log. O prazo é
 * apenas guarda contra travar, e nunca é usado como espera.
 */
async function waitForListening(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => reject(new Error("o processo não anunciou a porta dentro do prazo")),
    timeoutMs,
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.includes("Server listening")) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`o processo encerrou antes de ouvir, com código ${code}`));
  });
  return promise;
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  const timer = setTimeout(
    () => reject(new Error("o processo não encerrou dentro do prazo")),
    timeoutMs,
  );
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
  return promise;
}

test("the module exposes the instance it started", async () => {
  const port = await freePort();
  process.env.HOST = "127.0.0.1";
  process.env.NODE_ENV = "test";
  process.env.PORT = String(port);

  // Import dinâmico deliberado, para exercitar a fronteira de carregamento: o
  // módulo lê `process.env` e abre a porta no topo, então o ambiente precisa
  // estar definido antes de ele ser avaliado. Um import estático o executaria
  // na coleta do arquivo, antes destas linhas.
  const serverModule = await import("../src/server.js");
  const app = await serverModule.started;

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });

  await app.close();
});

test("the entry point serves health and exits cleanly on SIGTERM", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [entryPoint], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForListening(child, 20_000);

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);

    child.kill("SIGTERM");
    assert.equal(await waitForExit(child, 20_000), 0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
});

test("an invalid configuration stops the process before it listens", async () => {
  const child = spawn(process.execPath, [entryPoint], {
    env: { ...process.env, PORT: "abc" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  assert.notEqual(await waitForExit(child, 20_000), 0);
  assert.match(stderr, /PORT deve ser um inteiro decimal/);
});

/** Envia um caminho cru, para que `%ZZ` chegue ao servidor sem normalização. */
async function probe(port: number, rawPath: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const request = http.request(
    { host: "127.0.0.1", method: "GET", path: rawPath, port },
    (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    },
  );
  request.once("error", reject);
  request.end();
  return promise;
}

test("the production logger keeps secrets out and separates 4xx from 5xx", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [entryPoint], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  try {
    await waitForListening(child, 20_000);

    assert.equal(await probe(port, "/health?segredo=valor-sensivel"), 200);
    assert.equal(await probe(port, "/api/offers/%ZZ"), 400);
    assert.equal(await probe(port, "/api/offers?unexpected=true"), 400);

    child.kill("SIGTERM");
    await waitForExit(child, 20_000);
    if (child.stdout && !child.stdout.readableEnded) {
      await once(child.stdout, "close");
    }

    assert.doesNotMatch(output, /valor-sensivel/);
    assert.match(output, /"url":"\/health"/);
    assert.match(output, /requisição rejeitada antes do handler/);
    assert.match(output, /"level":40/);
    assert.doesNotMatch(output, /"level":50/);
    assert.doesNotMatch(output, /"stack"/);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
});
