import { describe, expect, it } from "vitest";
import {
  SWEEP_MIN_AGE_MS,
  SWEEP_THRESHOLD_MS,
  classifyOrphanCandidate,
} from "../../../test/sweep-policy.js";

/**
 * Pure-function coverage for the orphan-test-database sweep policy used by
 * `artifacts/api-server/test/setup.ts`. The policy decides — without any
 * Postgres access — which candidate per-run databases the wrapper should
 * drop on startup, given each candidate's encoded creation time and the
 * number of backends still attached.
 *
 * Anchoring on a fixed `nowMs` keeps every age computation deterministic.
 */

const NOW_MS = 1_700_000_000_000; // arbitrary fixed wall clock
const NOW_SEC = Math.floor(NOW_MS / 1000);

function ageAgoSec(ms: number): number {
  return NOW_SEC - Math.ceil(ms / 1000);
}

describe("classifyOrphanCandidate", () => {
  it("preserves brand-new databases regardless of backend count (sibling startup window)", () => {
    // 5s old — well inside the 60s grace window. Even with 0 backends we
    // assume a sibling test child is still starting up and hasn't connected
    // yet, so we must not drop it.
    expect(
      classifyOrphanCandidate({
        createdSec: ageAgoSec(5_000),
        backendCount: 0,
        nowMs: NOW_MS,
      }),
    ).toBe("skip-startup-grace");

    // The grace window is by-age, not by-activity: still skip even if a
    // backend has already connected.
    expect(
      classifyOrphanCandidate({
        createdSec: ageAgoSec(5_000),
        backendCount: 1,
        nowMs: NOW_MS,
      }),
    ).toBe("skip-startup-grace");
  });

  it("drops orphans with no active connections once they're past the grace window", () => {
    // 2 minutes old, no connections — the previous test process is gone,
    // so this is exactly the SIGKILL/OOM orphan we want to clean up
    // automatically rather than telling the operator to drop it manually.
    expect(
      classifyOrphanCandidate({
        createdSec: ageAgoSec(2 * 60_000),
        backendCount: 0,
        nowMs: NOW_MS,
      }),
    ).toBe("drop-idle");
  });

  it("leaves recent databases with active connections in place (in-flight runs)", () => {
    // 5 minutes old with a backend attached: that's a concurrent test run
    // mid-execution. Dropping it would yank the rug out from under the
    // sibling and corrupt its results.
    expect(
      classifyOrphanCandidate({
        createdSec: ageAgoSec(5 * 60_000),
        backendCount: 3,
        nowMs: NOW_MS,
      }),
    ).toBe("skip-active");
  });

  it("force-drops databases older than the absolute threshold even with stuck sessions", () => {
    // Two hours old — well past the 1h fallback. A test run never legitimately
    // takes that long, so a still-attached backend is treated as a stuck
    // session (e.g. a forgotten `psql` shell) and torn down by the sweep.
    expect(
      classifyOrphanCandidate({
        createdSec: ageAgoSec(2 * 60 * 60_000),
        backendCount: 4,
        nowMs: NOW_MS,
      }),
    ).toBe("drop-stuck");
  });

  it("treats the grace boundary as inclusive on the keep side", () => {
    // One second younger than SWEEP_MIN_AGE_MS → still inside the window.
    const minAgeSec = SWEEP_MIN_AGE_MS / 1000;
    expect(
      classifyOrphanCandidate({
        createdSec: NOW_SEC - (minAgeSec - 1),
        backendCount: 0,
        nowMs: NOW_MS,
      }),
    ).toBe("skip-startup-grace");
    // Exactly at the boundary → outside the strict-less-than check, so we
    // fall through to the active-vs-idle decision.
    expect(
      classifyOrphanCandidate({
        createdSec: NOW_SEC - minAgeSec,
        backendCount: 0,
        nowMs: NOW_MS,
      }),
    ).toBe("drop-idle");
  });

  it("treats the threshold boundary as inclusive on the drop-stuck side", () => {
    const thresholdSec = SWEEP_THRESHOLD_MS / 1000;
    // Just under the threshold with backends → still considered in-flight.
    expect(
      classifyOrphanCandidate({
        createdSec: NOW_SEC - (thresholdSec - 1),
        backendCount: 1,
        nowMs: NOW_MS,
      }),
    ).toBe("skip-active");
    // Exactly at the threshold with backends → force-drop wins.
    expect(
      classifyOrphanCandidate({
        createdSec: NOW_SEC - thresholdSec,
        backendCount: 1,
        nowMs: NOW_MS,
      }),
    ).toBe("drop-stuck");
  });
});
