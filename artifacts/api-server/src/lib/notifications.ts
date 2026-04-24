import { db, usersTable, escalationsTable, areasTable } from "@workspace/db";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { logger } from "./logger.js";

export interface EscalationNotification {
  escalationId: number;
  submissionId: number;
  areaId: number;
  areaName: string;
  scorePercent: number;
  failingPillars: string[];
  operatorEmail: string;
  recommendedActions: string[];
}

export interface QuietHoursPrefs {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursWeekdayMask: number;
}

export interface RepingContext {
  ageMinutes: number;
  attempt: number;
  maxAttempts: number;
}

const DEFAULT_GROUPING_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_RECOVERY_WINDOW_MS = 60 * 60 * 1000;

function groupingWindowMs(): number {
  const raw = process.env.ESCALATION_NOTIFICATION_WINDOW_MS?.trim();
  if (!raw) return DEFAULT_GROUPING_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      { value: raw },
      "notify: invalid ESCALATION_NOTIFICATION_WINDOW_MS, falling back to default",
    );
    return DEFAULT_GROUPING_WINDOW_MS;
  }
  return Math.floor(parsed);
}

function recoveryWindowMs(): number {
  const raw = process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS?.trim();
  if (!raw) return DEFAULT_RECOVERY_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      { value: raw },
      "notify: invalid ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS, falling back to default",
    );
    return DEFAULT_RECOVERY_WINDOW_MS;
  }
  return Math.floor(parsed);
}

function appBaseUrl(): string {
  const fromEnv = process.env.APP_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const replitDomain = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (replitDomain) return `https://${replitDomain}`;
  return "";
}

function escalationLink(escalationId: number): string {
  const base = appBaseUrl();
  const path = `/escalations?focus=${escalationId}`;
  return base ? `${base}${path}` : path;
}

function inboxLink(): string {
  const base = appBaseUrl();
  const path = `/escalations`;
  return base ? `${base}${path}` : path;
}

function dashboardLink(): string {
  const base = appBaseUrl();
  const path = `/dashboard`;
  return base ? `${base}${path}` : path;
}

function parseHHMM(s: string | null | undefined): number | null {
  if (!s) return null;
  // The canonical wire/storage shape is "HH:MM" — the column is `text`,
  // the form's <input type="time"> only submits HH:MM, and the
  // preferences route normalises every write to HH:MM. The optional
  // `:SS` group below is defensive only (e.g. an out-of-band SQL update
  // that landed an HH:MM:SS value, or a future schema drift back to
  // `time without time zone`) and is no longer load-bearing for normal
  // operation. Keeping it ensures notification dispatch fails open
  // (still mutes during quiet hours) rather than silently disabling
  // suppression if a stray seconds suffix slips through.
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mn)) return null;
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function toIstShifted(now: Date): Date {
  // Shift "now" by +5:30 and read UTC fields to get IST clock values.
  return new Date(now.getTime() + IST_OFFSET_MS);
}

function istClockToUtcDate(istToday: Date, dayOffset: number, minuteOfDay: number): Date {
  // istToday is the +5:30-shifted Date so its UTC fields read as IST clock values.
  const year = istToday.getUTCFullYear();
  const month = istToday.getUTCMonth();
  const day = istToday.getUTCDate() + dayOffset;
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  // Treat (year, month, day, h, m) as IST clock values, then subtract the IST
  // offset to get the absolute UTC moment.
  const istUtcMs = Date.UTC(year, month, day, h, m, 0, 0);
  return new Date(istUtcMs - IST_OFFSET_MS);
}

/**
 * Returns true when `now` falls inside the recipient's quiet-hours window,
 * interpreted in IST. Window may wrap past midnight (end < start). The
 * weekday mask gates by the *starting* day of the window: for a 22:00–07:00
 * Mon window, evening Monday and early Tuesday morning are both in scope.
 *
 * Exported for tests.
 */
export function isInQuietHours(prefs: QuietHoursPrefs, now: Date = new Date()): boolean {
  if (!prefs.quietHoursEnabled) return false;
  const startM = parseHHMM(prefs.quietHoursStart);
  const endM = parseHHMM(prefs.quietHoursEnd);
  if (startM == null || endM == null) return false;
  if (startM === endM) return false; // empty / always-quiet ambiguous → treat as off

  const mask = prefs.quietHoursWeekdayMask;
  if (!Number.isFinite(mask) || mask <= 0) return false;

  const ist = toIstShifted(now);
  const istDay = ist.getUTCDay(); // 0 = Sun … 6 = Sat
  const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();

  if (startM < endM) {
    // Same-day window [start, end). Gated by today's weekday.
    if ((mask & (1 << istDay)) === 0) return false;
    return istMin >= startM && istMin < endM;
  }

  // Wrapping window. Two halves, each gated by the *starting* day:
  //   today  (>= start)         → today's weekday bit
  //   today  (< end)            → yesterday's weekday bit
  if (istMin >= startM) {
    return (mask & (1 << istDay)) !== 0;
  }
  if (istMin < endM) {
    const prevDay = (istDay + 6) % 7;
    return (mask & (1 << prevDay)) !== 0;
  }
  return false;
}

export interface QuietHoursStatus {
  /** True when `now` falls inside the recipient's quiet-hours window. */
  active: boolean;
  /**
   * When `active` is true, the absolute moment the current window ends
   * (ISO 8601). Null otherwise.
   */
  activeUntil: string | null;
  /**
   * When `active` is false, the absolute moment the next quiet-hours window
   * begins (ISO 8601). Null otherwise — including when quiet hours are off
   * entirely or the weekday mask is empty.
   */
  nextStart: string | null;
}

/**
 * Computes the live status of a recipient's quiet-hours window relative to
 * `now`. Used by the client-side "muted right now" badge so the manager can
 * see at a glance that escalations are being suppressed for them.
 *
 * Exported for tests.
 */
