/**
 * Erros de provedores RPC normalmente repetem a URL da requisição. Como a URL
 * pode carregar uma chave no path ou na query string, ela nunca deve chegar ao
 * stdout/stderr do worker.
 */
export function safeChainErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s"'`<>)}\]]+/giu, (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}/[redacted]`;
    } catch {
      return "[redacted RPC URL]";
    }
  });
}
