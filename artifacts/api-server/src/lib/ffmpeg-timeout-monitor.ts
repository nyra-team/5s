import { logger } from "./logger.js";
import { sendOpsAlert } from "./notifications.js";

/**
 * Rolling-window monitor for ffmpeg invocation timeouts.
 *
 * The wall-clock timeout in `runFfmpeg` (see `keyframes.ts`) protects the API
 * worker from a single broken upload, but a *spike* in timeouts is a much
 * louder signal: a bad encoder shipping on a popular phone, an ffmpeg build
 * regression, or a wave of malicious uploads. Without this monitor those
 * events only appear as scattered `logger.warn` lines; on-call typically only
 * notices days later in log review. We instead count timeouts in a rolling
 * window and fire a single ops alert (Slack + manager email) when the rate
 * crosses a threshold, with a cooldown so a sustained outage doesn't carpet-
 * bomb the channel.
 *
 * ## Tuning
 *
 * All knobs are read at the moment a timeout is recorded (no restart needed
 * to try a new value in production):
 *
 * - `FFMPEG_TIMEOUT_ALERT_WINDOW_MS` — rolling window length in ms.
 *   Default 600000 (10 min). Shorter = faster to notice but noisier on
 *   intermittent flakiness; longer = calmer but slower to fire.
 * - `FFMPEG_TIMEOUT_ALERT_THRESHOLD` — minimum timeouts that must fall
 *   inside the window before an alert is fired. Default 5. Set to 0 to
 *   disable the alert entirely (the counter still ticks so log inspectors
 *   can see lifetime totals).
 * - `FFMPEG_TIMEOUT_ALERT_COOLDOWN_MS` — minimum gap between consecutive
 *   alerts. Default 1800000 (30 min). Prevents alert storms during a
 *   sustained outage; the rolling counter keeps incrementing, so the next
 *   alert (after the cooldown) reflects the current state.
 *
 * ## Storage
 *
 * In-memory by design. The codebase has no Prometheus/StatsD layer to plug
 * into, and an outage that takes the API down also voids the counter — which
 * is fine because operators will notice the API being down via a different
 * signal (HTTP probes / deployment alerts) before the counter would have
 * tripped.
 */

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function readNonNegativeInt(envName: string, fallback: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      { envName, value: raw },
      "ffmpeg-timeout-monitor: invalid env value, falling back to default",
    );
    return fallback;
  }
  return Math.floor(parsed);
}

function getWindowMs(): number {
  // Window must be > 0 so we don't divide-by-zero when computing the cutoff.
  const v = readNonNegativeInt("FFMPEG_TIMEOUT_ALERT_WINDOW_MS", DEFAULT_WINDOW_MS);
  return v > 0 ? v : DEFAULT_WINDOW_MS;
}

function getThreshold(): number {
  return readNonNegativeInt("FFMPEG_TIMEOUT_ALERT_THRESHOLD", DEFAULT_THRESHOLD);
}

function getCooldownMs(): number {
  return readNonNegativeInt("FFMPEG_TIMEOUT_ALERT_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
}

let timestamps: number[] = [];
let lastAlertAt = 0;
let lifetimeCount = 0;

// Pluggable clock so tests can advance time without `vi.useFakeTimers()`,
// which would interfere with the real `setTimeout` used elsewhere
// (e.g. `runFfmpeg`'s own SIGKILL timer).
let clockNow: () => number = () => Date.now();

export function __setClockForTests(fn: (() => number) | null): void {
  clockNow = fn ?? (() => Date.now());
}

export interface FfmpegTimeoutContext {
  /** Absolute path of the upload that timed out. */
  videoAbsPath: string;
  /** The wall-clock budget the invocation blew through, in ms. */
  timeoutMs: number;
  /** The ffmpeg `-vf` filter graph that was running when we killed it. */
  vfilter: string;
}

/**
 * Record a single ffmpeg timeout. Synchronous from the caller's perspective —
 * the alert dispatch (when the threshold is crossed) is fire-and-forget so a
 * slow Slack/email provider can never block an upload-handling request.
 */
export function recordFfmpegTimeout(context: FfmpegTimeoutContext): void {
  const now = clockNow();
  lifetimeCount++;
  timestamps.push(now);
  pruneOlderThan(now - getWindowMs());

  const threshold = getThreshold();
  if (threshold <= 0) return; // alerting disabled — counter still ticks

  const count = timestamps.length;
  if (count < threshold) return;

  const cooldownMs = getCooldownMs();
  if (lastAlertAt > 0 && now - lastAlertAt < cooldownMs) return;

  lastAlertAt = now;
  const windowMs = getWindowMs();
  const windowMinutes = Math.max(1, Math.round(windowMs / 60_000));
  const cooldownMinutes = Math.max(1, Math.round(cooldownMs / 60_000));

  logger.warn(
    {
      event: "ffmpeg_timeout_alert",
      timeoutsInWindow: count,
      windowMs,
      threshold,
      cooldownMs,
      lifetimeCount,
      lastVideoAbsPath: context.videoAbsPath,
    },
    "ffmpeg-timeout-monitor: timeout rate exceeded threshold; firing ops alert",
  );

  void sendOpsAlert({
    title: "ffmpeg timeouts spiking",
    message:
      `${count} ffmpeg invocations have timed out in the last ${windowMinutes} min ` +
      `(threshold ${threshold}). Likely upstream causes: a bad encoder on a popular phone, ` +
      `an ffmpeg build regression, or a wave of malicious uploads. ` +
      `Next alert can fire in ${cooldownMinutes} min.`,
    details: {
      windowMinutes,
      threshold,
      timeoutsInWindow: count,
      lastTimeoutMs: context.timeoutMs,
      lastVideoAbsPath: context.videoAbsPath,
      lifetimeCount,
    },
  }).catch((err) =>
    logger.error(
      { err, count, windowMinutes },
      "ffmpeg-timeout-monitor: ops alert dispatch failed",
    ),
  );
}

function pruneOlderThan(cutoffMs: number): void {
  // Drop in place to avoid reallocating once steady-state.
  let writeIdx = 0;
  for (const t of timestamps) {
    if (t >= cutoffMs) timestamps[writeIdx++] = t;
  }
  timestamps.length = writeIdx;
}

/** Test/diagnostics helper: read the current rolling window state. */
export function getFfmpegTimeoutMonitorSnapshot(): {
  timeoutsInWindow: number;
  lifetimeCount: number;
  lastAlertAt: number;
} {
  // Force a prune so the snapshot reflects the live window even when no new
  // timeouts have come in for a while.
  pruneOlderThan(clockNow() - getWindowMs());
  return {
    timeoutsInWindow: timestamps.length,
    lifetimeCount,
    lastAlertAt,
  };
}

/** Test helper: clear all internal counters. */
export function __resetFfmpegTimeoutMonitorForTests(): void {
  timestamps = [];
  lastAlertAt = 0;
  lifetimeCount = 0;
}
