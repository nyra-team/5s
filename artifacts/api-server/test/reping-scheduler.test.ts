import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, escalationsTable, submissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { TestWorld, type TestArea, type TestUser } from "./helpers.js";
import {
  type EscalationNotification,
  type RepingContext,
  setRepingNotifierForTesting,
} from "../src/lib/notifications.js";
import { runRepingSweep } from "../src/lib/reping-scheduler.js";

interface Recorded {
  payload: EscalationNotification;
  context: RepingContext;
}

/**
 * Install a synchronous recorder in place of the real Slack/Resend dispatch.
 * The async function body has no awaits, so the push happens before
 * `notifyEscalationReping` returns its first microtask — meaning a single
 * `await Promise.resolve()` after `runRepingSweep` is enough to drain the
 * fire-and-forget calls the scheduler issues with `void notifyEscalationReping(...)`.
 */
function installRecorder(): { calls: Recorded[]; restore: () => void } {
  const calls: Recorded[] = [];
  const prev = setRepingNotifierForTesting(async (payload, context) => {
    calls.push({ payload, context });
  });
  return {
    calls,
    restore: () => {
      setRepingNotifierForTesting(prev);
    },
  };
}

/**
 * Insert a submission + escalation pair with a back-dated `created_at` so
 * the scheduler's "older than threshold" predicate is exercised. Operator
 * email comes from the joined users row, so we accept a TestUser to mint
 * the row under.
 */
async function seedEscalation(opts: {
  area: TestArea;
  operator: TestUser;
  ageMinutes: number;
  status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  repingCount?: number;
  lastRepingMinutesAgo?: number | null;
  scorePercent?: number;
}): Promise<number> {
  const now = Date.now();
  const createdAt = new Date(now - opts.ageMinutes * 60_000);
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

  const lastRepingAt =
    opts.lastRepingMinutesAgo == null
      ? null
      : new Date(now - opts.lastRepingMinutesAgo * 60_000);

  const [esc] = await db
    .insert(escalationsTable)
    .values({
      submissionId: sub.id,
      areaId: opts.area.id,
      operatorId: opts.operator.id,
      scoreTotal: 50,
      scorePercent: opts.scorePercent ?? 50,
      failingPillarsJson: ["sort", "set"],
      recommendedActionsJson: ["wipe down M-1", "label bins"],
      status: opts.status ?? "OPEN",
      repingCount: opts.repingCount ?? 0,
      lastRepingAt,
      createdAt,
    })
    .returning({ id: escalationsTable.id });
  return esc.id;
}

async function readRow(id: number) {
  const [row] = await db
    .select({
      status: escalationsTable.status,
      repingCount: escalationsTable.repingCount,
      lastRepingAt: escalationsTable.lastRepingAt,
    })
    .from(escalationsTable)
    .where(eq(escalationsTable.id, id));
  return row;
}

