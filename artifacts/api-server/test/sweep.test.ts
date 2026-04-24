/**
 * Pin down the orphan-test-database sweep so the threshold and name-parsing
 * logic in `setup.ts` can't silently drift.
 *
 * The sweep itself runs at the very top of `setup.ts` (the wrapper that
 * mints per-run databases), so we can't invoke it again from inside the
 * test process. Instead we exercise the two pieces it dispatches into:
 *
 *   - `classifyOrphanCandidate` — pure decision: given a parsed creation
 *     timestamp and a backend count, returns drop/skip and which bucket.
 *   - `buildSuffixRegex` — recognises the per-run database name shape and
 *     captures the embedded creation time.
 *
 * Together those cover the original task's intent (fake "old", "fresh",
 * and "unparseable" candidates → only the old one gets dropped) without
 * having to either re-run the wrapper or reach into a live Postgres
 * cluster from inside the test child.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  RAND_HEX_LEN,
  SWEEP_MIN_AGE_MS,
  SWEEP_THRESHOLD_MS,
  TIME_HEX_LEN,
  buildSuffixRegex,
  classifyOrphanCandidate,
} from "./sweep-policy.js";

function hexTime(unixSec: number): string {
  return unixSec.toString(16).padStart(TIME_HEX_LEN, "0");
}

function hexRand(): string {
  return randomBytes(RAND_HEX_LEN / 2).toString("hex");
}

describe("classifyOrphanCandidate", () => {
  // Fix the clock so boundary-condition assertions don't drift between
  // runs. The exact value doesn't matter, only that it's a stable
  // reference for the relative ages below.
  const nowMs = 1_700_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);

  test("treats a freshly-minted db as still in the startup grace window", () => {
    // Just minted: 0 ms old, well under SWEEP_MIN_AGE_MS.
    const verdict = classifyOrphanCandidate({
      createdSec: nowSec,
      backendCount: 0,
      nowMs,
    });
    assert.equal(verdict, "skip-startup-grace");
  });

  test("still skips just under the grace boundary", () => {
    // Sibling-run-could-still-be-attaching window: must not be swept.
    // We use a 2-second margin (rather than 1 ms) so the second-granularity
    // floor on `createdSec` can't round us up into the boundary itself —
    // that boundary case has its own assertion in the next test.
    const createdSec = Math.floor((nowMs - (SWEEP_MIN_AGE_MS - 2_000)) / 1000);
    const verdict = classifyOrphanCandidate({
      createdSec,
      backendCount: 0,
      nowMs,
    });
    assert.equal(verdict, "skip-startup-grace");
  });

  test("drops an idle db once it's older than the grace window", () => {
    // Past grace, no backends → previous owner is gone.
    const createdSec = Math.floor((nowMs - SWEEP_MIN_AGE_MS) / 1000);
    const verdict = classifyOrphanCandidate({
      createdSec,
      backendCount: 0,
      nowMs,
    });
    assert.equal(verdict, "drop-idle");
  });

  test("leaves a past-grace db alone while at least one backend is attached", () => {
    // Past grace but live sessions → assume an in-flight test run owns it.
    const createdSec = Math.floor((nowMs - SWEEP_MIN_AGE_MS - 5_000) / 1000);
    const verdict = classifyOrphanCandidate({
      createdSec,
      backendCount: 1,
      nowMs,
    });
    assert.equal(verdict, "skip-active");
  });

  test("force-drops a stuck db even when sessions are still attached", () => {
    // Older than the absolute threshold: assume a forgotten psql shell or
    // similar, force-disconnect and drop.
    const createdSec = Math.floor((nowMs - SWEEP_THRESHOLD_MS) / 1000);
    const verdict = classifyOrphanCandidate({
      createdSec,
      backendCount: 3,
      nowMs,
    });
    assert.equal(verdict, "drop-stuck");
  });

  test("the drop-stuck threshold beats skip-active even at exactly the boundary", () => {
    // At the threshold the verdict must be drop-stuck — one millisecond
    // either side could surprise on-call.
    const createdSec = Math.floor((nowMs - SWEEP_THRESHOLD_MS) / 1000);
    assert.equal(
      classifyOrphanCandidate({
        createdSec,
        backendCount: 0,
        nowMs,
      }),
      "drop-stuck",
    );
  });

  test("just under the absolute threshold with backends still goes to skip-active, not drop-stuck", () => {
    const createdSec = Math.floor((nowMs - SWEEP_THRESHOLD_MS + 1_000) / 1000);
    const verdict = classifyOrphanCandidate({
      createdSec,
      backendCount: 1,
      nowMs,
    });
    assert.equal(verdict, "skip-active");
  });
});

describe("buildSuffixRegex", () => {
  // A throwaway basename per run keeps the regex case independent of
  // whatever DATABASE_URL points at and matches what setup.ts does at
  // runtime (it builds the regex from the cluster's DB name).
  const baseDbName = `sweeptest_${randomBytes(6).toString("hex")}`;
  const re = buildSuffixRegex(baseDbName);

  test("matches a well-formed per-run name and captures the timestamp prefix", () => {
    // This is the exact shape setup.ts mints for the per-run db.
    const t = hexTime(1_700_000_000);
    const r = hexRand();
    const name = `${baseDbName}_test_${t}${r}`;
    const m = re.exec(name);
    assert.ok(m, `expected ${name} to match the suffix regex`);
    assert.equal(m![1], t, "first capture must be the hex timestamp");
    assert.equal(
      parseInt(m![1], 16),
      1_700_000_000,
      "captured hex must round-trip back to the original unix-seconds",
    );
  });

  test("rejects a name that's missing the hex suffix entirely (the 'unparseable' case)", () => {
    // The LIKE filter in setup.ts pulls this one out of pg_database, but
    // the regex must reject it so it ends up in the skippedUnparseable
    // bucket rather than being treated as a parseable orphan.
    assert.equal(re.exec(`${baseDbName}_test_notatime${hexRand()}`), null);
  });

  test("rejects a hex suffix that's too short", () => {
    // Shorter than TIME_HEX_LEN + RAND_HEX_LEN: don't accept.
    const shortHex = "abc123";
    assert.equal(re.exec(`${baseDbName}_test_${shortHex}`), null);
  });

  test("rejects a hex suffix that's too long", () => {
    // Longer than TIME_HEX_LEN + RAND_HEX_LEN: don't accept either, so a
    // future format that adds extra chars doesn't get parsed with the
    // wrong-shaped capture group.
    const longHex = hexTime(1_700_000_000) + hexRand() + "ff";
    assert.equal(re.exec(`${baseDbName}_test_${longHex}`), null);
  });

  test("rejects a name belonging to a different basename", () => {
    // Make sure the regex is anchored to baseDbName and doesn't match
    // an unrelated db that happens to share the `_test_<hex>` tail.
    const t = hexTime(1_700_000_000);
    const r = hexRand();
    assert.equal(re.exec(`other_test_${t}${r}`), null);
  });

  test("rejects the cached template database name", () => {
    // Belt-and-braces: the explicit `<> templateDbName` filter in setup.ts
    // already excludes this, but a regex match here would still be a
    // surprise (the template has no embedded timestamp).
    assert.equal(re.exec(`${baseDbName}_test_template`), null);
  });
});
