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

const databaseUrlPattern = /^postgres(?:ql)?:\/\/\S+$/;

export type AppConfig = Readonly<{
  /**
   * Conexão do PostgreSQL. Ausente em development/test, a API usa o store em
   * memória (`x-data-source: mock`); em production ela é obrigatória.
   */
  databaseUrl?: string;
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
  const nodeEnv = env.NODE_ENV ?? "production";
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

  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (databaseUrl !== undefined && !databaseUrlPattern.test(databaseUrl)) {
    // A mensagem não ecoa o valor: ele costuma carregar a senha.
    throw new ConfigurationError(
      "DATABASE_URL deve ser uma URL postgres:// ou postgresql://.",
    );
  }
  if (databaseUrl === undefined && nodeEnv === "production") {
    throw new ConfigurationError(
      "DATABASE_URL é obrigatória em production; os dados fictícios em memória só existem em development/test.",
    );
  }

  return Object.freeze({
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    host,
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    port,
  });
}
