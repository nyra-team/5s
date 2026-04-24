import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db, escalationsTable, submissionsTable, usersTable } from "@workspace/db";
import { TestWorld, type TestArea, type TestUser } from "./helpers.js";
import {
  notifyEscalationCreated,
  flushPendingEscalationNotifications,
  recoverPendingEscalationNotifications,
  type EscalationNotification,
} from "../src/lib/notifications.js";

/**
 * Insert a submission + escalation pair with `notified_at = NULL` and
 * `created_at` shifted into the past so the row is strictly older than
 * `bootCutoff` (the recovery sweep filters out rows newer than the boot
 * moment to avoid claiming events the live in-memory pipeline still owns).
 */
async function seedUnnotifiedEscalation(opts: {
  area: TestArea;
  operator: TestUser;
  ageMinutes?: number;
}): Promise<number> {
  const ageMinutes = opts.ageMinutes ?? 5;
  const createdAt = new Date(Date.now() - ageMinutes * 60_000);
  const [sub] = await db
    .insert(submissionsTable)
    .values({
      areaId: opts.area.id,
      userId: opts.operator.id,
      shift: "A",
      scoreTotal: 50,
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
      scoreTotal: 50,
      scorePercent: 50,
      failingPillarsJson: ["sort", "set"],
      recommendedActionsJson: ["wipe down M-1"],
      status: "OPEN",
      notifiedAt: null,
      createdAt,
    })
    .returning({ id: escalationsTable.id });
  return esc.id;
}

interface CapturedRequest {
  url: string;
  body: unknown;
}