export function quietHoursStatus(prefs: QuietHoursPrefs, now: Date = new Date()): QuietHoursStatus {
  const off: QuietHoursStatus = { active: false, activeUntil: null, nextStart: null };

  if (!prefs.quietHoursEnabled) return off;
  const startM = parseHHMM(prefs.quietHoursStart);
  const endM = parseHHMM(prefs.quietHoursEnd);
  if (startM == null || endM == null) return off;
  if (startM === endM) return off;

  const mask = prefs.quietHoursWeekdayMask;
  if (!Number.isFinite(mask) || mask <= 0) return off;

  const ist = toIstShifted(now);
  const istDay = ist.getUTCDay();
  const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const wraps = startM >= endM;

  if (isInQuietHours(prefs, now)) {
    let endDate: Date;
    if (!wraps) {
      // Same-day window — ends today.
      endDate = istClockToUtcDate(ist, 0, endM);
    } else if (istMin >= startM) {
      // Evening half of a wrapping window — ends tomorrow morning.
      endDate = istClockToUtcDate(ist, 1, endM);
    } else {
      // Early-morning half of a wrapping window — ends today.
      endDate = istClockToUtcDate(ist, 0, endM);
    }
    return { active: true, activeUntil: endDate.toISOString(), nextStart: null };
  }

  // Not currently muted — find the soonest future window start. The window
  // applies on a given day iff that day's bit is set in the mask. We scan up
  // to 8 days forward (one extra to handle today's start being in the past).
  for (let offset = 0; offset < 8; offset++) {
    const dayBit = (istDay + offset) % 7;
    if ((mask & (1 << dayBit)) === 0) continue;
    const candidate = istClockToUtcDate(ist, offset, startM);
    if (candidate.getTime() > now.getTime()) {
      return { active: false, activeUntil: null, nextStart: candidate.toISOString() };
    }
  }
  return off;
}

interface PendingBucket {
  areaId: number;
  areaName: string;
  events: EscalationNotification[];
  firstAt: number;
  timer: NodeJS.Timeout;
}

const pendingByArea = new Map<number, PendingBucket>();

async function notifyEscalationCreatedDefault(payload: EscalationNotification): Promise<void> {
  const windowMs = groupingWindowMs();
  if (windowMs <= 0) {
    // Grouping disabled — send immediately as a single-event message.
    // Atomically claim before dispatching: if a sibling process's startup
    // recovery sweep happened to fire between this row being inserted and
    // this notifier being invoked, the sweep will have already stamped
    // notified_at and we must not re-send.
    const claimed = await claimEscalationsForLiveDispatch([payload.escalationId]);
    if (!claimed.has(payload.escalationId)) {
      logger.info(
        { escalationId: payload.escalationId, areaId: payload.areaId },
        "notify: immediate live dispatch skipped — escalation already notified by another process",
      );
      return;
    }
    await dispatch([payload], null, { preClaimed: true });
    return;
  }

  const existing = pendingByArea.get(payload.areaId);
  if (existing) {
    existing.events.push(payload);
    logger.info(
      {
        areaId: payload.areaId,
        escalationId: payload.escalationId,
        bucketSize: existing.events.length,
      },
      "notify: appended escalation to pending bucket",
    );
    return;
  }

  const timer = setTimeout(() => {
    void flushArea(payload.areaId);
  }, windowMs);
  // Don't keep the event loop alive just for a notification flush.
  if (typeof timer.unref === "function") timer.unref();

  pendingByArea.set(payload.areaId, {
    areaId: payload.areaId,
    areaName: payload.areaName,
    events: [payload],
    firstAt: Date.now(),
    timer,
  });
  logger.info(
    { areaId: payload.areaId, escalationId: payload.escalationId, windowMs },
    "notify: opened new pending bucket for area",
  );
}

// `notifyEscalationCreated` is exported as a `let`-bound live binding so the
// integration suite can swap it for a recorder via
// `__setNotifyEscalationCreatedForTest`. ESM keeps importers in sync with
// the reassignment, so the real `/api/submissions` route handler can be
// exercised end-to-end without a live email/Slack provider while the test
// still asserts the side-effect was triggered with the expected payload.
export let notifyEscalationCreated: (payload: EscalationNotification) => Promise<void> =
  notifyEscalationCreatedDefault;

/**
 * Test-only seam. Lets the integration suite stub the notify side-effect so
 * the real escalation branch of POST /api/submissions can be asserted
 * offline. Pass `null` to restore the real impl.
 */
export function __setNotifyEscalationCreatedForTest(
  fn: ((payload: EscalationNotification) => Promise<void>) | null,
): void {
  notifyEscalationCreated = fn ?? notifyEscalationCreatedDefault;
}

/**
 * Re-pings bypass the grouping window — they are reminders for one specific
 * escalation that has been sitting in OPEN past the threshold, so coalescing
 * them with other events would dilute the signal and make the "Aging X min"
 * banner meaningless.
 *
 * Implementation note: the actual delivery is routed through a swappable
 * module-level handler so tests can stub out Slack/Resend without monkey-
 * patching `globalThis.fetch`. The default handler dispatches normally; tests
 * call `setRepingNotifierForTesting` to install a recorder and restore.
 */
export type RepingNotifierFn = (
  payload: EscalationNotification,
  context: RepingContext,
) => Promise<void>;

const defaultRepingNotifier: RepingNotifierFn = async (payload, context) => {
  await dispatch([payload], context);
};

let repingNotifierImpl: RepingNotifierFn = defaultRepingNotifier;

export async function notifyEscalationReping(
  payload: EscalationNotification,
  context: RepingContext,
): Promise<void> {
  await repingNotifierImpl(payload, context);
}

/**
 * Test-only seam: replace the re-ping notifier with `fn`, or restore the
 * default by passing `null`. Returns the previously-installed notifier so
 * suites can chain stubs/restorations cleanly.
 */
export function setRepingNotifierForTesting(
  fn: RepingNotifierFn | null,
): RepingNotifierFn {
  const prev = repingNotifierImpl;
  repingNotifierImpl = fn ?? defaultRepingNotifier;
  return prev;
}

