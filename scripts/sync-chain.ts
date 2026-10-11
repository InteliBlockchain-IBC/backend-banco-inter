import { chainWorkerConfigFromEnv } from "../src/blockchain/config.js";
import { chainErrorLog } from "../src/blockchain/logging.js";
import { syncChain } from "../src/blockchain/sync.js";

// Execução avulsa (cron/manual): processa lotes até alcançar o head seguro.
try {
  const { options } = chainWorkerConfigFromEnv();
  let indexed = 0;
  for (;;) {
    const result = await syncChain(options);
    indexed += result.indexed;
    console.log(JSON.stringify(result));
    if (result.caughtUp) break;
  }
  console.log(JSON.stringify({ caughtUp: true, indexed }));
} catch (error) {
  console.error(
    JSON.stringify(
      chainErrorLog(error, "falha na sincronização da blockchain"),
    ),
  );
  process.exitCode = 1;
}
