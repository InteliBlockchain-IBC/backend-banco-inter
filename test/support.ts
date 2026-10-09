import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

export { mockOfferId, mockWallets } from "../src/demo/fixtures.js";

export const START = new Date("2026-09-29T12:00:00.000Z");

export type Clock = { advance: (ms: number) => void; now: () => Date };

export async function setup(
  t: TestContext,
): Promise<{ app: FastifyInstance; clock: Clock }> {
  let current = START.getTime();
  const clock: Clock = {
    advance: (ms) => {
      current += ms;
    },
    now: () => new Date(current),
  };
  const app = await buildApp({
    logger: false,
    nodeEnv: "test",
    now: clock.now,
  });
  t.after(() => app.close());
  return { app, clock };
}

/** Carteira com caixa mista, para provar que a API normaliza. */
export function mixedCase(address: string): string {
  return `0x${address.slice(2).toUpperCase()}`;
}

export const offers = {
  /** A1 -> B2, liquidada. */
  settledAlfaToBeta: 1,
  /** B2 -> C3, cancelada. */
  cancelled: 3,
  /** A1 -> C3, rejeitada. */
  rejected: 4,
  /** C3 -> B2, vencida com OfferExpired. */
  expiredPersisted: 5,
  /** B2 -> C3, liquidada. */
  settledBetaToGama: 6,
  /** B2 -> A1, vencida sem OfferExpired (status apresentado: expired). */
  expiredLazy: 7,
  /** A1 -> B2, aberta. R$ 40.000.000,00. */
  openAlfaToBeta: 8,
  /** C3 -> A1, aberta. */
  openGamaToAlfa: 9,
} as const;

export const hashOf = (byte: string): string => `0x${byte.repeat(32)}`;
