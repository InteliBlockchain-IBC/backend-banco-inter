import type { FastifyReply } from "fastify";
import type { DataSource, Paged } from "../repositories/repository.js";

/**
 * Toda resposta 2xx de /api/* informa a origem no cabeçalho e no corpo:
 * `mock` (memória da instância) ou `postgres` (persistido no banco).
 */
export function sendData<T>(
  reply: FastifyReply,
  source: DataSource,
  data: T,
  status = 200,
) {
  return reply
    .code(status)
    .header("x-data-source", source)
    .send({ data, meta: { source } });
}

export function sendList<T>(
  reply: FastifyReply,
  source: DataSource,
  page: Paged<T>,
) {
  return reply.header("x-data-source", source).send({
    data: page.items,
    meta: {
      limit: page.limit,
      offset: page.offset,
      source,
      total: page.total,
    },
  });
}
