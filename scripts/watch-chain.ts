import { syncChain } from "../src/blockchain/sync.js";

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} não configurada`);
  return value;
};
const intervalText = process.env.CHAIN_SYNC_INTERVAL_MS ?? "15000";
if (!/^[0-9]+$/.test(intervalText) || Number(intervalText) < 1_000)
  throw new Error(
    "CHAIN_SYNC_INTERVAL_MS deve ser um inteiro de ao menos 1000.",
  );
const options = {
  databaseUrl: required("DATABASE_URL"),
  rpcUrl: required("SEPOLIA_RPC_URL"),
  contractAddress: required("CREDIT_INTERBANK_OFFER_ADDRESS") as `0x${string}`,
  brlTokenAddress: required("BRL_TOKEN_ADDRESS") as `0x${string}`,
  positionTokenAddress: required("CDI_POSITION_TOKEN_ADDRESS") as `0x${string}`,
  startBlock: Number(required("CREDIT_INTERBANK_OFFER_START_BLOCK")),
  confirmations: Number(process.env.CHAIN_SYNC_CONFIRMATIONS ?? "12"),
};
const interval = Number(intervalText);

while (true) {
  try {
    console.log(JSON.stringify(await syncChain(options)));
  } catch (error) {
    // Não derruba o worker por uma indisponibilidade transitória de RPC/banco.
    console.error(error);
  }
  await new Promise((resolve) => setTimeout(resolve, interval));
}