describe("runRepingSweep", () => {
  let world: TestWorld;
  let recorder: ReturnType<typeof installRecorder>;
  // Snapshot env so per-test overrides can't leak.
  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "ESCALATION_REPING_THRESHOLD_MINUTES",
    "ESCALATION_REPING_MAX_COUNT",
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];
    // Pin defaults so a developer with overrides in their shell doesn't
    // silently change the meaning of these tests.
    process.env.ESCALATION_REPING_THRESHOLD_MINUTES = "15";
    process.env.ESCALATION_REPING_MAX_COUNT = "2";
    world = new TestWorld();
    recorder = installRecorder();
  });
  afterEach(async () => {
    recorder.restore();
    await world.cleanup();
    for (const k of ENV_KEYS) {
      if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL_ENV[k];
    }
  });

  test("only OPEN escalations older than the threshold get re-pinged", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    // Recent (5 min old) — under threshold, must be skipped.
    const recentId = await seedEscalation({
      area,
      operator,
      ageMinutes: 5,
      status: "OPEN",
    });
    // Aged (20 min old) and OPEN — the only one that should be re-pinged.
    const agedOpenId = await seedEscalation({
      area,
      operator,
      ageMinutes: 20,
      status: "OPEN",
    });
    // Aged but ACKNOWLEDGED — must be skipped despite being old.
    const ackedId = await seedEscalation({
      area,
      operator,
      ageMinutes: 20,
      status: "ACKNOWLEDGED",
    });
    // Aged but RESOLVED — must be skipped despite being old.
    const resolvedId = await seedEscalation({
      area,
      operator,
      ageMinutes: 20,
      status: "RESOLVED",
    });

    const dispatched = await runRepingSweep();
    // Drain the fire-and-forget notifier microtask the scheduler kicked off.
    await Promise.resolve();

    assert.equal(dispatched, 1, "only the aged OPEN escalation should be re-pinged");
    assert.equal(recorder.calls.length, 1);
    assert.equal(recorder.calls[0].payload.escalationId, agedOpenId);
    assert.equal(recorder.calls[0].context.attempt, 1);
    assert.equal(recorder.calls[0].context.maxAttempts, 2);

    // Side-effect on disk: only the aged OPEN row got its counter bumped.
    assert.equal((await readRow(agedOpenId)).repingCount, 1);
    assert.equal((await readRow(recentId)).repingCount, 0);
    assert.equal((await readRow(ackedId)).repingCount, 0);
    assert.equal((await readRow(resolvedId)).repingCount, 0);
  });

  test("respects ESCALATION_REPING_MAX_COUNT (no third attempt after the cap)", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();
    // Old enough that every sweep tick below has it past the threshold.
    const id = await seedEscalation({
      area,
      operator,
      ageMinutes: 60,
      status: "OPEN",
    });

    // Three sweep ticks at increasing virtual times so `lastRepingAt` is
    // always older than the 15-minute threshold relative to `now`.
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + 16 * 60_000);
    const t2 = new Date(t0.getTime() + 32 * 60_000);

    const d0 = await runRepingSweep(t0);
    const d1 = await runRepingSweep(t1);
    const d2 = await runRepingSweep(t2);
    await Promise.resolve();

    assert.equal(d0, 1, "first sweep dispatches reminder #1");
    assert.equal(d1, 1, "second sweep dispatches reminder #2 (the cap)");
    assert.equal(d2, 0, "third sweep is suppressed by the cap");
    assert.equal(recorder.calls.length, 2);
    assert.deepEqual(
      recorder.calls.map((c) => c.context.attempt),
      [1, 2],
    );
    assert.equal((await readRow(id)).repingCount, 2);
  });

  test("acknowledging an escalation between sweeps silences future re-pings", async () => {
    const operator = await world.createUser("OPERATOR");
    const manager = await world.createUser("MANAGER");
    const area = await world.createArea();
    const id = await seedEscalation({
      area,
      operator,
      ageMinutes: 60,
      status: "OPEN",
    });

    const t0 = new Date();
    const t1 = new Date(t0.getTime() + 16 * 60_000);

    const d0 = await runRepingSweep(t0);
    assert.equal(d0, 1, "first sweep dispatches one reminder");
    assert.equal((await readRow(id)).repingCount, 1);

    // Manager acknowledges between sweeps. We update the row directly
    // rather than going through the HTTP route so the test stays focused
    // on the scheduler invariant.
    await db
      .update(escalationsTable)
      .set({ status: "ACKNOWLEDGED", ackedByUserId: manager.id, ackedAt: new Date() })
      .where(eq(escalationsTable.id, id));

    const d1 = await runRepingSweep(t1);
    await Promise.resolve();
    assert.equal(d1, 0, "ACKNOWLEDGED escalation must not be re-pinged");
    assert.equal(recorder.calls.length, 1, "no second notification fired");

    // Same check for RESOLVED — flip status, advance time, sweep, expect zero.
    await db
      .update(escalationsTable)
      .set({ status: "RESOLVED", resolvedByUserId: manager.id, resolvedAt: new Date() })
      .where(eq(escalationsTable.id, id));
    const t2 = new Date(t0.getTime() + 32 * 60_000);
    const d2 = await runRepingSweep(t2);
    await Promise.resolve();
    assert.equal(d2, 0, "RESOLVED escalation must not be re-pinged");
    assert.equal(recorder.calls.length, 1);
  });

  test("guarded UPDATE prevents double-sends when two sweeps race", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();
    const id = await seedEscalation({
      area,
      operator,
      ageMinutes: 30,
      status: "OPEN",
    });

    // Two sweeps fired concurrently — each will SELECT the candidate with
    // reping_count = 0, then race to claim it via
    //   UPDATE ... WHERE reping_count = 0
    // Postgres serializes the writes; the second UPDATE sees reping_count
    // is no longer 0 and returns 0 affected rows, so its dispatch is
    // skipped. Net effect: exactly one notification, exactly one increment.
    const [a, b] = await Promise.all([runRepingSweep(), runRepingSweep()]);
    await Promise.resolve();

    assert.equal(a + b, 1, "exactly one of the two parallel sweeps may dispatch");
    assert.equal(recorder.calls.length, 1, "only one notification was sent");
    assert.equal(
      (await readRow(id)).repingCount,
      1,
      "reping_count incremented exactly once despite two racing sweeps",
    );
  });
});
