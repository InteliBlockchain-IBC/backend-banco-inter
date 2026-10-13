import { chainWorkerConfigFromEnv } from "../src/blockchain/config.js";
import { runChainWorker } from "../src/blockchain/worker.js";

const config = chainWorkerConfigFromEnv();
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort());

await runChainWorker({ ...config, signal: controller.signal });
