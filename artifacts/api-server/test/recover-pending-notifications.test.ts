import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, escalationsTable, submissionsTable, usersTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { TestWorld, type TestArea, type TestUser } from "./helpers.js";
import { recoverPendingEscalationNotifications } from "../src/lib/notifications.js";

/**
 * Insert a submission + escalation pair with `notified_at = NULL` so the
 * startup recovery sweep treats it as a candidate. We back-date `created_at`
 * by `ageMinutes` so the row is strictly before `bootCutoff` (the sweep
 * filters those out to avoid racing the live in-memory pipeline).
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

describe("recoverPendingEscalationNotifications", () => {
  let world: TestWorld;
  // Snapshot env so per-test overrides can't leak across tests.
  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS",
    "SLACK_WEBHOOK_URL",
    "RESEND_API_KEY",
    "NOTIFICATION_FROM_EMAIL",
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];
    // Make sure no real notification provider is invoked from these tests.
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFICATION_FROM_EMAIL;
    // Generous recovery window so back-dated rows aren't classified "too old".
    process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS = String(
      24 * 60 * 60 * 1000,
    );
    world = new TestWorld();
  });
  afterEach(async () => {
    await world.cleanup();
    for (const k of ENV_KEYS) {
      if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL_ENV[k];
    }
  });

  test("two concurrent recovery sweeps each dispatch every escalation exactly once", async () => {
    // The original race: two API processes boot at the same time, both run
    // the recovery sweep, both SELECT the same rows where notified_at IS NULL,
    // both dispatch — managers receive every alert twice. The atomic
    //   UPDATE ... WHERE notified_at IS NULL RETURNING id
    // claim splits ownership across the two processes so the union of their
    // dispatches equals every row exactly once.
    const operator = await world.createUser("OPERATOR");
    const area1 = await world.createArea("Cell A");
    const area2 = await world.createArea("Cell B");

    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        await seedUnnotifiedEscalation({
          area: i % 2 === 0 ? area1 : area2,
          operator,
        }),
      );
    }

    // Sanity check: every seeded row starts with notified_at NULL so both
    // sweeps would otherwise race for them.
    const beforeNull = await db
      .select({ id: escalationsTable.id })
      .from(escalationsTable)
      .where(
        and(
          inArray(escalationsTable.id, ids),
          isNull(escalationsTable.notifiedAt),
        ),
      );
    assert.equal(beforeNull.length, ids.length, "seeded rows must start unnotified");

    const [a, b] = await Promise.all([
      recoverPendingEscalationNotifications(),
      recoverPendingEscalationNotifications(),
    ]);

    // Each row must be claimed by exactly one of the two processes — the sum
    // of the two `claimed` counters equals the number of seeded rows.
    assert.equal(
      a.claimed + b.claimed,
      ids.length,
      "every escalation must be claimed exactly once across the two sweeps",
    );
    assert.equal(
      a.dispatchAttempted + b.dispatchAttempted,
      ids.length,
      "every escalation must be dispatched exactly once across the two sweeps",
    );
    assert.equal(
      a.dispatchFailures + b.dispatchFailures,
      0,
      "no provider exceptions in the no-Slack/no-email test setup",
    );
    assert.equal(
      a.skippedTooOld + b.skippedTooOld,
      0,
      "no rows should be classified as too old in this test",
    );

    // And after the dust settles, every row has notified_at stamped — no
    // future sweep can revive them.
    const stillUnnotified = await db
      .select({ id: escalationsTable.id })
      .from(escalationsTable)
      .where(
        and(
          inArray(escalationsTable.id, ids),
          isNull(escalationsTable.notifiedAt),
        ),
      );
    assert.equal(
      stillUnnotified.length,
      0,
      "no escalation may be left with notified_at = NULL",
    );
  });

  test("a second sweep right after the first finds nothing to do", async () => {
    // Once the first sweep claims the rows, a sequential second sweep (e.g.
    // a third process booting moments later) must see zero candidates.
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea("Cell C");
    const ids = [
      await seedUnnotifiedEscalation({ area, operator }),
      await seedUnnotifiedEscalation({ area, operator }),
    ];

    const first = await recoverPendingEscalationNotifications();
    assert.equal(first.claimed, ids.length);
    assert.equal(first.dispatchAttempted, ids.length);

    const second = await recoverPendingEscalationNotifications();
    assert.equal(second.claimed, 0, "no rows left to claim on the second pass");
    assert.equal(second.dispatchAttempted, 0);

    // Confirm the rows remain stamped (the second sweep didn't accidentally
    // un-stamp anything).
    const rows = await db
      .select({
        id: escalationsTable.id,
        notifiedAt: escalationsTable.notifiedAt,
      })
      .from(escalationsTable)
      .where(inArray(escalationsTable.id, ids));
    for (const r of rows) {
      assert.notEqual(r.notifiedAt, null, `escalation ${r.id} must remain stamped`);
    }
  });

  test("a transient Slack/email outage during recovery is retried on the next sweep", async () => {
    // The bug we're closing: the atomic-claim recovery sweep stamps
    // notified_at BEFORE attempting Slack/email dispatch. On its own this
    // would mean a transient provider outage during a deploy silently loses
    // the alert — the row is stamped, so the next restart's sweep won't pick
    // it up either. With provider-failure retry enabled, the recovery sweep
    // un-stamps notified_at when no provider succeeds, so a follow-up sweep
    // (next deploy / next scheduled tick) actually delivers the alert.
    //
    // We exercise the full path by:
    //   1. Configuring both providers (Slack webhook + Resend) so dispatch
    //      actually attempts a real `fetch`.
    //   2. Stubbing global fetch to fail every notification request (Slack
    //      and Resend both return 503). Database calls go through `pg` over
    //      TCP, not fetch, so they're unaffected.
    //   3. Running recovery once — it should claim the row, fail dispatch,
    //      and clear notified_at back to NULL.
    //   4. Restoring fetch to succeed, running recovery again, and asserting
    //      the row is now stamped DELIVERED. This is the proof the alert
    //      survives a transient outage instead of being silently swallowed.
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test/recovery-retry";
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.NOTIFICATION_FROM_EMAIL = "alerts@5s.test";

    // A manager has to exist with email notifications on so the dispatch
    // path actually fans out to a recipient (defaults: notifyEmailEnabled
    // true, notifySlackEnabled false). Slack is still attempted because the
    // webhook env var is set, but it's only sent if at least one manager
    // opted in to Slack — so this test intentionally exercises the email
    // failure path. We add a Slack-subscribing manager too to cover both.
    const manager = await world.createUser("MANAGER", "mgr-recovery-retry");
    // Bump the manager to also receive Slack so both providers are exercised.
    await db
      .update(usersTable)
      .set({ notifySlackEnabled: true })
      .where(eq(usersTable.id, manager.id));

    const operator = await world.createUser("OPERATOR", "op-recovery-retry");
    const area = await world.createArea("Cell-recovery-retry");
    const escalationId = await seedUnnotifiedEscalation({ area, operator });

    // Sanity: row starts unnotified.
    const beforeFirst = await db
      .select({ notifiedAt: escalationsTable.notifiedAt })
      .from(escalationsTable)
      .where(eq(escalationsTable.id, escalationId));
    assert.equal(beforeFirst[0]?.notifiedAt, null, "row must start unnotified");

    // --- First sweep: providers down. ---
    const originalFetch = globalThis.fetch;
    let failingFetchCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      // Only intercept notification requests; nothing else in this test
      // path uses fetch, but be explicit so a future change doesn't
      // accidentally suffocate an unrelated call.
      if (url.startsWith("https://hooks.slack.test/") || url.startsWith("https://api.resend.com/")) {
        failingFetchCalls += 1;
        return new Response("upstream is down", { status: 503 });
      }
      return originalFetch(input as RequestInfo, _init);
    }) as typeof fetch;

    let firstResult;
    try {
      firstResult = await recoverPendingEscalationNotifications();
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(firstResult.claimed, 1, "first sweep should claim the row");
    assert.equal(firstResult.dispatchAttempted, 1, "first sweep should attempt dispatch");
    assert.equal(
      firstResult.dispatchRetried,
      1,
      "failed dispatch must be re-queued so the next sweep retries",
    );
    assert.ok(failingFetchCalls > 0, "stubbed fetch should have been invoked");

    const afterFirst = await db
      .select({
        notifiedAt: escalationsTable.notifiedAt,
        notifyDeliveryStatus: escalationsTable.notifyDeliveryStatus,
      })
      .from(escalationsTable)
      .where(eq(escalationsTable.id, escalationId));
    assert.equal(
      afterFirst[0]?.notifiedAt,
      null,
      "notified_at must be cleared so the next recovery sweep picks the row up",
    );
    assert.equal(
      afterFirst[0]?.notifyDeliveryStatus,
      null,
      "delivery status must be cleared too — the alert hasn't actually been delivered",
    );

    // --- Second sweep: providers recovered. ---
    let succeedingFetchCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://hooks.slack.test/") || url.startsWith("https://api.resend.com/")) {
        succeedingFetchCalls += 1;
        return new Response("ok", { status: 200 });
      }
      return originalFetch(input as RequestInfo, _init);
    }) as typeof fetch;

    let secondResult;
    try {
      secondResult = await recoverPendingEscalationNotifications();
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(
      secondResult.claimed,
      1,
      "the re-queued row must be re-claimed by the second sweep",
    );
    assert.equal(secondResult.dispatchAttempted, 1, "second sweep should attempt dispatch");
    assert.equal(
      secondResult.dispatchRetried,
      0,
      "no further retries needed — providers are healthy now",
    );
    assert.equal(secondResult.dispatchFailures, 0, "no unexpected dispatch exceptions");
    assert.ok(
      succeedingFetchCalls > 0,
      "providers should have been re-attempted on the second sweep",
    );

    const afterSecond = await db
      .select({
        notifiedAt: escalationsTable.notifiedAt,
        notifyDeliveryStatus: escalationsTable.notifyDeliveryStatus,
      })
      .from(escalationsTable)
      .where(eq(escalationsTable.id, escalationId));
    assert.notEqual(
      afterSecond[0]?.notifiedAt,
      null,
      "after a successful recovery dispatch, notified_at must be stamped",
    );
    assert.equal(
      afterSecond[0]?.notifyDeliveryStatus,
      "DELIVERED",
      "successful recovery dispatch must record DELIVERED so the manager UI is honest",
    );
  });
});