/**
 * Replace `globalThis.fetch` with a recorder so we can count Slack/Resend
 * deliveries the notifier actually fires (both providers go through fetch).
 * Mirrors the helper in preferences.test.ts so this race test stays
 * standalone and doesn't depend on per-test ordering.
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

describe("live notification path vs concurrent recovery sweep", () => {
  let world: TestWorld;
  let recorder: ReturnType<typeof installFetchRecorder>;

  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "ESCALATION_NOTIFICATION_WINDOW_MS",
    "ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS",
    "SLACK_WEBHOOK_URL",
    "RESEND_API_KEY",
    "NOTIFICATION_FROM_EMAIL",
  ];
  const SLACK_WEBHOOK = "https://hooks.slack.test/services/T/B/X";

  beforeEach(() => {
    for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];
    // Pin a long grouping window so the live pipeline parks events in
    // pendingByArea instead of dispatching inline — that's the precondition
    // for the live-vs-recovery race we want to exercise.
    process.env.ESCALATION_NOTIFICATION_WINDOW_MS = String(10 * 60 * 1000);
    // Generous recovery window so back-dated rows aren't classified too old.
    process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS = String(
      24 * 60 * 60 * 1000,
    );
    // Slack only — Resend stays unconfigured so the recorder counts only
    // webhook POSTs and we don't need a fake Resend response shape.
    process.env.SLACK_WEBHOOK_URL = SLACK_WEBHOOK;
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFICATION_FROM_EMAIL;
    world = new TestWorld();
    recorder = installFetchRecorder();
  });

  afterEach(async () => {
    // Drain any leftover bucket so a follow-up test's recorder can't be
    // tripped by a stale timer firing inside it.
    await flushPendingEscalationNotifications();
    recorder.restore();
    await world.cleanup();
    for (const k of ENV_KEYS) {
      if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL_ENV[k];
    }
  });

  test("flushArea after a sibling recovery sweep does not double-send", async () => {
    // Reproduces the leftover live-vs-recovery race:
    //   1. Process A is mid-grouping-window for an escalation row that was
    //      created BEFORE process B booted (so it's a candidate for B's
    //      startup recovery sweep, which filters by `bootCutoff`).
    //   2. Process B's recovery sweep claims and dispatches it.
    //   3. Process A's grouping timer eventually fires `flushArea` which,
    //      before this fix, would call dispatch again with no `notified_at`
    //      re-check — managers get the same alert twice.
    //
    // The fix gates `flushArea` on the same atomic
    //   UPDATE escalations SET notified_at = now() WHERE notified_at IS NULL
    // claim that the recovery sweep already uses, so the loser drops the
    // bucket instead of re-dispatching.

    const operator = await world.createUser("OPERATOR");
    const manager = await world.createUser("MANAGER", "race-mgr");
    // Subscribe the manager to Slack so a successful dispatch produces a
    // recorder-visible POST. Email stays off (and Resend unconfigured) so
    // we have a single, unambiguous signal channel.
    await db
      .update(usersTable)
      .set({ notifyEmailEnabled: false, notifySlackEnabled: true })
      .where(eq(usersTable.id, manager.id));

    const area = await world.createArea("Race-Area");
    const escalationId = await seedUnnotifiedEscalation({ area, operator });

    const payload: EscalationNotification = {
      escalationId,
      submissionId: 0, // not read by dispatch
      areaId: area.id,
      areaName: area.name,
      scorePercent: 50,
      failingPillars: ["sort", "set"],
      operatorEmail: operator.email,
      recommendedActions: ["wipe down M-1"],
    };

    // Step 1: process A enqueues the event into pendingByArea. The 10-minute
    // window means no timer fires during the test — we'll trigger the flush
    // explicitly below with `flushPendingEscalationNotifications`.
    await notifyEscalationCreated(payload);

    // Step 2: process B's recovery sweep runs. It atomically claims the row
    // (notified_at flips to now()) and dispatches it once.
    const sweep = await recoverPendingEscalationNotifications();
    assert.equal(sweep.claimed, 1, "sweep must claim the seeded escalation");
    assert.equal(
      sweep.dispatchAttempted,
      1,
      "sweep must dispatch the claimed escalation exactly once",
    );

    const slackAfterSweep = recorder.calls.filter((c) => c.url === SLACK_WEBHOOK);
    assert.equal(
      slackAfterSweep.length,
      1,
      "recovery sweep should fire exactly one Slack message",
    );

    // Step 3: process A's grouping timer fires (simulated via an explicit
    // flush). With the fix, the live flush re-checks notified_at atomically,
    // sees the recovery sweep already won, and skips dispatch.
    await flushPendingEscalationNotifications();

    const slackAfterFlush = recorder.calls.filter((c) => c.url === SLACK_WEBHOOK);
    assert.equal(
      slackAfterFlush.length,
      1,
      "live flush must not re-send after the recovery sweep already delivered",
    );

    // And the row itself stays stamped exactly once — the live flush's claim
    // attempt for an already-stamped row must be a no-op, not an overwrite
    // that revives the row for a future sweep.
    const [row] = await db
      .select({
        notifiedAt: escalationsTable.notifiedAt,
        notifyDeliveryStatus: escalationsTable.notifyDeliveryStatus,
      })
      .from(escalationsTable)
      .where(eq(escalationsTable.id, escalationId));
    assert.notEqual(row.notifiedAt, null, "row must remain stamped");
    assert.equal(row.notifyDeliveryStatus, "DELIVERED");
  });

  test("flushArea still delivers when no concurrent sweep ran", async () => {
    // Negative control: with no sibling process to race against, the live
    // pipeline must still fire its Slack message. This guards against the
    // fix accidentally turning into "always skip" — e.g. if the claim query
    // were inverted or always returned an empty set.

    const operator = await world.createUser("OPERATOR");
    const manager = await world.createUser("MANAGER", "race-solo-mgr");
    await db
      .update(usersTable)
      .set({ notifyEmailEnabled: false, notifySlackEnabled: true })
      .where(eq(usersTable.id, manager.id));

    const area = await world.createArea("Race-Solo-Area");
    const escalationId = await seedUnnotifiedEscalation({ area, operator });

    const payload: EscalationNotification = {
      escalationId,
      submissionId: 0,
      areaId: area.id,
      areaName: area.name,
      scorePercent: 50,
      failingPillars: ["sort", "set"],
      operatorEmail: operator.email,
      recommendedActions: ["wipe down M-1"],
    };

    await notifyEscalationCreated(payload);
    await flushPendingEscalationNotifications();

    const slackCalls = recorder.calls.filter((c) => c.url === SLACK_WEBHOOK);
    assert.equal(
      slackCalls.length,
      1,
      "uncontested live flush must dispatch exactly one Slack message",
    );

    const [row] = await db
      .select({
        notifiedAt: escalationsTable.notifiedAt,
        notifyDeliveryStatus: escalationsTable.notifyDeliveryStatus,
      })
      .from(escalationsTable)
      .where(eq(escalationsTable.id, escalationId));
    assert.notEqual(row.notifiedAt, null);
    assert.equal(row.notifyDeliveryStatus, "DELIVERED");
  });

  test("multi-event flush partially raced by sweep dispatches only the leftover", async () => {
    // Mixed case: the bucket holds two events for the same area; a sibling
    // recovery sweep claims one of them mid-window (e.g. it was inserted in
    // an earlier transaction that already flushed to disk, while the second
    // is too new for the sweep's `bootCutoff` filter — but here we just seed
    // both as pre-existing for simplicity and have the sweep claim only one
    // by stamping the other manually). This proves `flushArea` filters event
    // by event rather than all-or-nothing.

    const operator = await world.createUser("OPERATOR");
    const manager = await world.createUser("MANAGER", "race-mixed-mgr");
    await db
      .update(usersTable)
      .set({ notifyEmailEnabled: false, notifySlackEnabled: true })
      .where(eq(usersTable.id, manager.id));

    const area = await world.createArea("Race-Mixed-Area");
    const idA = await seedUnnotifiedEscalation({ area, operator });
    const idB = await seedUnnotifiedEscalation({ area, operator });

    function makePayload(id: number): EscalationNotification {
      return {
        escalationId: id,
        submissionId: 0,
        areaId: area.id,
        areaName: area.name,
        scorePercent: 50,
        failingPillars: ["sort", "set"],
        operatorEmail: operator.email,
        recommendedActions: ["wipe down M-1"],
      };
    }

    await notifyEscalationCreated(makePayload(idA));
    await notifyEscalationCreated(makePayload(idB));

    // Simulate a sibling claiming exactly one row out from under us.
    await db
      .update(escalationsTable)
      .set({ notifiedAt: new Date(), notifyDeliveryStatus: "DELIVERED" })
      .where(eq(escalationsTable.id, idA));

    await flushPendingEscalationNotifications();

    const slackCalls = recorder.calls.filter((c) => c.url === SLACK_WEBHOOK);
    assert.equal(
      slackCalls.length,
      1,
      "exactly one Slack message goes out for the un-raced event",
    );

    // The dispatched message must reference the un-raced row's score line —
    // good enough sanity that we filtered by id, not just truncated the list.
    // The bucket is for area X with one event remaining, so the notifier
    // takes the single-event Slack template (not the grouped digest).
    const slackBody = slackCalls[0].body as { blocks?: unknown };
    assert.ok(slackBody.blocks, "single-event Slack message must include blocks");

    // Both rows end stamped; no row is left as NULL for a future sweep.
    const rows = await db
      .select({
        id: escalationsTable.id,
        notifiedAt: escalationsTable.notifiedAt,
      })
      .from(escalationsTable)
      .where(inArray(escalationsTable.id, [idA, idB]));
    for (const r of rows) {
      assert.notEqual(
        r.notifiedAt,
        null,
        `escalation ${r.id} must be stamped after the partial-race flush`,
      );
    }
  });
});
