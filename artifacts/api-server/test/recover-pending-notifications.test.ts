import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, escalationsTable, submissionsTable } from "@workspace/db";
import { and, inArray, isNull } from "drizzle-orm";
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
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];
    // Make sure no real notification provider is invoked from these tests.
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.RESEND_API_KEY;
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
});