/**
 * Atomically claim a set of escalation IDs for live dispatch (the grouping
 * flush path or the immediate-send path with WINDOW_MS=0). Returns the IDs
 * the caller now owns — anything that another process already stamped (e.g.
 * a concurrent startup recovery sweep that booted while we were sitting on
 * a grouping window) is excluded.
 *
 * Why claim before dispatch:
 * The recovery-vs-recovery race was fixed by stamping `notified_at` inside
 * the recovery sweep's atomic UPDATE. There is a narrower live-vs-recovery
 * race left over: process A is mid-grouping-window for an escalation that
 * was created BEFORE process B booted; process B's recovery sweep claims
 * and dispatches it, then process A's grouping timer fires and dispatches
 * it AGAIN because `flushArea -> dispatch` previously didn't re-check
 * `notified_at`. By gating the live flush on the same atomic
 *   UPDATE escalations SET notified_at = now() WHERE notified_at IS NULL
 *     AND id = ANY(...) RETURNING id
 * pattern, exactly one of the two processes ever wins the row.
 *
 * Trade-off: same as the recovery sweep — stamping `notified_at` BEFORE
 * dispatch means a transient Slack/Resend outage drops this attempt with
 * no startup-sweep retry. We accept that to keep exactly-once semantics
 * for the much louder failure mode (double-emailing managers on every
 * deploy).
 */
async function claimEscalationsForLiveDispatch(
  escalationIds: number[],
): Promise<Set<number>> {
  if (escalationIds.length === 0) return new Set();
  try {
    const claimed = await db
      .update(escalationsTable)
      .set({ notifiedAt: new Date(), notifyDeliveryStatus: "DELIVERED" })
      .where(
        and(
          inArray(escalationsTable.id, escalationIds),
          isNull(escalationsTable.notifiedAt),
        ),
      )
      .returning({ id: escalationsTable.id });
    return new Set(claimed.map((r) => r.id));
  } catch (err) {
    // If the claim itself fails we skip dispatch entirely rather than risk
    // a double-send. The escalations stay un-stamped so the next startup
    // sweep will retry them.
    logger.error(
      { err, escalationIds },
      "notify: failed to atomically claim escalations for live dispatch (skipping to avoid double-send)",
    );
    return new Set();
  }
}

/**
 * Payload for the AI retry-rate spike alert. Sent at most once per cooldown
 * window by `runRetrySpikeCheck`. Carries the values managers need to
 * triage without opening the dashboard (rate, sample size) plus a deep link
 * back to the dashboard for context.
 */
export interface AiRetrySpikeNotification {
  /** Observed retry fraction in the recent window (0–1). */
  retryRate: number;
  /** How many of the calls in the window were retried. */
  retriedCalls: number;
  /** Total calls observed in the window — the sample size for `retryRate`. */
  totalCalls: number;
  /** The configured threshold the rate just crossed (0–1). */
  thresholdRate: number;
  /** Length of the rolling observation window in milliseconds. */
  windowMs: number;
}

/**
 * Test seam: replace the AI retry-spike notifier with `fn`, or restore the
 * default by passing `null`. Same pattern as `setRepingNotifierForTesting`.
 * Returns the previously-installed notifier so suites can chain stubs.
 */
export type AiRetrySpikeNotifierFn = (
  payload: AiRetrySpikeNotification,
) => Promise<void>;

const defaultAiRetrySpikeNotifier: AiRetrySpikeNotifierFn = async (payload) => {
  await dispatchAiRetrySpike(payload);
};

let aiRetrySpikeNotifierImpl: AiRetrySpikeNotifierFn = defaultAiRetrySpikeNotifier;

export async function notifyAiRetrySpike(
  payload: AiRetrySpikeNotification,
): Promise<void> {
  await aiRetrySpikeNotifierImpl(payload);
}

export function setAiRetrySpikeNotifierForTesting(
  fn: AiRetrySpikeNotifierFn | null,
): AiRetrySpikeNotifierFn {
  const prev = aiRetrySpikeNotifierImpl;
  aiRetrySpikeNotifierImpl = fn ?? defaultAiRetrySpikeNotifier;
  return prev;
}

async function flushArea(areaId: number): Promise<void> {
  const bucket = pendingByArea.get(areaId);
  if (!bucket) return;
  pendingByArea.delete(areaId);
  clearTimeout(bucket.timer);
  try {
    const claimed = await claimEscalationsForLiveDispatch(
      bucket.events.map((e) => e.escalationId),
    );
    const toSend = bucket.events.filter((e) => claimed.has(e.escalationId));
    if (toSend.length === 0) {
      logger.info(
        { areaId, attempted: bucket.events.length },
        "notify: live flush skipped — every escalation in the bucket was already notified by another process",
      );
      return;
    }
    if (toSend.length < bucket.events.length) {
      logger.info(
        {
          areaId,
          sending: toSend.length,
          alreadyNotified: bucket.events.length - toSend.length,
        },
        "notify: live flush — some escalations were already notified by another process; dispatching the rest",
      );
    }
    await dispatch(toSend, null, { preClaimed: true });
  } catch (err) {
    logger.error(
      { err, areaId, count: bucket.events.length },
      "notify: failed to dispatch grouped escalations",
    );
  }
}

/**
 * Flush all pending grouped notifications immediately. Intended for graceful
 * shutdown and for tests that want to assert delivery without waiting.
 */
export async function flushPendingEscalationNotifications(): Promise<void> {
  const ids = Array.from(pendingByArea.keys());
  await Promise.all(ids.map((id) => flushArea(id)));
}

interface ManagerRow {
  id: number;
  email: string;
  notifyEmailEnabled: boolean;
  notifySlackEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursWeekdayMask: number;
}

/**
 * Outcome strings persisted to `escalations.notify_delivery_status` and
 * surfaced to the manager UI. Keep these in sync with the schema doc-comment
 * and the OpenAPI `Escalation.notifyDeliveryStatus` enum.
 */
