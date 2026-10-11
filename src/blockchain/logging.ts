/**
 * Mensagens de erro de RPC e do PostgreSQL costumam repetir a URL usada na
 * conexão. A URL pode carregar uma chave (no path, na query string ou em
 * `usuario:senha@`), então nenhum texto de erro chega ao stdout/stderr do
 * worker sem passar por aqui.
 */

/** Variáveis cujo valor nunca pode aparecer em log. */
export const SECRET_ENV_KEYS = [
  "SEPOLIA_RPC_URL",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
] as const;

// Qualquer esquema (http, https, ws, wss, postgres, postgresql, ...). Um host
// IPv6 entre colchetes ([::1]) faz parte da URL; fora dele, `]` a encerra.
const URL_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/(?:\[[^\]\s]*\]|[^\s"'`<>)}\]])+/giu;
// Trechos de uma URL secreta curtos demais não são substituídos isoladamente:
// trocariam palavras comuns da mensagem sem proteger nada.
const MIN_FRAGMENT = 6;

/** Valores atuais das variáveis secretas, lidos do ambiente. */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return SECRET_ENV_KEYS.map((key) => env[key]).filter(
    (value): value is string => value !== undefined && value !== "",
  );
}

/**
 * Partes de uma URL secreta que identificam a credencial mesmo fora da URL:
 * host, usuário, senha, segmentos do path e valores da query string. Um erro
 * de DNS, por exemplo, cita só o host (provedores que põem a chave no
 * subdomínio); um log de requisição, só o path. O host do RPC também some do
 * log: é o preço de não vazar uma chave no subdomínio.
 */
function fragmentsOf(secret: string): string[] {
  const fragments = [secret];
  try {
    const url = new URL(secret);
    const parts = [
      url.host,
      url.hostname,
      url.username,
      url.password,
      ...url.pathname.split("/"),
      ...[...url.searchParams.values()].map(encodeURIComponent),
    ];
    // A credencial pode aparecer codificada (p%40ss) ou decodificada (p@ss).
    for (const part of parts) {
      fragments.push(part);
      try {
        fragments.push(decodeURIComponent(part));
      } catch {
        // Sequência % inválida: fica só a forma original.
      }
    }
  } catch {
    // Não é URL: o valor inteiro já está na lista.
  }
  return fragments.filter((part) => part.length >= MIN_FRAGMENT);
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function maskUrl(url: string) {
  try {
    const parsed = new URL(url);
    // `host` não inclui `usuario:senha@`; path e query são descartados.
    return parsed.host === ""
      ? "[redacted URL]"
      : `${parsed.protocol}//${parsed.host}/[redacted]`;
  } catch {
    return "[redacted URL]";
  }
}

/** Remove valores secretos conhecidos e o path/credenciais de qualquer URL. */
export function redactSecrets(
  text: string,
  secrets: readonly string[] = secretsFromEnv(),
) {
  const fragments = secrets
    .flatMap(fragmentsOf)
    // Mais longos primeiro: a URL inteira antes de um segmento dela.
    .sort((a, b) => b.length - a.length);
  let result = text;
  // Sem diferenciar maiúsculas: new URL() normaliza o host para minúsculas,
  // mas a mensagem de erro pode trazer a grafia original (apiKey123.rpc...).
  for (const fragment of fragments)
    result = result.replace(
      new RegExp(escapeRegExp(fragment), "giu"),
      "[redacted]",
    );
  return result.replace(URL_PATTERN, maskUrl);
}

/** Mensagem segura para log, preservando o texto útil do erro. */
export function safeChainErrorMessage(
  error: unknown,
  secrets: readonly string[] = secretsFromEnv(),
) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, secrets);
}

/** Linha de log estruturada de uma falha do worker. */
export function chainErrorLog(
  error: unknown,
  message: string,
  secrets: readonly string[] = secretsFromEnv(),
) {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return {
    level: "error",
    message,
    ...(code === undefined ? {} : { code }),
    error: safeChainErrorMessage(error, secrets),
  };
}
