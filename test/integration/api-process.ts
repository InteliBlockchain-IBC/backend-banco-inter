import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const BOOT_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_START_ATTEMPTS = 3;
const ENTRY_POINT = fileURLToPath(
  new URL("../../src/server.js", import.meta.url),
);

type Exit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const closed = once(server, "close");
  server.close();
  await closed;
  return address.port;
}

async function waitUntilListening(child: ChildProcess): Promise<void> {
  const ready = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => ready.reject(new Error("A API não anunciou a porta dentro do prazo")),
    BOOT_TIMEOUT_MS,
  );
  let stdout = "";
  const onData = (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.includes("Server listening")) ready.resolve();
  };
  const onClose = (code: number | null) =>
    ready.reject(
      new Error(`A API encerrou antes de ouvir (código ${code}): ${stdout}`),
    );
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("close", onClose);
  child.once("error", ready.reject);
  try {
    await ready.promise;
  } finally {
    clearTimeout(timer);
    child.stdout?.off("data", onData);
    child.stderr?.off("data", onData);
    child.off("close", onClose);
    child.off("error", ready.reject);
  }
}

async function stopChild(child: ChildProcess, exited: Promise<Exit>) {
  const timer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
  try {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    return await exited;
  } finally {
    clearTimeout(timer);
  }
}

export async function startApi(
  t: TestContext,
  databaseUrl: string,
  nodeEnv: "production" | "test" = "production",
) {
  for (let attempt = 1; ; attempt++) {
    const port = await unusedPort();
    const child = spawn(process.execPath, [ENTRY_POINT], {
      env: {
        DATABASE_URL: databaseUrl,
        HOST: "127.0.0.1",
        NODE_ENV: nodeEnv,
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    const exited = once(child, "close").then(
      ([code, signal]): Exit => ({ code, signal }),
    );
    try {
      await waitUntilListening(child);
    } catch (error) {
      await stopChild(child, exited);
      // PORT=0 não é aceito pelo entrypoint. Recomeçar só na corrida de bind.
      if (
        attempt < MAX_START_ATTEMPTS &&
        error instanceof Error &&
        error.message.includes("EADDRINUSE")
      )
        continue;
      throw error;
    }
    const stop = async () => {
      const exit = await stopChild(child, exited);
      assert.ok(
        exit.code === 0 ||
          (process.platform === "win32" && exit.signal === "SIGTERM"),
        `A API não encerrou normalmente: ${JSON.stringify(exit)}`,
      );
    };
    t.after(stop);
    return { baseUrl: `http://127.0.0.1:${port}`, stop };
  }
}

export async function readApi<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(response.headers.get("x-data-source"), "postgres");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const body = JSON.parse(text) as { data: T; meta: { source: string } };
  assert.equal(body.meta.source, "postgres");
  return body.data;
}
