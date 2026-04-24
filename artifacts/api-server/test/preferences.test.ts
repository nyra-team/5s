import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { TestWorld, api } from "./helpers.js";
import {
  notifyEscalationCreated,
  flushPendingEscalationNotifications,
  type EscalationNotification,
} from "../src/lib/notifications.js";

interface PreferencesShape {
  notifyEmailEnabled: boolean;
  notifySlackEnabled: boolean;
  emailConfigured: boolean;
  slackConfigured: boolean;
  email: string;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursWeekdayMask: number;
  quietHoursActive: boolean;
  quietHoursActiveUntil: string | null;
  quietHoursNextStart: string | null;
}

async function setPrefs(
  userId: number,
  patch: Partial<{
    notifyEmailEnabled: boolean;
    notifySlackEnabled: boolean;
  }>,
): Promise<void> {
  await db.update(usersTable).set(patch).where(eq(usersTable.id, userId));
}

describe("GET /api/me/notification-preferences", () => {
  let world: TestWorld;
  beforeEach(() => {
    world = new TestWorld();
  });
  afterEach(async () => {
    await world.cleanup();
  });

  test("returns the calling manager's prefs plus emailConfigured/slackConfigured/email", async () => {
    const manager = await world.createUser("MANAGER", "prefs-mgr");
    const r = await api<PreferencesShape>(
      manager.token,
      "GET",
      "/api/me/notification-preferences",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.email, manager.email);
    // Schema defaults: email on, slack off — confirms the route surfaces what
    // the column actually holds (not a hardcoded shape).
    assert.equal(r.body.notifyEmailEnabled, true);
    assert.equal(r.body.notifySlackEnabled, false);
    // Provider configured-ness is a derived boolean from env, not from the
    // user row. We just assert the field is present and typed correctly so a
    // future regression that drops it is caught.
    assert.equal(typeof r.body.emailConfigured, "boolean");
    assert.equal(typeof r.body.slackConfigured, "boolean");
    // Quiet-hours defaults round-trip through normalizeTimeOfDay unchanged.
    assert.equal(r.body.quietHoursEnabled, false);
    assert.equal(r.body.quietHoursStart, "22:00");
    assert.equal(r.body.quietHoursEnd, "07:00");
    assert.equal(r.body.quietHoursWeekdayMask, 127);
  });

  test("rejects an unauthenticated caller with 401", async () => {
    const r = await api(null, "GET", "/api/me/notification-preferences");
    assert.equal(r.status, 401);
  });

  test("rejects an operator with 403", async () => {
    const op = await world.createUser("OPERATOR");
    const r = await api(op.token, "GET", "/api/me/notification-preferences");
    assert.equal(r.status, 403);
  });
});

