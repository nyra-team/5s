/**
 * Regression coverage for Task 127. Before this fix the API server had no
 * Express error middleware at all, so a thrown DB error fell through to
 * Express's default handler — the request log line said "Failed query: ..."
 * (Drizzle's wrapper) and the underlying Postgres `code` / `detail` / `hint`
 * never made it anywhere. Task 81 was the canonical example: the actual
 * cause was `column submissions.created_at must appear in the GROUP BY
 * clause` (code `42803`), but you had to copy the SQL out and replay it in
 * psql to learn that.
 *
 * This test stands up a tiny isolated Express app with the real
 * `errorHandler` middleware, points a route at a deliberately broken SQL
 * query through the real `db` client, and asserts that the underlying pg
 * fields make it into the 500 response body in development. The same fields
 * are surfaced via the `err`-serializer onto the request log line; we don't
 * assert on log output here because that path goes through pino's transport
 * stream and is awkward to capture in-process — `serializePgCause` is
 * exported and used by both the response body and the log serializer, so
 * the response-body assertion exercises the same extraction logic.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { errorHandler } from "../src/middlewares/error-handler.js";
import { serializePgCause, errSerializer } from "../src/lib/logger.js";

let server: Server | null = null;
let baseUrl = "";

before(async () => {
  const app = express();
  app.get("/boom", async (_req, _res, next) => {
    try {
      // `submissions` exists; `does_not_exist_column` does not. Postgres
      // raises an "undefined_column" (42703) error which Drizzle wraps in a
      // DrizzleQueryError. Using a real query keeps the test honest about
      // the wrapper-vs-cause shape we care about.
      await db.execute(sql`SELECT does_not_exist_column FROM submissions`);
      next(new Error("expected the query above to throw"));
    } catch (err) {
      next(err);
    }
  });
  app.use(errorHandler);
  await new Promise<void>((resolve, reject) => {
    server = createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      } else {
        reject(new Error("failed to bind test server"));
      }
    });
  });
});

after(async () => {
  if (server) {
    await new Promise<void>((res) => server!.close(() => res()));
    server = null;
  }
  // Note: we do NOT close `pool` here — the shared run.ts after-hook owns
  // the pool lifecycle so other test files can keep using it.
});

describe("errorHandler (Task 127)", () => {
  test("surfaces underlying pg code/message/hint on a Drizzle query failure", async () => {
    const res = await fetch(`${baseUrl}/boom`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as {
      error: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    assert.equal(body.error, "internal_error");
    // Drizzle's wrapper text — what we used to see alone.
    assert.match(
      body.message ?? "",
      /Failed query/i,
      "dev response should still include the Drizzle wrapper message",
    );
    // The new bit: the underlying pg DatabaseError fields.
    assert.ok(body.cause, "dev response should expose the wrapped pg cause");
    assert.equal(
      body.cause!.code,
      "42703",
      "expected Postgres undefined_column code to surface",
    );
    assert.match(
      body.cause!.message ?? "",
      /does_not_exist_column/,
      "expected the underlying pg message to mention the bad column",
    );
  });

  test("hides SQL and pg cause from production responses", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await fetch(`${baseUrl}/boom`);
      assert.equal(res.status, 500);
      const body = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(
        body,
        { error: "internal_error" },
        "prod response must not leak SQL, params, or pg fields",
      );
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe("serializePgCause", () => {
  test("returns undefined for non-pg-shaped causes", () => {
    assert.equal(serializePgCause(undefined), undefined);
    assert.equal(serializePgCause(null), undefined);
    assert.equal(serializePgCause("oops"), undefined);
    assert.equal(serializePgCause({}), undefined);
  });

  test("extracts the standard pg DatabaseError fields", () => {
    const fakePgError = {
      name: "error",
      message: "column foo does not exist",
      code: "42703",
      detail: "Perhaps you meant 'bar'.",
      hint: "Check the column name.",
      schema: "public",
      table: "submissions",
      severity: "ERROR",
    };
    const out = serializePgCause(fakePgError);
    assert.deepEqual(out, fakePgError);
  });
});

describe("errSerializer (Task 127)", () => {
  test("strips Drizzle's `params` array but keeps the SQL `query`", () => {
    // Shape mirrors DrizzleQueryError: a real Error with `query`, `params`,
    // and a wrapped pg-style `cause`.
    const cause = Object.assign(new Error("column foo does not exist"), {
      code: "42703",
      detail: "Perhaps you meant 'bar'.",
    });
    const wrapper = Object.assign(
      new Error("Failed query: SELECT $1::text"),
      {
        query: "SELECT $1::text",
        params: ["super-secret-token"],
        cause,
      },
    );
    const out = errSerializer(wrapper) as Record<string, unknown>;
    assert.equal(out.query, "SELECT $1::text");
    assert.equal(
      "params" in out,
      false,
      "params must never appear in serialized log output (may contain PII / secrets)",
    );
    const serializedCause = out.cause as { code?: string; message?: string };
    assert.equal(serializedCause.code, "42703");
    assert.match(serializedCause.message ?? "", /column foo does not exist/);
  });
});
