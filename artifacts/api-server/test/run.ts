/**
 * Single entry point that imports every test file. Using one file with the
 * `tsx --test` runner keeps cross-test setup simple (one shared HTTP server,
 * one DB pool) and avoids relying on glob/recursive-discovery semantics.
 *
 * This file is invoked as a child process by `./setup.ts`, which has
 * already minted a fresh Postgres database for this run and exported
 * `DATABASE_URL` pointing at it. `@workspace/db`'s connection pool below
 * therefore binds to the per-run test DB, not the shared dev DB. See
 * `setup.ts` for the full rationale.
 */
import { after } from "node:test";
import { pool } from "@workspace/db";
import { closeServer } from "./helpers.js";

import "./nudges.test.js";
import "./labels.test.js";
import "./live.test.js";
import "./submissions.test.js";
import "./reasoning.test.js";
import "./backfill-reasoning.test.js";
import "./identify-area.test.js";
import "./reping-scheduler.test.js";

after(async () => {
  await closeServer();
  // Drain the pool before the wrapper drops the per-run database; otherwise
  // the DROP would block on still-open connections.
  await pool.end();
});