export type NotifyDeliveryStatus = "DELIVERED" | "SKIPPED_RECOVERY_WINDOW";

async function markEscalationsNotified(
  escalationIds: number[],
  status: NotifyDeliveryStatus,
): Promise<void> {
  if (escalationIds.length === 0) return;
  try {
    await db
      .update(escalationsTable)
      .set({ notifiedAt: new Date(), notifyDeliveryStatus: status })
      .where(inArray(escalationsTable.id, escalationIds));
  } catch (err) {
    // Best-effort: even if we fail to stamp notified_at, the alert was already
    // delivered. The startup sweep will then re-deliver, which is annoying
    // but better than silent loss — log loudly so we notice.
    logger.error(
      { err, escalationIds, status },
      "notify: failed to stamp notified_at after dispatch (may re-notify on next restart)",
    );
  }
}

async function dispatch(
  events: EscalationNotification[],
  reping: RepingContext | null,
  opts: { preClaimed?: boolean } = {},
): Promise<void> {
  if (events.length === 0) return;

  let managers: ManagerRow[];
  try {
    managers = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        notifyEmailEnabled: usersTable.notifyEmailEnabled,
        notifySlackEnabled: usersTable.notifySlackEnabled,
        quietHoursEnabled: usersTable.quietHoursEnabled,
        quietHoursStart: usersTable.quietHoursStart,
        quietHoursEnd: usersTable.quietHoursEnd,
        quietHoursWeekdayMask: usersTable.quietHoursWeekdayMask,
      })
      .from(usersTable)
      .where(eq(usersTable.role, "MANAGER"));
  } catch (err) {
    // Leave notified_at NULL so the next startup sweep retries these events.
    logger.error(
      { err, count: events.length, areaName: events[0]?.areaName, reping: !!reping },
      "notify: failed to load managers (will retry on next restart)",
    );
    return;
  }

  const now = new Date();
  const quiet = managers.filter((m) => isInQuietHours(m, now));
  const quietIds = new Set(quiet.map((m) => m.id));

  if (quiet.length > 0) {
    logger.info(
      {
        count: events.length,
        areaName: events[0].areaName,
        quietManagers: quiet.map((m) => m.email),
      },
      "notify: suppressing recipients in quiet hours",
    );
  }

  const emailRecipients = managers
    .filter((m) => m.notifyEmailEnabled && !quietIds.has(m.id))
    .map((m) => m.email);
  const anySlackSubscriberActive = managers.some(
    (m) => m.notifySlackEnabled && !quietIds.has(m.id),
  );

  await Promise.allSettled([
    emailRecipients.length > 0 ? sendEmails(emailRecipients, events, reping) : Promise.resolve(),
    anySlackSubscriberActive ? sendSlack(events, reping) : Promise.resolve(),
  ]);

  // Stamp notified_at after the best-effort dispatch attempt — including the
  // case where no provider is configured (those are explicitly logged inside
  // sendSlack/sendEmails). We only skip stamping when manager loading itself
  // failed above, because that's a transient condition we want to retry.
  //
  // The live grouping/immediate paths claim the rows BEFORE calling dispatch
  // (see `claimEscalationsForLiveDispatch`) to atomically guard against a
  // concurrent startup-recovery sweep, so they pass `preClaimed: true` and
  // we skip the redundant restamp here. Re-pings and the recovery sweep
  // continue to stamp here (recovery's own claim only touches `notified_at`,
  // not `notify_delivery_status`, and re-pings stamp to record the latest
  // delivery attempt time).
  if (!opts.preClaimed) {
    await markEscalationsNotified(
      events.map((e) => e.escalationId),
      "DELIVERED",
    );
  }
}

export interface RecoverySweepResult {
  /** Number of un-notified rows this process atomically claimed (recent + too-old). */
  claimed: number;
  /**
   * Number of recent (in-window) rows for which we invoked `dispatch()`. This
   * is the right counter for "exactly-once across concurrent sweeps" — every
   * claimed in-window row gets exactly one dispatch attempt, owned by exactly
   * one process. Whether the underlying provider (Slack webhook, Resend) then
   * succeeds is a separate concern; failures are logged inside `dispatch()`
   * and counted in `dispatchFailures`.
   */
  dispatchAttempted: number;
  /**
   * Number of per-area `dispatch()` invocations that threw. The grouped
   * dispatch path uses `Promise.allSettled` internally, so this is normally 0
   * even when one provider is misbehaving; it goes non-zero only on
   * unexpected exceptions outside the settled batch (e.g. a DB failure while
   * loading manager preferences).
   */
  dispatchFailures: number;
  /** Number of rows older than the recovery window that were marked undeliverable. */
  skippedTooOld: number;
}

/**
 * On API startup, find any escalations that were created recently but never
 * had a notification dispatched (their `notified_at` is still NULL). This
 * happens when the server is restarted mid-grouping-window and the in-memory
 * `pendingByArea` buffer is lost. We re-group by area and dispatch right away
 * so a flaky deploy can't silently swallow manager alerts.
 *
 * Escalations older than the recovery window are explicitly logged as
 * undeliverable and stamped notified_at = now() so we don't re-warn forever.
 *
 * Concurrency safety:
 * If two API server processes start at the same time (rolling deploy, an
 * accidental second replica) they would both run this sweep and a naive
 * `SELECT ... WHERE notified_at IS NULL` would hand both processes the same
 * rows, double-emailing managers. We instead claim ownership atomically with
 *   `UPDATE escalations SET notified_at = now() WHERE notified_at IS NULL ... RETURNING id`
 * Postgres serializes the writes; the second process sees `notified_at` is
 * already set and the row is excluded from its RETURNING set. Each row is
 * dispatched by exactly one process.
 *
 * Trade-off: stamping `notified_at` BEFORE we attempt dispatch means a
 * dispatch failure (e.g. transient Slack/email outage) is not retried by
 * the next startup sweep. We accept that — the previous "stamp after
 * dispatch" design left the door open to double-sends on every concurrent
 * boot, which is the louder user-visible failure. Managers auditing the
 * trail can still find the in-process error logs from `dispatch()`.
 */
