const nodeEnvironments: Record<string, true> = {
  development: true,
  production: true,
  test: true,
};
const decimalInteger = /^[0-9]+$/;
/**
 * Aceita IPv4, IPv6 (`::1`) e nome de host. Rejeita espaço, barra e qualquer
 * caractere que não pertença a um endereço — antes disso, `HOST` só era
 * verificado quanto a estar vazio.
 */
const hostPattern = /^[A-Za-z0-9._:-]+$/;

export type AppConfig = Readonly<{
  host: string;
  nodeEnv: "development" | "production" | "test";
  port: number;
}>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * O ambiente é um argumento obrigatório. Um valor padrão de `process.env` aqui
 * convidava qualquer módulo a obter a configuração ambiente sem passar pelo
 * ponto de entrada; hoje existe exatamente uma leitura ambiente, em `server.ts`.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (nodeEnvironments[nodeEnv] !== true) {
    throw new ConfigurationError(
      "NODE_ENV deve ser development, production ou test.",
    );
  }

  const portText = env.PORT ?? "3000";
  // `Number()` aceita `1e3`, `0x10` e `3.5`; a configuração documentada pede
  // um inteiro decimal, então a forma é validada antes do valor.
  if (!decimalInteger.test(portText)) {
    throw new ConfigurationError(
      "PORT deve ser um inteiro decimal de 1 a 65535.",
    );
  }
  const port = Number(portText);
  if (port < 1 || port > 65535) {
    throw new ConfigurationError(
      "PORT deve ser um inteiro decimal de 1 a 65535.",
    );
  }

  const host = env.HOST ?? "127.0.0.1";
  if (!hostPattern.test(host)) {
    throw new ConfigurationError(
      "HOST deve ser um endereço IPv4, IPv6 ou nome de host válido.",
    );
  }

  return Object.freeze({
    host,
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    port,
  });
}
