import { setTimeout as delay } from "node:timers/promises";
import { chainErrorLog } from "./logging.js";
import {
  type ChainSyncOptions,
  type ChainSyncResult,
  syncChain,
} from "./sync.js";

export type ChainWorkerOptions = Readonly<{
  intervalMs: number;
  options: ChainSyncOptions;
  /** Encerra o loop entre passes (SIGTERM/SIGINT). */
  signal?: AbortSignal;
  /** Injeções para teste. */
  sync?: (options: ChainSyncOptions) => Promise<ChainSyncResult>;
  write?: (stream: "stdout" | "stderr", line: string) => void;
}>;

/** Espera máxima entre tentativas depois de falhas seguidas. */
export const MAX_BACKOFF_MS = 5 * 60_000;

/** Espera antes da próxima tentativa: dobra a cada falha, até MAX_BACKOFF_MS. */
export const retryDelay = (intervalMs: number, failures: number) =>
  Math.min(intervalMs * 2 ** Math.max(failures - 1, 0), MAX_BACKOFF_MS);

const defaultWrite = (stream: "stdout" | "stderr", line: string) =>
  (stream === "stdout" ? console.log : console.error)(line);

/**
 * Loop do listener. Enquanto há backlog, emenda um lote no outro sem esperar;
 * só dorme `intervalMs` quando o cursor alcança o head seguro. Uma falha não
 * encerra o processo: vira um log estruturado (com `code` e o número de falhas
 * seguidas) e uma nova tentativa com espera exponencial.
 */
export async function runChainWorker({
  intervalMs,
  options,
  signal,
  sync = syncChain,
  write = defaultWrite,
}: ChainWorkerOptions) {
  let failures = 0;
  while (!signal?.aborted) {
    let wait = intervalMs;
    try {
      const result = await sync(options);
      failures = 0;
      write("stdout", JSON.stringify({ level: "info", ...result }));
      if (!result.caughtUp) wait = 0;
    } catch (error) {
      failures += 1;
      wait = retryDelay(intervalMs, failures);
      write(
        "stderr",
        JSON.stringify({
          ...chainErrorLog(error, "falha na sincronização da blockchain"),
          consecutiveFailures: failures,
          retryInMs: wait,
        }),
      );
    }
    if (wait > 0)
      await delay(wait, undefined, signal ? { signal } : {}).catch(
        () => undefined,
      );
  }
}