export async function recoverPendingEscalationNotifications(): Promise<RecoverySweepResult> {
  const lookbackMs = recoveryWindowMs();
  const cutoff = new Date(Date.now() - lookbackMs);
  // Only consider escalations created strictly before this process started
  // accepting requests. Anything created after we booted is being handled by
  // the live in-memory pipeline; including it here would race the buffered
  // dispatch and double-send to managers.
  const bootCutoff = new Date();

  // Atomically claim every unnotified row in scope. Concurrent sweeps from
  // a sibling process see the rows we won as already-notified and won't
  // try to dispatch them. The returned IDs are the ones THIS process owns.
  let claimedIds: number[];
  try {
    const claimedRows = await db
      .update(escalationsTable)
      .set({ notifiedAt: new Date() })
      .where(
        and(
          isNull(escalationsTable.notifiedAt),
          lt(escalationsTable.createdAt, bootCutoff),
        ),
      )
      .returning({ id: escalationsTable.id });
    claimedIds = claimedRows.map((r) => r.id);
  } catch (err) {
    logger.error({ err }, "notify: startup recovery sweep failed to claim escalations");
    return { claimed: 0, dispatchAttempted: 0, dispatchFailures: 0, skippedTooOld: 0 };
  }

  if (claimedIds.length === 0) {
    logger.info("notify: startup recovery sweep found no unnotified escalations");
    return { claimed: 0, dispatchAttempted: 0, dispatchFailures: 0, skippedTooOld: 0 };
  }

  let claimedRows: Array<{
    escalationId: number;
    submissionId: number;
    areaId: number;
    areaName: string;
    scorePercent: number;
    failingPillarsJson: unknown;
    recommendedActionsJson: unknown;
    operatorEmail: string | null;
    createdAt: Date;
  }>;
  try {
    claimedRows = await db
      .select({
        escalationId: escalationsTable.id,
        submissionId: escalationsTable.submissionId,
        areaId: escalationsTable.areaId,
        areaName: areasTable.name,
        scorePercent: escalationsTable.scorePercent,
        failingPillarsJson: escalationsTable.failingPillarsJson,
        recommendedActionsJson: escalationsTable.recommendedActionsJson,
        operatorEmail: usersTable.email,
        createdAt: escalationsTable.createdAt,
      })
      .from(escalationsTable)
      .innerJoin(areasTable, eq(escalationsTable.areaId, areasTable.id))
      .innerJoin(usersTable, eq(escalationsTable.operatorId, usersTable.id))
      .where(inArray(escalationsTable.id, claimedIds));
  } catch (err) {
    // We've already stamped notified_at in the claim step above, so these
    // rows are now invisible to future recovery sweeps (in this process or
    // any other). Log loudly so an operator can dig out the IDs from the
    // claim that we never managed to dispatch.
    logger.error(
      { err, claimedIds },
      "notify: startup recovery — failed to load joined data for claimed escalations (alerts lost)",
    );
    return {
      claimed: claimedIds.length,
      dispatchAttempted: 0,
      dispatchFailures: 0,
      skippedTooOld: 0,
    };
  }

  const tooOld = claimedRows.filter((row) => row.createdAt < cutoff);
  const recent = claimedRows.filter((row) => row.createdAt >= cutoff);

  if (tooOld.length > 0) {
    // Explicitly log so a manager auditing "why didn't I get an alert?" can
    // see the trail. notified_at was already stamped by the atomic claim
    // above so we don't re-log these on the next restart.
    for (const row of tooOld) {
      logger.warn(
        {
          escalationId: row.escalationId,
          areaId: row.areaId,
          areaName: row.areaName,
          createdAt: row.createdAt,
          lookbackMs,
        },
        "notify: undeliverable — escalation older than recovery window, marking notified",
      );
    }
    // `notified_at` was already stamped by the atomic claim above; we just
    // need to record *why* dispatch was skipped so the manager UI can render
    // the "Delivery skipped" badge instead of treating these as delivered.
    try {
      await db
        .update(escalationsTable)
        .set({ notifyDeliveryStatus: "SKIPPED_RECOVERY_WINDOW" })
        .where(inArray(escalationsTable.id, tooOld.map((r) => r.escalationId)));
    } catch (err) {
      logger.error(
        { err, escalationIds: tooOld.map((r) => r.escalationId) },
        "notify: failed to stamp notify_delivery_status=SKIPPED_RECOVERY_WINDOW (badge will be missing)",
      );
    }
  }

  if (recent.length === 0) {
    return {
      claimed: claimedIds.length,
      dispatchAttempted: 0,
      dispatchFailures: 0,
      skippedTooOld: tooOld.length,
    };
  }

  const byArea = new Map<number, EscalationNotification[]>();
  for (const row of recent) {
    const failing = Array.isArray(row.failingPillarsJson)
      ? (row.failingPillarsJson as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const actions = Array.isArray(row.recommendedActionsJson)
      ? (row.recommendedActionsJson as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const event: EscalationNotification = {
      escalationId: row.escalationId,
      submissionId: row.submissionId,
      areaId: row.areaId,
      areaName: row.areaName,
      scorePercent: row.scorePercent,
      failingPillars: failing,
      operatorEmail: row.operatorEmail ?? "",
      recommendedActions: actions,
    };
    const bucket = byArea.get(row.areaId);
    if (bucket) {
      bucket.push(event);
    } else {
      byArea.set(row.areaId, [event]);
    }
  }

  logger.info(
    { areaCount: byArea.size, eventCount: recent.length, skippedTooOld: tooOld.length },
    "notify: startup recovery — re-dispatching unnotified escalations",
  );

  // Track per-area dispatch outcomes. `dispatchAttempted` is the right
  // counter for "exactly-once across concurrent sweeps" — every claimed
  // in-window row is fed to dispatch() exactly once by exactly one process.
  // `dispatchFailures` is the count of in-window rows whose dispatch call
  // raised an unexpected exception (the grouped path uses Promise.allSettled
  // internally so this is normally 0 even with a flaky provider).
  let dispatchFailures = 0;
  for (const events of byArea.values()) {
    try {
      await dispatch(events, null);
    } catch (err) {
      dispatchFailures += events.length;
      logger.error(
        { err, areaId: events[0].areaId, count: events.length },
        "notify: startup recovery dispatch failed (alerts lost — already claimed)",
      );
    }
  }

  return {
    claimed: claimedIds.length,
    dispatchAttempted: recent.length,
    dispatchFailures,
    skippedTooOld: tooOld.length,
  };
}

/**
 * Dispatch the AI retry-spike alert through the same Slack/email pipeline
 * the escalation paths use, with the same quiet-hours suppression. Failures
 * are best-effort: a flaky provider must not crash the monitor's loop.
 *
 * Unlike `dispatch()` for escalations, there is no DB row to stamp here —
 * cooldown lives in `lib/ai-reliability.ts` so a notifier crash still
 * consumes the cooldown there (preferred over re-spamming on every sweep).
 */
async function dispatchAiRetrySpike(
  payload: AiRetrySpikeNotification,
): Promise<void> {
  let managers: ManagerRow[];
  try {
    managers = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        notifyEmailEnabled: usersTable.notifyEmailEnabled,
        notifySlackEnabled: usersTable.notifySlackEnabled,
        quietHoursEnabled: usersTable.quietHoursEnabled,
        quietHoursStart: usersTable.quietHoursStart,
        quietHoursEnd: usersTable.quietHoursEnd,
        quietHoursWeekdayMask: usersTable.quietHoursWeekdayMask,
      })
      .from(usersTable)
      .where(eq(usersTable.role, "MANAGER"));
  } catch (err) {
    logger.error(
      { err, retryRate: payload.retryRate },
      "notify: failed to load managers for AI retry spike alert",
    );
    return;
  }

  const now = new Date();
  const quiet = managers.filter((m) => isInQuietHours(m, now));
  const quietIds = new Set(quiet.map((m) => m.id));

  if (quiet.length > 0) {
    logger.info(
      { quietManagers: quiet.map((m) => m.email) },
      "notify: AI retry spike — suppressing recipients in quiet hours",
    );
  }

  const emailRecipients = managers
    .filter((m) => m.notifyEmailEnabled && !quietIds.has(m.id))
    .map((m) => m.email);
  const anySlackSubscriberActive = managers.some(
    (m) => m.notifySlackEnabled && !quietIds.has(m.id),
  );

  await Promise.allSettled([
    emailRecipients.length > 0
      ? sendAiRetrySpikeEmails(emailRecipients, payload)
      : Promise.resolve(),
    anySlackSubscriberActive ? sendAiRetrySpikeSlack(payload) : Promise.resolve(),
  ]);
}

