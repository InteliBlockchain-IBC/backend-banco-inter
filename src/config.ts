const nodeEnvironments = new Set(["development", "production", "test"]);

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!nodeEnvironments.has(nodeEnv)) {
    throw new ConfigurationError(
      "NODE_ENV deve ser development, production ou test.",
    );
  }

  const portText = env.PORT ?? "3000";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError("PORT deve ser um inteiro de 1 a 65535.");
  }

  const host = env.HOST ?? "127.0.0.1";
  if (host.trim().length === 0) {
    throw new ConfigurationError("HOST não pode ser vazio.");
  }

  return Object.freeze({
    host,
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    port,
  });
}
