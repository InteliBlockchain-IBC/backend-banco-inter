import { type Address, isAddress } from "viem";
import type { ChainSyncOptions } from "./sync.js";

export type ChainWorkerConfig = Readonly<{
  /** Espera entre passes quando o cursor já alcançou o head seguro. */
  intervalMs: number;
  options: ChainSyncOptions;
}>;

const INTEGER = /^[0-9]+$/;

/**
 * Lê e valida a configuração do listener no boot. Um valor inválido derruba o
 * processo uma vez, com o nome da variável, em vez de virar um erro repetido a
 * cada passe. As mensagens citam apenas nomes de variáveis, nunca valores.
 */
export function chainWorkerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ChainWorkerConfig {
  const errors: string[] = [];
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) errors.push(`${key} não configurada`);
    return value ?? "";
  };
  const integer = (key: string, fallback: string, min: number) => {
    const text = env[key]?.trim() || fallback;
    if (!INTEGER.test(text) || Number(text) < min) {
      errors.push(`${key} deve ser um inteiro de ao menos ${min}`);
      return min;
    }
    return Number(text);
  };
  const contract = (key: string) => {
    const value = required(key);
    if (value && !isAddress(value, { strict: false }))
      errors.push(`${key} não é um endereço EVM válido`);
    return value as Address;
  };
  const rpcUrl = required("SEPOLIA_RPC_URL");
  if (rpcUrl && !/^https?:\/\//iu.test(rpcUrl))
    errors.push("SEPOLIA_RPC_URL deve usar http:// ou https://");

  const options: ChainSyncOptions = {
    brlTokenAddress: contract("BRL_TOKEN_ADDRESS"),
    confirmations: integer("CHAIN_SYNC_CONFIRMATIONS", "12", 0),
    contractAddress: contract("CREDIT_INTERBANK_OFFER_ADDRESS"),
    databaseUrl: required("DATABASE_URL"),
    positionTokenAddress: contract("CDI_POSITION_TOKEN_ADDRESS"),
    rpcUrl,
    startBlock: (() => {
      const key = "CREDIT_INTERBANK_OFFER_START_BLOCK";
      return required(key) ? integer(key, "", 0) : 0;
    })(),
  };
  const intervalMs = integer("CHAIN_SYNC_INTERVAL_MS", "15000", 1_000);
  if (errors.length > 0)
    throw new Error(`Configuração do listener inválida: ${errors.join("; ")}.`);
  return { intervalMs, options };
}
