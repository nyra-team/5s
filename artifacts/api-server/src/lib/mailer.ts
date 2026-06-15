/**
 * SMTP mailer for the 5S api-server.
 *
 * Mirrors the suite-wide transport in `backend/shared/mailer.js` (Office 365
 * SMTP over STARTTLS) but kept self-contained: the 5S app is a separate pnpm
 * workspace, so it owns a thin nodemailer wrapper rather than reaching across
 * repos.
 *
 * Env is read LAZILY inside functions, never at module load — the api-server
 * sources `5s/.env` into the process env at start, and a top-level capture
 * would freeze empty values (same hazard called out in the suite CLAUDE.md).
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ("true" => implicit TLS),
 *   SMTP_USER, SMTP_PASS, FROM_EMAIL (defaults to SMTP_USER), FROM_NAME.
 *
 * `nodemailer` is intentionally in build.mjs `external`, so it is required at
 * runtime from node_modules rather than bundled into dist/index.mjs.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  const host = process.env["SMTP_HOST"];
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];
  if (!host || !user || !pass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host,
      port: Number(process.env["SMTP_PORT"] || 587),
      // false => STARTTLS on 587 (Office 365); true => implicit TLS on 465.
      secure: process.env["SMTP_SECURE"] === "true",
      auth: { user, pass },
    });
  }
  return transporter;
}

/** True when SMTP credentials are present. Read lazily so a restart picks up edits. */
export function hasEmailConfig(): boolean {
  return !!(process.env["SMTP_HOST"] && process.env["SMTP_USER"] && process.env["SMTP_PASS"]);
}

function fromAddress(): string {
  const email = process.env["FROM_EMAIL"] || process.env["SMTP_USER"] || "";
  const name = process.env["FROM_NAME"] || "Granules 5S";
  return name ? `"${name}" <${email}>` : email;
}

/**
 * Branded HTML for the reset email. Inline styles only (email clients strip
 * <style>), navy/sky palette to match the suite. No external/CID logo — the
 * 5S workspace doesn't ship the logo asset, so we use a text wordmark.
 */
function resetHtml(resetUrl: string, ttlMinutes: number): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#eef2f6;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f6;">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
      <tr><td style="background:#1e3a5f;padding:22px 36px;text-align:center;">
        <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:2px;">GRANULES&nbsp;5S</span>
      </td></tr>
      <tr><td style="padding:34px 36px 10px 36px;color:#1f2937;font-size:14px;line-height:1.65;">
        <p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1e3a5f;">Reset your password</p>
        <p style="margin:0 0 18px;">We received a request to reset the password for your Granules 5S account. Click the button below to choose a new password.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
          <tr><td style="border-radius:8px;background:#0284c7;">
            <a href="${resetUrl}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">Reset password</a>
          </td></tr>
        </table>
        <p style="margin:0 0 6px;color:#64748b;font-size:12px;">Or paste this link into your browser:</p>
        <p style="margin:0 0 18px;word-break:break-all;"><a href="${resetUrl}" style="color:#0284c7;font-size:12px;">${resetUrl}</a></p>
        <p style="margin:0;color:#64748b;font-size:12px;line-height:1.55;">This link expires in ${ttlMinutes} minutes and can be used once. If you didn't request this, you can safely ignore this email — your password won't change.</p>
      </td></tr>
      <tr><td style="padding:18px 36px 28px 36px;border-top:1px solid #eef1f5;">
        <p style="margin:0;color:#94a3b8;font-size:11px;">This is an automated message from Granules 5S. Please do not reply directly.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/**
 * Send the password-reset email over SMTP. Throws on submission failure
 * (auth error, connection failure, or every recipient rejected) — callers
 * decide whether to fall back to another transport.
 *
 * NOTE: a resolved promise means the SMTP server *accepted* the message
 * (250) — not proof of delivery. Office 365 can still quarantine/drop after
 * a 250. Every send is logged with its Message-ID for Exchange trace lookup.
 */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  ttlMinutes: number,
): Promise<void> {
  const t = getTransporter();
  if (!t) throw new Error("SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)");
  const text =
    `Reset your Granules 5S password\n\n` +
    `We received a request to reset your password. Open this link to choose a new one:\n\n` +
    `${resetUrl}\n\n` +
    `This link expires in ${ttlMinutes} minutes and can be used once. ` +
    `If you didn't request this, ignore this email — your password won't change.`;
  const info = await t.sendMail({
    from: fromAddress(),
    to,
    subject: "Reset your Granules 5S password",
    text,
    html: resetHtml(resetUrl, ttlMinutes),
  });
  logger.info(
    {
      to,
      messageId: info.messageId,
      accepted: info.accepted?.length ?? 0,
      rejected: info.rejected?.length ?? 0,
      response: info.response,
    },
    "password reset email accepted by SMTP",
  );
}