function formatRetryPercent(rate: number): string {
  // Round to one decimal so an alert at 16.34% doesn't read as "16%" (loses
  // the "barely over threshold" signal) or "16.3399999%" (looks broken).
  return `${(rate * 100).toFixed(1)}%`;
}

function formatWindow(windowMs: number): string {
  const minutes = Math.round(windowMs / 60_000);
  if (minutes < 60) return `last ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `last ${hours}h`;
  const days = Math.round(hours / 24);
  return `last ${days}d`;
}

async function sendAiRetrySpikeSlack(
  payload: AiRetrySpikeNotification,
): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhook) {
    logger.info(
      { retryRate: payload.retryRate, totalCalls: payload.totalCalls },
      "notify: SLACK_WEBHOOK_URL not set — skipping AI retry spike Slack message",
    );
    return;
  }

  const link = dashboardLink();
  const ratePct = formatRetryPercent(payload.retryRate);
  const thresholdPct = formatRetryPercent(payload.thresholdRate);
  const window = formatWindow(payload.windowMs);
  const headline = `:warning: *AI scoring retry rate spiked* — ${ratePct} over the ${window} (threshold ${thresholdPct})`;
  const summary = `:warning: AI scoring retry rate ${ratePct} (threshold ${thresholdPct}) — ~2× per-audit cost while elevated`;

  const message = {
    text: summary,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `${headline}\n` +
            `*Retry rate:* ${ratePct}\n` +
            `*Sample:* ${payload.retriedCalls} of ${payload.totalCalls} calls retried\n` +
            `*Threshold:* ${thresholdPct}\n` +
            `*Window:* ${window}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open dashboard" },
            url: link,
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(
        { status: res.status, body: body.slice(0, 200) },
        "notify: AI retry spike Slack webhook returned non-2xx",
      );
      return;
    }
    logger.info(
      { retryRate: payload.retryRate, totalCalls: payload.totalCalls },
      "notify: AI retry spike Slack message posted",
    );
  } catch (err) {
    logger.error({ err }, "notify: AI retry spike Slack post failed");
  }
}

