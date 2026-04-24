import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

export interface EscalationNotification {
  escalationId: number;
  submissionId: number;
  areaName: string;
  scorePercent: number;
  failingPillars: string[];
  operatorEmail: string;
  recommendedActions: string[];
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

export async function notifyEscalationCreated(payload: EscalationNotification): Promise<void> {
  let managers: Array<{ id: number; email: string; notifyEmailEnabled: boolean; notifySlackEnabled: boolean }>;
  try {
    managers = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        notifyEmailEnabled: usersTable.notifyEmailEnabled,
        notifySlackEnabled: usersTable.notifySlackEnabled,
      })
      .from(usersTable)
      .where(eq(usersTable.role, "MANAGER"));
  } catch (err) {
    logger.error({ err, escalationId: payload.escalationId }, "notify: failed to load managers");
    return;
  }

  const emailRecipients = managers.filter((m) => m.notifyEmailEnabled).map((m) => m.email);
  const anySlackSubscriber = managers.some((m) => m.notifySlackEnabled);

  await Promise.allSettled([
    emailRecipients.length > 0 ? sendEmails(emailRecipients, payload) : Promise.resolve(),
    anySlackSubscriber ? sendSlack(payload) : Promise.resolve(),
  ]);
}

function formatPillars(pillars: string[]): string {
  if (pillars.length === 0) return "(none reported)";
  return pillars.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(", ");
}

async function sendSlack(payload: EscalationNotification): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhook) {
    logger.info(
      { escalationId: payload.escalationId },
      "notify: SLACK_WEBHOOK_URL not set — skipping Slack message",
    );
    return;
  }

  const link = escalationLink(payload.escalationId);
  const message = {
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

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(
        { escalationId: payload.escalationId, status: res.status, body: body.slice(0, 200) },
        "notify: Slack webhook returned non-2xx",
      );
      return;
    }
    logger.info({ escalationId: payload.escalationId }, "notify: Slack message posted");
  } catch (err) {
    logger.error({ err, escalationId: payload.escalationId }, "notify: Slack post failed");
  }
}

async function sendEmails(recipients: string[], payload: EscalationNotification): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.NOTIFICATION_FROM_EMAIL?.trim();
  if (!apiKey || !from) {
    logger.info(
      { escalationId: payload.escalationId, recipientCount: recipients.length },
      "notify: RESEND_API_KEY / NOTIFICATION_FROM_EMAIL not set — skipping email",
    );
    return;
  }

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
            { escalationId: payload.escalationId, to, status: res.status, body: body.slice(0, 200) },
            "notify: Resend returned non-2xx",
          );
          return;
        }
        logger.info({ escalationId: payload.escalationId, to }, "notify: email sent");
      } catch (err) {
        logger.error({ err, escalationId: payload.escalationId, to }, "notify: email send failed");
      }
    }),
  );
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
