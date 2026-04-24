/**
 * Pure decision logic for the orphan-test-database sweep performed by
 * `setup.ts`. Lives in its own module so the test suite can import and
 * exercise it without triggering the side-effectful top-level setup code.
 */

// Anything older than this is force-dropped even if a backend is still
// attached — the assumption is a stuck `psql` shell, not a live test run.
export const SWEEP_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
// Grace window so a sibling run whose per-run db has been minted but whose
// test child hasn't connected yet isn't mistaken for an orphan. Comfortably
// above the wrapper → child startup latency (a few hundred ms in practice).
export const SWEEP_MIN_AGE_MS = 60 * 1000; // 1 minute

// Suffix layout for per-run clones: `TIME_HEX_LEN` hex chars of unix-seconds
// (8 is good through year 2106) followed by `RAND_HEX_LEN` hex chars of
// randomness. Together they keep the conventional `<basename>_test_<hex>`
// shape while letting the sweeper recover the creation time without needing
// pg_stat_file or any extra privileges. Lives here so the sweep test can
// pin the exact widths setup.ts uses and detect silent drift.
export const TIME_HEX_LEN = 8;
export const RAND_HEX_LEN = 8;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the regex that recognises a per-run test database name and captures
 * its embedded timestamp (as `TIME_HEX_LEN` hex chars of unix-seconds).
 */
export function buildSuffixRegex(baseDbName: string): RegExp {
  return new RegExp(
    `^${escapeRegex(baseDbName)}_test_([0-9a-f]{${TIME_HEX_LEN}})[0-9a-f]{${RAND_HEX_LEN}}$`,
  );
}

export type SweepVerdict =
  | "drop-idle"
  | "drop-stuck"
  | "skip-startup-grace"
  | "skip-active";

/**
 * Decide whether a candidate orphan database should be dropped right now.
 *
 *   - `drop-stuck`: db is older than the absolute threshold; drop even if
 *     a backend is still attached (force-disconnect first).
 *   - `skip-startup-grace`: db was minted within the grace window — could
 *     belong to a sibling run that hasn't connected yet.
 *   - `drop-idle`: db is past the grace window and has zero active
 *     backends, so the previous owner is gone.
 *   - `skip-active`: db is past the grace window but still has at least
 *     one connected session; assume an in-flight run owns it.
 */
export function classifyOrphanCandidate(opts: {
  createdSec: number;
  backendCount: number;
  nowMs: number;
}): SweepVerdict {
  const ageMs = opts.nowMs - opts.createdSec * 1000;
  if (ageMs >= SWEEP_THRESHOLD_MS) return "drop-stuck";
  if (ageMs < SWEEP_MIN_AGE_MS) return "skip-startup-grace";
  if (opts.backendCount === 0) return "drop-idle";
  return "skip-active";
}
