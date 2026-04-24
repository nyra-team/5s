import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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

const DEFAULT_GROUPING_WINDOW_MS = 5 * 60 * 1000;

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
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mn)) return null;
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
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

  // Shift "now" by +5:30 and read UTC fields to get IST clock values.
  const istMs = now.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istMs);
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
    await dispatch([payload]);
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

async function flushArea(areaId: number): Promise<void> {
  const bucket = pendingByArea.get(areaId);
  if (!bucket) return;
  pendingByArea.delete(areaId);
  clearTimeout(bucket.timer);
  try {
    await dispatch(bucket.events);
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

async function dispatch(events: EscalationNotification[]): Promise<void> {
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
    logger.error(
      { err, count: events.length, areaName: events[0]?.areaName },
      "notify: failed to load managers",
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
    emailRecipients.length > 0 ? sendEmails(emailRecipients, events) : Promise.resolve(),
    anySlackSubscriberActive ? sendSlack(events) : Promise.resolve(),
  ]);
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

async function sendSlack(events: EscalationNotification[]): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhook) {
    logger.info(
      { count: events.length, areaName: events[0].areaName },
      "notify: SLACK_WEBHOOK_URL not set — skipping Slack message",
    );
    return;
  }

  const message = events.length === 1 ? buildSingleSlack(events[0]) : buildGroupedSlack(events);

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(
        { count: events.length, status: res.status, body: body.slice(0, 200) },
        "notify: Slack webhook returned non-2xx",
      );
      return;
    }
    logger.info(
      { count: events.length, areaName: events[0].areaName },
      "notify: Slack message posted",
    );
  } catch (err) {
    logger.error({ err, count: events.length }, "notify: Slack post failed");
  }
}

function buildSingleSlack(payload: EscalationNotification): unknown {
  const link = escalationLink(payload.escalationId);
  return {
    text: `:rotating_light: 5S audit auto-escalated: *${payload.areaName}* — ${payload.scorePercent}%`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `:rotating_light: *5S audit auto-escalated*\n` +
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

async function sendEmails(recipients: string[], events: EscalationNotification[]): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.NOTIFICATION_FROM_EMAIL?.trim();
  if (!apiKey || !from) {
    logger.info(
      { count: events.length, recipientCount: recipients.length },
      "notify: RESEND_API_KEY / NOTIFICATION_FROM_EMAIL not set — skipping email",
    );
    return;
  }

  const { subject, html, text } =
    events.length === 1 ? buildSingleEmail(events[0]) : buildGroupedEmail(events);

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
            { count: events.length, to, status: res.status, body: body.slice(0, 200) },
            "notify: Resend returned non-2xx",
          );
          return;
        }
        logger.info({ count: events.length, to }, "notify: email sent");
      } catch (err) {
        logger.error({ err, count: events.length, to }, "notify: email send failed");
      }
    }),
  );
}

function buildSingleEmail(payload: EscalationNotification): { subject: string; html: string; text: string } {
  const link = escalationLink(payload.escalationId);
  const subject = `5S audit escalated: ${payload.areaName} — ${payload.scorePercent}%`;

  const actionsHtml =
    payload.recommendedActions.length === 0
      ? ""
      : `<p style="margin:18px 0 6px;font-size:13px;color:#555;text-transform:uppercase;letter-spacing:.04em;">Recommended actions</p>` +
        `<ul style="margin:0;padding-left:18px;color:#222;font-size:14px;line-height:1.5">` +
        payload.recommendedActions.slice(0, 5).map((a) => `<li>${escapeHtml(a)}</li>`).join("") +
        `</ul>`;

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#222">` +
    `<h2 style="margin:0 0 10px;font-size:18px">5S audit auto-escalated</h2>` +
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
    `5S audit auto-escalated\n\n` +
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
