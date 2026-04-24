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
