/**
 * Single entry point that imports every test file. Using one file with the
 * `tsx --test` runner keeps cross-test setup simple (one shared HTTP server,
 * one DB pool) and avoids relying on glob/recursive-discovery semantics.
 */
import { after } from "node:test";
import { pool } from "@workspace/db";
import { closeServer } from "./helpers.js";

import "./nudges.test.js";
import "./labels.test.js";
import "./live.test.js";
import "./submissions.test.js";

after(async () => {
  await closeServer();
  await pool.end();
});
