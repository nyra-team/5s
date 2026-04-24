import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  submissionsTable,
  escalationsTable,
} from "@workspace/db";
import { TestWorld, type TestArea, type TestUser, api } from "./helpers.js";
import {
  notifyEscalationCreated,
  flushPendingEscalationNotifications,
  type EscalationNotification,
} from "../src/lib/notifications.js";

interface AuditEntry {
  id: number;
  changedAt: string;
  changedByUserId: number | null;
  changedByUserEmail: string | null;
  field: string;
  oldValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
}

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
  lastChangedAt: string | null;
  lastChangedByUserId: number | null;
  lastChangedByUserEmail: string | null;
  auditHistory: AuditEntry[];
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

describe("notification-preferences audit trail", () => {
  let world: TestWorld;
  beforeEach(() => {
    world = new TestWorld();
  });
  afterEach(async () => {
    await world.cleanup();
  });

  test("returns an empty audit history and null lastChange for a brand-new manager", async () => {
    const manager = await world.createUser("MANAGER", "audit-empty");
    const r = await api<PreferencesShape>(
      manager.token,
      "GET",
      "/api/me/notification-preferences",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.auditHistory, []);
    assert.equal(r.body.lastChangedAt, null);
    assert.equal(r.body.lastChangedByUserId, null);
    assert.equal(r.body.lastChangedByUserEmail, null);
  });

  test("emits one audit row per field that actually moved on a single PUT", async () => {
    const manager = await world.createUser("MANAGER", "audit-multi");
    // Defaults: email on, slack off → flipping both produces two entries.
    const r = await api<PreferencesShape>(
      manager.token,
      "PUT",
      "/api/me/notification-preferences",
      { notifyEmailEnabled: false, notifySlackEnabled: true },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.auditHistory.length, 2);
    const fields = r.body.auditHistory.map((e) => e.field).sort();
    assert.deepEqual(fields, ["notifyEmailEnabled", "notifySlackEnabled"]);
    for (const entry of r.body.auditHistory) {
      assert.equal(entry.changedByUserId, manager.id);
      assert.equal(entry.changedByUserEmail, manager.email);
      if (entry.field === "notifyEmailEnabled") {
        assert.equal(entry.oldValue, true);
        assert.equal(entry.newValue, false);
      } else {
        assert.equal(entry.oldValue, false);
        assert.equal(entry.newValue, true);
      }
    }
    // Last-change attribution lines up with the most recent row.
    assert.equal(r.body.lastChangedByUserId, manager.id);
    assert.equal(r.body.lastChangedByUserEmail, manager.email);
    assert.ok(r.body.lastChangedAt);
  });

  test("does not emit audit rows when a no-op patch is sent", async () => {
    const manager = await world.createUser("MANAGER", "audit-noop");
    // Set a value once...
    await api<PreferencesShape>(
      manager.token,
      "PUT",
      "/api/me/notification-preferences",
      { notifySlackEnabled: true },
    );
    // ...then "save" the exact same value: history must stay at length 1.
    const noop = await api<PreferencesShape>(
      manager.token,
      "PUT",
      "/api/me/notification-preferences",
      { notifySlackEnabled: true },
    );
    assert.equal(noop.body.auditHistory.length, 1);
  });

  test("orders history newest-first and caps it at 5 entries", async () => {
    const manager = await world.createUser("MANAGER", "audit-cap");
    // Six distinct mask values produces six audit rows; we expect the GET
    // payload to surface only the most recent five, newest first.
    const masks = [1, 3, 7, 15, 31, 63];
    for (const m of masks) {
      await api<PreferencesShape>(
        manager.token,
        "PUT",
        "/api/me/notification-preferences",
        { quietHoursWeekdayMask: m },
      );
    }
    const r = await api<PreferencesShape>(
      manager.token,
      "GET",
      "/api/me/notification-preferences",
    );
    assert.equal(r.body.auditHistory.length, 5);
    const newValues = r.body.auditHistory.map((e) => e.newValue);
    // Newest-first: dropping the very first mask (1) we wrote.
    assert.deepEqual(newValues, [63, 31, 15, 7, 3]);
  });

  test("ignores invalid values without leaving an audit trail for them", async () => {
    const manager = await world.createUser("MANAGER", "audit-invalid");
    // Wrong primitive type → should be silently dropped per the route's
    // permissive contract; mixed with one valid sibling.
    const r = await api<PreferencesShape>(
      manager.token,
      "PUT",
      "/api/me/notification-preferences",
      { notifySlackEnabled: "yes", quietHoursWeekdayMask: 31 },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.auditHistory.length, 1);
    assert.equal(r.body.auditHistory[0].field, "quietHoursWeekdayMask");
    assert.equal(r.body.auditHistory[0].newValue, 31);
  });

  test("captures string and boolean transitions side-by-side", async () => {
    const manager = await world.createUser("MANAGER", "audit-strings");
    const r = await api<PreferencesShape>(
      manager.token,
      "PUT",
      "/api/me/notification-preferences",
      { quietHoursEnabled: true, quietHoursStart: "23:30", quietHoursEnd: "06:15" },
    );
    assert.equal(r.status, 200);
    // Exactly the three audited fields produced rows.
    const byField = new Map(r.body.auditHistory.map((e) => [e.field, e]));
    assert.equal(byField.size, 3);
    assert.deepEqual(
      [
        byField.get("quietHoursEnabled")?.newValue,
        byField.get("quietHoursStart")?.newValue,
        byField.get("quietHoursEnd")?.newValue,
      ],
      [true, "23:30", "06:15"],
    );
    // Defaults pre-write: enabled=false, start="22:00", end="07:00".
    assert.deepEqual(
      [
        byField.get("quietHoursEnabled")?.oldValue,
        byField.get("quietHoursStart")?.oldValue,
        byField.get("quietHoursEnd")?.oldValue,
      ],
      [false, "22:00", "07:00"],
    );
  });

  test("isolates each manager's history (subjectId scoping)", async () => {
    // Two managers writing simultaneously: each only sees their own audit
    // entries, proving the (scope, subjectId) filter is honoured.
    const a = await world.createUser("MANAGER", "audit-iso-a");
    const b = await world.createUser("MANAGER", "audit-iso-b");
    await api<PreferencesShape>(a.token, "PUT", "/api/me/notification-preferences", {
      notifySlackEnabled: true,
    });
    await api<PreferencesShape>(b.token, "PUT", "/api/me/notification-preferences", {
      quietHoursWeekdayMask: 63,
    });

    const aGet = await api<PreferencesShape>(
      a.token,
      "GET",
      "/api/me/notification-preferences",
    );
    const bGet = await api<PreferencesShape>(
      b.token,
      "GET",
      "/api/me/notification-preferences",
    );
    assert.equal(aGet.body.auditHistory.length, 1);
    assert.equal(aGet.body.auditHistory[0].field, "notifySlackEnabled");
    assert.equal(aGet.body.auditHistory[0].changedByUserId, a.id);
    assert.equal(bGet.body.auditHistory.length, 1);
    assert.equal(bGet.body.auditHistory[0].field, "quietHoursWeekdayMask");
    assert.equal(bGet.body.auditHistory[0].changedByUserId, b.id);
  });

  test("preserves the history row but nulls the actor when the user is deleted", async () => {
    // Mimic a deactivated manager: write a change, then delete the user
    // row. The audit entry must survive (with null actor + null email)
    // because the FK uses ON DELETE SET NULL.
    const manager = await world.createUser("MANAGER", "audit-delete");
    await api<PreferencesShape>(
      manager.token,
      "PUT",
      "/api/me/notification-preferences",
      { notifySlackEnabled: true },
    );

    // Make a second manager who will read back the same subjectId's history
    // via a direct DB-backed query (we can't GET another user's prefs over
    // the API). For that we use the helper's underlying table contents
    // instead — see the assertion below.
    const { settingsAuditTable } = await import("@workspace/db");
    await db.delete(usersTable).where(eq(usersTable.id, manager.id));
    // Drop from the world tracker so cleanup() doesn't double-delete.
    world.userIds = world.userIds.filter((id) => id !== manager.id);

    const rows = await db
      .select()
      .from(settingsAuditTable)
      .where(eq(settingsAuditTable.subjectId, manager.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changedByUserId, null, "actor should be nulled out");
    assert.equal(rows[0].field, "notifySlackEnabled");
    assert.equal(rows[0].newValue, JSON.stringify(true));

    // Tidy: drop the orphan audit row so the next run starts clean.
    await db.delete(settingsAuditTable).where(eq(settingsAuditTable.subjectId, manager.id));
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

  // The live notifier now atomically claims escalations before dispatching
  // (UPDATE ... WHERE notified_at IS NULL RETURNING id) to defeat the
  // live-vs-recovery race, so we need a real row in the DB — a dangling
  // escalationId is filtered out by the claim and dispatch is skipped. We
  // also need a real operator + submission to satisfy the FKs.
  async function seedEvent(opts: {
    area: TestArea;
    operator: TestUser;
  }): Promise<EscalationNotification> {
    const [sub] = await db
      .insert(submissionsTable)
      .values({
        areaId: opts.area.id,
        userId: opts.operator.id,
        shift: "A",
        scoreTotal: 41,
        scoreJson: { sort: 1, set: 1, shine: 1, standardize: 1, sustain: 1 },
        suggestionsJson: [],
        imageUrl: "https://example.test/img.jpg",
      })
      .returning({ id: submissionsTable.id });
    const [esc] = await db
      .insert(escalationsTable)
      .values({
        submissionId: sub.id,
        areaId: opts.area.id,
        operatorId: opts.operator.id,
        scoreTotal: 41,
        scorePercent: 41,
        failingPillarsJson: ["sort", "set"],
        recommendedActionsJson: ["wipe down M-1"],
        status: "OPEN",
        notifiedAt: null,
      })
      .returning({ id: escalationsTable.id });
    return {
      escalationId: esc.id,
      submissionId: sub.id,
      areaId: opts.area.id,
      areaName: opts.area.name,
      scorePercent: 41,
      failingPillars: ["sort", "set"],
      operatorEmail: opts.operator.email,
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

    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();
    await notifyEscalationCreated(await seedEvent({ area, operator }));

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

    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();
    await notifyEscalationCreated(await seedEvent({ area, operator }));

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

    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();
    await notifyEscalationCreated(await seedEvent({ area, operator }));

    const slackCalls = recorder.calls.filter((c) => c.url === SLACK_WEBHOOK);
    assert.equal(slackCalls.length, 1, "exactly one slack post per dispatch");
    const emailCalls = recorder.calls.filter((c) => c.url === RESEND_URL);
    assert.equal(emailCalls.length, 0, "no email subscribers → no email sent");
  });
});
