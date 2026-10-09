import { syncChain } from "../src/blockchain/sync.js";
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} não configurada`);
  return value;
};
const result = await syncChain({
  databaseUrl: required("DATABASE_URL"),
  rpcUrl: required("SEPOLIA_RPC_URL"),
  contractAddress: required("CREDIT_INTERBANK_OFFER_ADDRESS") as `0x${string}`,
  brlTokenAddress: required("BRL_TOKEN_ADDRESS") as `0x${string}`,
  positionTokenAddress: required("CDI_POSITION_TOKEN_ADDRESS") as `0x${string}`,
  startBlock: Number(required("CREDIT_INTERBANK_OFFER_START_BLOCK")),
  confirmations: Number(process.env.CHAIN_SYNC_CONFIRMATIONS ?? "12"),
});
console.log(JSON.stringify(result));