describe("PUT /api/me/notification-preferences", () => {
  let world: TestWorld;
  beforeEach(() => {
    world = new TestWorld();
  });
  afterEach(async () => {
    await world.cleanup();
  });

  test("updates only the boolean fields it receives and ignores unknown keys", async () => {
    const manager = await world.createUser("MANAGER");

    // Send only `notifySlackEnabled`. The route's permissive shape should
    // (a) flip slack, (b) leave the email pref alone at its default of true,
    // and (c) silently drop the unknown `role` / `garbage` keys instead of
    // applying them to the row.
    const r = await api<PreferencesShape>(
      manager.token,
      "PUT",
      "/api/me/notification-preferences",
      { notifySlackEnabled: true, role: "OPERATOR", garbage: 42 },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.notifyEmailEnabled, true, "untouched email pref must stay true");
    assert.equal(r.body.notifySlackEnabled, true, "slack flag should be flipped");

    // Confirm at the DB layer that the unknown `role` key was NOT smuggled
    // into the row, and that the boolean it did receive landed.
    const [row] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, manager.id));
    assert.equal(row.notifyEmailEnabled, true);
    assert.equal(row.notifySlackEnabled, true);
    assert.equal(row.role, "MANAGER", "unknown 'role' key must be ignored, not persisted");

    // Second PUT: mute email only. Slack must stay at the value we just
    // flipped (proving we don't reset omitted booleans to defaults).
    const r2 = await api<PreferencesShape>(
      manager.token,
      "PUT",
      "/api/me/notification-preferences",
      { notifyEmailEnabled: false },
    );
    assert.equal(r2.status, 200);
    assert.equal(r2.body.notifyEmailEnabled, false);
    assert.equal(r2.body.notifySlackEnabled, true, "previous slack flip must be preserved");
  });

  test("ignores malformed types instead of rejecting the whole request", async () => {
    const manager = await world.createUser("MANAGER");
    // `notifyEmailEnabled: "no"` and `notifySlackEnabled: 1` are the wrong
    // primitive types. The route's `typeof === "boolean"` guard should drop
    // both, leaving the row at its defaults rather than 400-ing the call.
    const r = await api<PreferencesShape>(
      manager.token,
      "PUT",
      "/api/me/notification-preferences",
      { notifyEmailEnabled: "no", notifySlackEnabled: 1 },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.notifyEmailEnabled, true);
    assert.equal(r.body.notifySlackEnabled, false);
  });

  test("rejects an unauthenticated caller with 401", async () => {
    const r = await api(null, "PUT", "/api/me/notification-preferences", {
      notifyEmailEnabled: false,
    });
    assert.equal(r.status, 401);
  });

  test("rejects an operator with 403", async () => {
    const op = await world.createUser("OPERATOR");
    const r = await api(op.token, "PUT", "/api/me/notification-preferences", {
      notifyEmailEnabled: false,
    });
    assert.equal(r.status, 403);
  });
});

interface CapturedRequest {
  url: string;
  body: unknown;
}

/**
 * Replace `globalThis.fetch` with a recorder that resolves every request to
 * an empty 200 OK. The notifier dispatches Slack via webhook POST and email
 * via a Resend POST — both go through `fetch` — so this is the cheapest seam
 * to assert on which channels actually fired without standing up a fake
 * Resend or webhook server.
 *
 * NOTE: this only patches fetch for the duration of the surrounding describe
 * (installed in beforeEach, restored in afterEach). The HTTP-route tests
 * above use the real fetch to talk to the test server — they live in
 * separate describes so the mock never leaks into them.
 */
