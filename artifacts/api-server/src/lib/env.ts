/**
 * Small env helpers so the api-server has one place that owns the
 * "are we in dev?" check. Scattered `process.env["NODE_ENV"] !== "production"`
 * comparisons drift over time and let a dev-only branch sneak into prod —
 * route every gate through `isDev()` instead.
 */

let cached: boolean | null = null;

export function isDev(): boolean {
  if (cached !== null) return cached;
  cached = process.env["NODE_ENV"] !== "production";
  return cached;
}

export function isProd(): boolean {
  return !isDev();
}

/**
 * For tests only — flips the cached value so a unit test can flip between
 * dev and prod without touching the real env. Avoid in app code.
 */
export function __setEnvForTesting(value: "development" | "production"): void {
  cached = value !== "production";
}