async function sendAiRetrySpikeEmails(
  recipients: string[],
  payload: AiRetrySpikeNotification,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.NOTIFICATION_FROM_EMAIL?.trim();
  if (!apiKey || !from) {
    logger.info(
      { recipientCount: recipients.length, retryRate: payload.retryRate },
      "notify: RESEND_API_KEY / NOTIFICATION_FROM_EMAIL not set — skipping AI retry spike email",
    );
    return;
  }

  const link = dashboardLink();
  const ratePct = formatRetryPercent(payload.retryRate);
  const thresholdPct = formatRetryPercent(payload.thresholdRate);
  const window = formatWindow(payload.windowMs);
  const subject = `AI scoring retry rate ${ratePct} (threshold ${thresholdPct}) — check the dashboard`;

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#222">` +
    `<h2 style="margin:0 0 10px;font-size:18px">AI scoring retry rate spiked</h2>` +
    `<p style="margin:0 0 14px;color:#555;font-size:14px">The VLM is failing JSON validation on first response often enough that we're paying ~2× per audit to retry.</p>` +
    `<table style="font-size:14px;line-height:1.5">` +
    `<tr><td style="color:#666;padding-right:12px">Retry rate</td><td><b>${ratePct}</b></td></tr>` +
    `<tr><td style="color:#666;padding-right:12px">Sample</td><td>${payload.retriedCalls} of ${payload.totalCalls} calls retried</td></tr>` +
    `<tr><td style="color:#666;padding-right:12px">Threshold</td><td>${thresholdPct}</td></tr>` +
    `<tr><td style="color:#666;padding-right:12px">Window</td><td>${escapeHtml(window)}</td></tr>` +
    `</table>` +
    `<p style="margin:22px 0 0"><a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Open dashboard</a></p>` +
    `</div>`;

  const text =
    `AI scoring retry rate spiked\n\n` +
    `Retry rate: ${ratePct}\n` +
    `Sample: ${payload.retriedCalls} of ${payload.totalCalls} calls retried\n` +
    `Threshold: ${thresholdPct}\n` +
    `Window: ${window}\n\n` +
    `Open dashboard: ${link}\n`;

  await Promise.allSettled(
    recipients.map(async (to) => {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ from, to, subject, html, text }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          logger.error(
            { to, status: res.status, body: body.slice(0, 200) },
            "notify: AI retry spike Resend returned non-2xx",
          );
          return;
        }
        logger.info({ to, retryRate: payload.retryRate }, "notify: AI retry spike email sent");
      } catch (err) {
        logger.error({ err, to }, "notify: AI retry spike email send failed");
      }
    }),
  );
}

function formatPillars(pillars: string[]): string {
  if (pillars.length === 0) return "(none reported)";
  return pillars.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(", ");
}

function lowestScore(events: EscalationNotification[]): number {
  return events.reduce((min, e) => (e.scorePercent < min ? e.scorePercent : min), events[0].scorePercent);
}

function windowMinutesLabel(): string {
  const ms = groupingWindowMs();
  const mins = Math.max(1, Math.round(ms / 60000));
  return `${mins} min`;
}

async function sendSlack(
  events: EscalationNotification[],
  reping: RepingContext | null,
): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhook) {
    logger.info(
      { count: events.length, areaName: events[0].areaName, reping: !!reping },
      "notify: SLACK_WEBHOOK_URL not set — skipping Slack message",
    );
    return;
  }

  // Re-pings always carry exactly one event (see notifyEscalationReping), so
  // grouped Slack messages are always plain "new escalations" digests.
  const message =
    events.length === 1 ? buildSingleSlack(events[0], reping) : buildGroupedSlack(events);

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(
        { count: events.length, status: res.status, body: body.slice(0, 200), reping: !!reping },
        "notify: Slack webhook returned non-2xx",
      );
      return;
    }
    logger.info(
      { count: events.length, areaName: events[0].areaName, reping: !!reping },
      "notify: Slack message posted",
    );
  } catch (err) {
    logger.error({ err, count: events.length, reping: !!reping }, "notify: Slack post failed");
  }
}