function installFetchRecorder(): {
  calls: CapturedRequest[];
  restore: () => void;
} {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    let body: unknown = null;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, body });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("notifyEscalationCreated channel filtering", () => {
  let world: TestWorld;
  let recorder: ReturnType<typeof installFetchRecorder>;
  // Snapshot env so per-test overrides can't leak into siblings.
  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "ESCALATION_NOTIFICATION_WINDOW_MS",
    "RESEND_API_KEY",
    "NOTIFICATION_FROM_EMAIL",
    "SLACK_WEBHOOK_URL",
  ];
  const SLACK_WEBHOOK = "https://hooks.slack.test/services/T/B/X";
  const RESEND_URL = "https://api.resend.com/emails";

  beforeEach(() => {
    for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];
    // Pin a 0ms grouping window so notifyEscalationCreated dispatches inline
    // and we can assert on fetches the moment the call returns. Configure
    // both providers as "set" so the early-return inside sendEmails/sendSlack
    // doesn't hide the per-channel filter we're trying to test.
    process.env.ESCALATION_NOTIFICATION_WINDOW_MS = "0";
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.NOTIFICATION_FROM_EMAIL = "alerts@5s.test";
    process.env.SLACK_WEBHOOK_URL = SLACK_WEBHOOK;
    world = new TestWorld();
    recorder = installFetchRecorder();
  });
  afterEach(async () => {
    // Drain any pending grouped-notification timer state before the next test
    // boots a fresh recorder. Belt-and-braces: we set WINDOW_MS=0 above so no
    // bucket should ever exist, but flushing is cheap and protects against a
    // future regression where 0 stops meaning "immediate".
    await flushPendingEscalationNotifications();
    recorder.restore();
    await world.cleanup();
    for (const k of ENV_KEYS) {
      if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL_ENV[k];
    }
  });

  // The notifier doesn't load the escalation row back from the DB during
  // dispatch — it only uses the fields on this payload. The escalationId is
  // also fed into a best-effort `markEscalationsNotified` UPDATE which simply
  // matches zero rows for a non-existent id, so we don't need a real row.
  function makeEvent(areaId: number, areaName: string): EscalationNotification {
    return {
      escalationId: 0,
      submissionId: 0,
      areaId,
      areaName,
      scorePercent: 41,
      failingPillars: ["sort", "set"],
      operatorEmail: "op@5s.test",
      recommendedActions: ["wipe down M-1"],
    };
  }

  test("emails only managers with notifyEmailEnabled = true", async () => {
    const optedIn = await world.createUser("MANAGER", "email-on");
    const optedOut = await world.createUser("MANAGER", "email-off");
    // A slack-only subscriber: present so Slack is also dispatched on this
    // call, which lets us additionally confirm we don't mail this person
    // (whose email pref is false) just because we're posting to Slack.
    const slackOnly = await world.createUser("MANAGER", "slack-only");

    await setPrefs(optedIn.id, { notifyEmailEnabled: true, notifySlackEnabled: false });
    await setPrefs(optedOut.id, { notifyEmailEnabled: false, notifySlackEnabled: false });
    await setPrefs(slackOnly.id, { notifyEmailEnabled: false, notifySlackEnabled: true });

    const area = await world.createArea();
    await notifyEscalationCreated(makeEvent(area.id, area.name));

    const emailRecipients = recorder.calls
      .filter((c) => c.url === RESEND_URL)
      .map((c) => (c.body as { to: string }).to);
    assert.deepEqual(
      emailRecipients.sort(),
      [optedIn.email],
      "only the email-opted-in manager should receive an email",
    );
    assert.ok(
      !emailRecipients.includes(optedOut.email),
      "muted manager must not receive email",
    );
    assert.ok(
      !emailRecipients.includes(slackOnly.email),
      "slack-only manager must not receive email",
    );
  });

  test("skips Slack entirely when no manager has notifySlackEnabled = true", async () => {
    const a = await world.createUser("MANAGER", "no-slack-1");
    const b = await world.createUser("MANAGER", "no-slack-2");
    await setPrefs(a.id, { notifyEmailEnabled: true, notifySlackEnabled: false });
    await setPrefs(b.id, { notifyEmailEnabled: true, notifySlackEnabled: false });

    const area = await world.createArea();
    await notifyEscalationCreated(makeEvent(area.id, area.name));

    const slackCalls = recorder.calls.filter((c) => c.url === SLACK_WEBHOOK);
    assert.equal(
      slackCalls.length,
      0,
      "no slack subscriber → webhook must not be hit",
    );
    // Sanity check: email half of the dispatch still fires for both managers
    // — proves the assertion above isn't passing because dispatch silently
    // bailed for some unrelated reason.
    const emailRecipients = recorder.calls
      .filter((c) => c.url === RESEND_URL)
      .map((c) => (c.body as { to: string }).to);
    assert.deepEqual(emailRecipients.sort(), [a.email, b.email].sort());
  });

  test("posts Slack once when at least one manager has notifySlackEnabled = true", async () => {
    const slackUser = await world.createUser("MANAGER", "slack-on");
    const muted = await world.createUser("MANAGER", "muted");
    await setPrefs(slackUser.id, { notifyEmailEnabled: false, notifySlackEnabled: true });
    await setPrefs(muted.id, { notifyEmailEnabled: false, notifySlackEnabled: false });

    const area = await world.createArea();
    await notifyEscalationCreated(makeEvent(area.id, area.name));

    const slackCalls = recorder.calls.filter((c) => c.url === SLACK_WEBHOOK);
    assert.equal(slackCalls.length, 1, "exactly one slack post per dispatch");
    const emailCalls = recorder.calls.filter((c) => c.url === RESEND_URL);
    assert.equal(emailCalls.length, 0, "no email subscribers → no email sent");
  });
});
