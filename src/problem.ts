export type Problem = Readonly<{
  correlationId: string;
  detail: string;
  status: number;
  title: string;
  type: string;
}>;

export const problemSchema = {
  additionalProperties: false,
  properties: {
    correlationId: { type: "string" },
    detail: { type: "string" },
    status: { type: "integer" },
    title: { type: "string" },
    type: { type: "string" },
  },
  required: ["type", "title", "status", "detail", "correlationId"],
  type: "object",
} as const;

export function createProblem(
  correlationId: string,
  status: number,
  title: string,
  detail: string,
  type: string,
): Problem {
  return { correlationId, detail, status, title, type };
}