function buildSingleSlack(payload: EscalationNotification, reping: RepingContext | null): unknown {
  const link = escalationLink(payload.escalationId);
  const headline = reping
    ? `:bell: *5S escalation still open* — Aging ${reping.ageMinutes} min (reminder ${reping.attempt}/${reping.maxAttempts})`
    : `:rotating_light: *5S audit auto-escalated*`;
  const summary = reping
    ? `:bell: 5S escalation still open: *${payload.areaName}* — ${payload.scorePercent}% (aging ${reping.ageMinutes} min)`
    : `:rotating_light: 5S audit auto-escalated: *${payload.areaName}* — ${payload.scorePercent}%`;
  return {
    text: summary,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `${headline}\n` +
            `*Area:* ${payload.areaName}\n` +
            `*Score:* ${payload.scorePercent}%\n` +
            `*Operator:* ${payload.operatorEmail}\n` +
            `*Failing pillars:* ${formatPillars(payload.failingPillars)}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open escalation" },
            url: link,
          },
        ],
      },
    ],
  };
}

function buildGroupedSlack(events: EscalationNotification[]): unknown {
  const areaName = events[0].areaName;
  const lowest = lowestScore(events);
  const window = windowMinutesLabel();
  const headline = `:rotating_light: ${events.length} new 5S escalations on *${areaName}* in the last ${window} — lowest score ${lowest}%`;

  const lines = events.map((e) => {
    const pillars = formatPillars(e.failingPillars);
    return `• *${e.scorePercent}%* — ${e.operatorEmail} (${pillars}) — <${escalationLink(e.escalationId)}|open>`;
  });

  return {
    text: `:rotating_light: ${events.length} new 5S escalations on ${areaName} — lowest ${lowest}%`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: headline },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open escalations inbox" },
            url: inboxLink(),
          },
        ],
      },
    ],
  };
}

async function sendEmails(
  recipients: string[],
  events: EscalationNotification[],
  reping: RepingContext | null,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.NOTIFICATION_FROM_EMAIL?.trim();
  if (!apiKey || !from) {
    logger.info(
      { count: events.length, recipientCount: recipients.length, reping: !!reping },
      "notify: RESEND_API_KEY / NOTIFICATION_FROM_EMAIL not set — skipping email",
    );
    return;
  }

  // Re-pings always carry exactly one event (see notifyEscalationReping), so
  // grouped emails are always plain "new escalations" digests.
  const { subject, html, text } =
    events.length === 1 ? buildSingleEmail(events[0], reping) : buildGroupedEmail(events);

  await Promise.allSettled(
    recipients.map(async (to) => {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ from, to, subject, html, text }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          logger.error(
            { count: events.length, to, status: res.status, body: body.slice(0, 200), reping: !!reping },
            "notify: Resend returned non-2xx",
          );
          return;
        }
        logger.info({ count: events.length, to, reping: !!reping }, "notify: email sent");
      } catch (err) {
        logger.error({ err, count: events.length, to, reping: !!reping }, "notify: email send failed");
      }
    }),
  );
}

function buildSingleEmail(
  payload: EscalationNotification,
  reping: RepingContext | null,
): { subject: string; html: string; text: string } {
  const link = escalationLink(payload.escalationId);
  const subject = reping
    ? `[Aging ${reping.ageMinutes} min] 5S escalation still open: ${payload.areaName} — ${payload.scorePercent}%`
    : `5S audit escalated: ${payload.areaName} — ${payload.scorePercent}%`;
  const heading = reping ? "5S escalation still open" : "5S audit auto-escalated";
  const repingBannerHtml = reping
    ? `<p style="margin:0 0 10px;padding:8px 12px;background:#fef3c7;color:#92400e;border-radius:6px;font-size:13px;font-weight:600">Aging ${reping.ageMinutes} min — reminder ${reping.attempt} of ${reping.maxAttempts}</p>`
    : "";
  const repingBannerText = reping
    ? `Aging ${reping.ageMinutes} min — reminder ${reping.attempt} of ${reping.maxAttempts}\n\n`
    : "";

  const actionsHtml =
    payload.recommendedActions.length === 0
      ? ""
      : `<p style="margin:18px 0 6px;font-size:13px;color:#555;text-transform:uppercase;letter-spacing:.04em;">Recommended actions</p>` +
        `<ul style="margin:0;padding-left:18px;color:#222;font-size:14px;line-height:1.5">` +
        payload.recommendedActions.slice(0, 5).map((a) => `<li>${escapeHtml(a)}</li>`).join("") +
        `</ul>`;

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#222">` +
    repingBannerHtml +
    `<h2 style="margin:0 0 10px;font-size:18px">${heading}</h2>` +
    `<table style="font-size:14px;line-height:1.5">` +
    `<tr><td style="color:#666;padding-right:12px">Area</td><td><b>${escapeHtml(payload.areaName)}</b></td></tr>` +
    `<tr><td style="color:#666;padding-right:12px">Score</td><td><b>${payload.scorePercent}%</b></td></tr>` +
    `<tr><td style="color:#666;padding-right:12px">Operator</td><td>${escapeHtml(payload.operatorEmail)}</td></tr>` +
    `<tr><td style="color:#666;padding-right:12px;vertical-align:top">Failing pillars</td><td>${escapeHtml(formatPillars(payload.failingPillars))}</td></tr>` +
    `</table>` +
    actionsHtml +
    `<p style="margin:22px 0 0"><a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Open escalation</a></p>` +
    `</div>`;

  const text =
    `${heading}\n\n` +
    repingBannerText +
    `Area: ${payload.areaName}\n` +
    `Score: ${payload.scorePercent}%\n` +
    `Operator: ${payload.operatorEmail}\n` +
    `Failing pillars: ${formatPillars(payload.failingPillars)}\n\n` +
    (payload.recommendedActions.length
      ? `Recommended actions:\n${payload.recommendedActions.slice(0, 5).map((a) => `  - ${a}`).join("\n")}\n\n`
      : "") +
    `Open: ${link}\n`;

  return { subject, html, text };
}

function buildGroupedEmail(events: EscalationNotification[]): { subject: string; html: string; text: string } {
  const areaName = events[0].areaName;
  const lowest = lowestScore(events);
  const window = windowMinutesLabel();
  const subject = `${events.length} new 5S escalations: ${areaName} (lowest ${lowest}%)`;

  const rowsHtml = events
    .map((e) => {
      const link = escalationLink(e.escalationId);
      return (
        `<tr>` +
        `<td style="padding:6px 12px 6px 0;font-weight:600">${e.scorePercent}%</td>` +
        `<td style="padding:6px 12px 6px 0">${escapeHtml(e.operatorEmail)}</td>` +
        `<td style="padding:6px 12px 6px 0;color:#555">${escapeHtml(formatPillars(e.failingPillars))}</td>` +
        `<td style="padding:6px 0"><a href="${link}" style="color:#1a56db;text-decoration:none">Open</a></td>` +
        `</tr>`
      );
    })
    .join("");

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;color:#222">` +
    `<h2 style="margin:0 0 6px;font-size:18px">${events.length} new 5S escalations on ${escapeHtml(areaName)}</h2>` +
    `<p style="margin:0 0 14px;color:#555;font-size:14px">In the last ${window}. Lowest score: <b>${lowest}%</b>.</p>` +
    `<table style="font-size:14px;line-height:1.5;border-collapse:collapse">` +
    `<thead><tr style="text-align:left;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.04em">` +
    `<th style="padding:0 12px 6px 0">Score</th>` +
    `<th style="padding:0 12px 6px 0">Operator</th>` +
    `<th style="padding:0 12px 6px 0">Failing pillars</th>` +
    `<th style="padding:0 0 6px 0"></th>` +
    `</tr></thead>` +
    `<tbody>${rowsHtml}</tbody>` +
    `</table>` +
    `<p style="margin:22px 0 0"><a href="${inboxLink()}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Open escalations inbox</a></p>` +
    `</div>`;

  const textRows = events
    .map((e) => {
      const link = escalationLink(e.escalationId);
      return `  - ${e.scorePercent}% — ${e.operatorEmail} (${formatPillars(e.failingPillars)}) — ${link}`;
    })
    .join("\n");

  const text =
    `${events.length} new 5S escalations on ${areaName} in the last ${window}\n` +
    `Lowest score: ${lowest}%\n\n` +
    `${textRows}\n\n` +
    `Inbox: ${inboxLink()}\n`;

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function notificationProviderStatus(): { emailConfigured: boolean; slackConfigured: boolean } {
  return {
    emailConfigured: !!(process.env.RESEND_API_KEY?.trim() && process.env.NOTIFICATION_FROM_EMAIL?.trim()),
    slackConfigured: !!process.env.SLACK_WEBHOOK_URL?.trim(),
  };
}
