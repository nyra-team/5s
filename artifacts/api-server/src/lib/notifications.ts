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

export async function notifyEscalationCreated(payload: EscalationNotification): Promise<void> {
  const windowMs = groupingWindowMs();
  if (windowMs <= 0) {
    // Grouping disabled — send immediately as a single-event message.
    await dispatch([payload], null);
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

/**
 * Re-pings bypass the grouping window — they are reminders for one specific
 * escalation that has been sitting in OPEN past the threshold, so coalescing
 * them with other events would dilute the signal and make the "Aging X min"
 * banner meaningless.
 */
export async function notifyEscalationReping(
  payload: EscalationNotification,
  context: RepingContext,
): Promise<void> {
  await dispatch([payload], context);
}

async function flushArea(areaId: number): Promise<void> {
  const bucket = pendingByArea.get(areaId);
  if (!bucket) return;
  pendingByArea.delete(areaId);
  clearTimeout(bucket.timer);
  try {
    await dispatch(bucket.events, null);
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

async function markEscalationsNotified(escalationIds: number[]): Promise<void> {
  if (escalationIds.length === 0) return;
  try {
    await db
      .update(escalationsTable)
      .set({ notifiedAt: new Date() })
      .where(inArray(escalationsTable.id, escalationIds));
  } catch (err) {
    // Best-effort: even if we fail to stamp notified_at, the alert was already
    // delivered. The startup sweep will then re-deliver, which is annoying
    // but better than silent loss — log loudly so we notice.
    logger.error(
      { err, escalationIds },
      "notify: failed to stamp notified_at after dispatch (may re-notify on next restart)",
    );
  }
}

async function dispatch(
  events: EscalationNotification[],
  reping: RepingContext | null,
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
  await markEscalationsNotified(events.map((e) => e.escalationId));
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
 */
export async function recoverPendingEscalationNotifications(): Promise<void> {
  const lookbackMs = recoveryWindowMs();
  const cutoff = new Date(Date.now() - lookbackMs);
  // Only consider escalations created strictly before this process started
  // accepting requests. Anything created after we booted is being handled by
  // the live in-memory pipeline; including it here would race the buffered
  // dispatch and double-send to managers.
  const bootCutoff = new Date();

  let unnotified: Array<{
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
    unnotified = await db
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
      .where(
        and(
          isNull(escalationsTable.notifiedAt),
          lt(escalationsTable.createdAt, bootCutoff),
        ),
      );
  } catch (err) {
    logger.error({ err }, "notify: startup recovery sweep failed to query escalations");
    return;
  }

  if (unnotified.length === 0) {
    logger.info("notify: startup recovery sweep found no unnotified escalations");
    return;
  }

  const tooOld = unnotified.filter((row) => row.createdAt < cutoff);
  const recent = unnotified.filter((row) => row.createdAt >= cutoff);

  if (tooOld.length > 0) {
    // Explicitly log so a manager auditing "why didn't I get an alert?" can
    // see the trail. We still stamp notified_at so we don't re-log forever.
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
    await markEscalationsNotified(tooOld.map((r) => r.escalationId));
  }

  if (recent.length === 0) return;

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

  for (const events of byArea.values()) {
    try {
      await dispatch(events, null);
    } catch (err) {
      logger.error(
        { err, areaId: events[0].areaId, count: events.length },
        "notify: startup recovery dispatch failed (will retry on next restart)",
      );
    }
  }
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
