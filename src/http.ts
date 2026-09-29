import type { FastifyReply } from "fastify";
import type { Paged } from "./mock/store.js";

/** Toda resposta 2xx de /api/* é fictícia nesta versão e diz isso no cabeçalho e no corpo. */
export function sendData<T>(reply: FastifyReply, data: T, status = 200) {
  return reply
    .code(status)
    .header("x-data-source", "mock")
    .send({ data, meta: { source: "mock" } });
}

export function sendList<T>(reply: FastifyReply, page: Paged<T>) {
  return reply.header("x-data-source", "mock").send({
    data: page.items,
    meta: {
      limit: page.limit,
      offset: page.offset,
      source: "mock",
      total: page.total,
    },
  });
}
