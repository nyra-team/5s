import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

// Fields we want to lift out of a wrapped Postgres / pg DatabaseError so the
// underlying cause shows up structured in our logs (and the dev-only response
// body) instead of being buried in a free-form message. Drizzle wraps every
// query failure in DrizzleQueryError and stores the original pg error as
// `cause`; without this serializer we'd only see "Failed query: ..." and have
// to replay the SQL by hand to figure out what Postgres actually objected to.
//
// Keep this list to fields that are safe to log and useful for diagnosis. We
// deliberately omit anything that could carry parameter values (the pg
// DatabaseError doesn't, but Drizzle's own `params` field does — we strip
// that below).
const PG_ERROR_FIELDS = [
  "code",
  "detail",
  "hint",
  "schema",
  "table",
  "column",
  "constraint",
  "dataType",
  "severity",
  "position",
  "internalPosition",
  "internalQuery",
  "where",
  "file",
  "line",
  "routine",
] as const;

export interface SerializedPgCause {
  message?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Pull the structured fields off a pg `DatabaseError`-shaped object. Returns
 * `undefined` when the input doesn't look like a pg error so callers can skip
 * adding an empty `cause` block.
 */
export function serializePgCause(cause: unknown): SerializedPgCause | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const c = cause as Record<string, unknown>;
  const out: SerializedPgCause = {};
  if (typeof c.message === "string") out.message = c.message;
  if (typeof c.name === "string") out.name = c.name;
  for (const f of PG_ERROR_FIELDS) {
    const v = c[f];
    if (v !== undefined && v !== null) out[f] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Custom error serializer layered on top of pino's default. Two changes:
 *
 *   1. If the error wraps a pg `DatabaseError` as `cause`, surface the
 *      structured fields (`code`, `detail`, `hint`, `constraint`, ...) under
 *      a `cause` block. pino's default serializer concatenates the cause's
 *      message into the parent message but doesn't expose these fields, and
 *      they're the ones on-call needs to skip the "replay the SQL by hand"
 *      step (see Task 81 / Task 127).
 *
 *   2. Drop Drizzle's `params` array. It contains user-supplied query
 *      parameters which can include PII, secrets, or other sensitive input
 *      that has no business sitting in our logs forever. The SQL string
 *      itself (`query`) is kept because the structure is what we need to
 *      reproduce the failure.
 */
export function errSerializer(err: unknown): unknown {
  // pino's default serializer types `cause` as `never` because it folds the
  // cause's message/stack into the parent. We want it back as a structured
  // field, so widen to a plain record once and mutate from there.
  const base = pino.stdSerializers.err(err as Error) as unknown as Record<
    string,
    unknown
  >;
  if (!err || typeof err !== "object") return base;
  // pino copied `params` over via its enumerable-property loop. Strip it so
  // we don't leak query parameters into the log stream.
  if ("params" in base) delete base.params;
  const e = err as Record<string, unknown>;
  const pg = serializePgCause(e.cause);
  if (pg) base.cause = pg;
  return base;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  serializers: { err: errSerializer },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
