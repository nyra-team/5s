import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  escalationsTable,
  facilitySettingsTable,
  submissionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { TestWorld, type TestArea, type TestUser } from "./helpers.js";
import {
  type EscalationNotification,
  type RepingContext,
  setRepingNotifierForTesting,
} from "../src/lib/notifications.js";
import {
  getRepingSchedulerHealth,
  resetRepingSchedulerHealthForTesting,
  runMonitoredRepingSweep,
  runRepingSweep,
  startRepingScheduler,
  stopRepingScheduler,
} from "../src/lib/reping-scheduler.js";
import { resolveRepingCadence } from "../src/lib/facility-settings.js";
import { api } from "./helpers.js";

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

  test("reads threshold/cap from facility_settings at sweep time when env is unset", async () => {
    // Clear env so the DB layer wins this test.
    delete process.env.ESCALATION_REPING_THRESHOLD_MINUTES;
    delete process.env.ESCALATION_REPING_MAX_COUNT;

    const operator = await world.createUser("OPERATOR");
    const manager = await world.createUser("MANAGER");
    const area = await world.createArea();

    // Seed an escalation that's 10 min old. With the shipped DEFAULT
    // threshold of 15 min it would NOT fire; once we drop the DB-side
    // threshold to 5 min mid-test, the same escalation must fire on the
    // very next sweep — proving the scheduler reads cadence per-tick
    // rather than caching at boot.
    const id = await seedEscalation({
      area,
      operator,
      ageMinutes: 10,
      status: "OPEN",
    });

    // Pre-condition: with no env and no DB row, the default 15-min
    // threshold means a 10-min-old row is too young.
    const before = await runRepingSweep();
    await Promise.resolve();
    assert.equal(before, 0, "sweep should skip a 10-min-old row at the 15-min default");
    assert.equal((await readRow(id)).repingCount, 0);

    // Manager tunes the cadence at runtime: threshold drops to 5 min,
    // cap stays at the 2-attempt default.
    await db
      .insert(facilitySettingsTable)
      .values({
        id: 1,
        repingThresholdMinutes: 5,
        repingMaxRepings: 1,
        updatedByUserId: manager.id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: facilitySettingsTable.id,
        set: {
          repingThresholdMinutes: 5,
          repingMaxRepings: 1,
          updatedByUserId: manager.id,
          updatedAt: new Date(),
        },
      });

    // The very next sweep should pick up the new threshold without any
    // restart and dispatch reminder #1.
    const fired = await runRepingSweep();
    await Promise.resolve();
    assert.equal(fired, 1, "next sweep must see the DB threshold and dispatch");
    assert.equal((await readRow(id)).repingCount, 1);

    // Cap is now 1 (down from the env-pinned 2 in beforeEach), so a
    // second tick — with the row's lastRepingAt back-dated past the new
    // 5-min threshold — must still be suppressed. We simulate "enough
    // time passed" by passing an explicit `now` 6 minutes in the future.
    const t1 = new Date(Date.now() + 6 * 60_000);
    const second = await runRepingSweep(t1);
    await Promise.resolve();
    assert.equal(second, 0, "DB-side cap of 1 must suppress a second nudge");
    assert.equal((await readRow(id)).repingCount, 1);

    // Cleanup: drop the row so other tests' beforeEach env defaults are
    // the only knob in play. (TestWorld doesn't own the singleton row.)
    await db.delete(facilitySettingsTable).where(eq(facilitySettingsTable.id, 1));
  });

  test("env override beats a DB-side cadence on the next sweep tick", async () => {
    const operator = await world.createUser("OPERATOR");
    const manager = await world.createUser("MANAGER");
    const area = await world.createArea();

    // DB row asks for a generous 60-min threshold. Env (already pinned to
    // 15 min in beforeEach) must win, so a 20-min-old row still fires.
    await db
      .insert(facilitySettingsTable)
      .values({
        id: 1,
        repingThresholdMinutes: 60,
        repingMaxRepings: 0,
        updatedByUserId: manager.id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: facilitySettingsTable.id,
        set: {
          repingThresholdMinutes: 60,
          repingMaxRepings: 0,
          updatedByUserId: manager.id,
          updatedAt: new Date(),
        },
      });

    const id = await seedEscalation({
      area,
      operator,
      ageMinutes: 20,
      status: "OPEN",
    });

    const fired = await runRepingSweep();
    await Promise.resolve();
    assert.equal(fired, 1, "env-pinned 15-min threshold must override the DB's 60");
    assert.equal((await readRow(id)).repingCount, 1);

    await db.delete(facilitySettingsTable).where(eq(facilitySettingsTable.id, 1));
  });

  test("resolveRepingCadence: env > db > default", () => {
    const D = { thresholdMinutes: 15, maxRepings: 2 };
    // All null → default
    assert.deepEqual(
      resolveRepingCadence({
        env: { repingThresholdMinutes: null, repingMaxRepings: null },
        dbRow: { repingThresholdMinutes: null, repingMaxRepings: null },
      }),
      D,
    );
    // DB only
    assert.deepEqual(
      resolveRepingCadence({
        env: { repingThresholdMinutes: null, repingMaxRepings: null },
        dbRow: { repingThresholdMinutes: 7, repingMaxRepings: 4 },
      }),
      { thresholdMinutes: 7, maxRepings: 4 },
    );
    // Env wins over DB
    assert.deepEqual(
      resolveRepingCadence({
        env: { repingThresholdMinutes: 30, repingMaxRepings: 1 },
        dbRow: { repingThresholdMinutes: 7, repingMaxRepings: 4 },
      }),
      { thresholdMinutes: 30, maxRepings: 1 },
    );
    // Independent fall-through: DB sets only one field, default fills the
    // other.
    assert.deepEqual(
      resolveRepingCadence({
        env: { repingThresholdMinutes: null, repingMaxRepings: null },
        dbRow: { repingThresholdMinutes: 9, repingMaxRepings: null },
      }),
      { thresholdMinutes: 9, maxRepings: 2 },
    );
    // Cap=0 from DB is honored (0 is a valid "disable" value, not nullish).
    assert.deepEqual(
      resolveRepingCadence({
        env: { repingThresholdMinutes: null, repingMaxRepings: null },
        dbRow: { repingThresholdMinutes: null, repingMaxRepings: 0 },
      }),
      { thresholdMinutes: 15, maxRepings: 0 },
    );
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

describe("runMonitoredRepingSweep — health + watchdog", () => {
  beforeEach(() => {
    resetRepingSchedulerHealthForTesting();
  });
  afterEach(() => {
    resetRepingSchedulerHealthForTesting();
  });

  test("records start, completion, duration, and dispatched count on success", async () => {
    const dispatched = await runMonitoredRepingSweep({
      stuckThresholdMs: 60_000,
      runner: async () => 7,
    });
    assert.equal(dispatched, 7);

    const h = getRepingSchedulerHealth();
    assert.equal(h.sweepsStarted, 1);
    assert.equal(h.sweepsCompleted, 1);
    assert.equal(h.sweepsFailed, 0);
    assert.equal(h.watchdogWarnings, 0);
    assert.equal(h.lastSweepDispatched, 7);
    assert.notEqual(h.lastSweepStartedAt, null);
    assert.notEqual(h.lastSweepCompletedAt, null);
    assert.equal(h.currentSweepStartedAt, null);
    assert.ok(
      h.lastSweepDurationMs !== null && h.lastSweepDurationMs >= 0,
      "duration should be a non-negative number",
    );
    assert.equal(h.lastSweepError, null);
  });

  test("watchdog flags a stuck sweep but the eventual completion still updates health", async () => {
    // Give the inner runner enough time to overshoot the watchdog threshold,
    // then resolve so the health snapshot reflects a *completed* slow sweep.
    const dispatched = await runMonitoredRepingSweep({
      stuckThresholdMs: 5,
      runner: () =>
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(0), 50);
        }),
    });
    assert.equal(dispatched, 0);

    const h = getRepingSchedulerHealth();
    assert.equal(h.watchdogWarnings, 1, "watchdog must fire once for a stuck sweep");
    assert.equal(h.sweepsStarted, 1);
    assert.equal(h.sweepsCompleted, 1, "the sweep eventually completed");
    assert.equal(h.sweepsFailed, 0);
    assert.ok(
      h.lastSweepDurationMs !== null && h.lastSweepDurationMs >= 5,
      "recorded duration should reflect the slow sweep",
    );
    assert.equal(h.currentSweepStartedAt, null);
  });

  test("a fast sweep does not trip the watchdog", async () => {
    await runMonitoredRepingSweep({
      stuckThresholdMs: 10_000,
      runner: async () => 0,
    });
    const h = getRepingSchedulerHealth();
    assert.equal(h.watchdogWarnings, 0);
    assert.equal(h.sweepsCompleted, 1);
  });

  test("startRepingScheduler skips overlapping ticks and records them in health", async () => {
    // Drive the real interval loop with a deliberately slow injected runner
    // so we can observe overlap accounting end-to-end without involving the
    // real database. We have to override the env BEFORE startRepingScheduler
    // is called because readBootConfig() snapshots it at that moment.
    const ORIGINAL_INTERVAL = process.env.ESCALATION_REPING_CHECK_INTERVAL_MS;
    const ORIGINAL_STUCK = process.env.ESCALATION_REPING_STUCK_THRESHOLD_MS;
    process.env.ESCALATION_REPING_CHECK_INTERVAL_MS = "20";
    // Keep the watchdog quiet for this test — we only care about overlap.
    process.env.ESCALATION_REPING_STUCK_THRESHOLD_MS = "10000";
    let runs = 0;
    try {
      const stop = startRepingScheduler({
        runner: async () => {
          runs += 1;
          // Hang well past the 20ms tick interval so several subsequent
          // ticks must be skipped while this sweep is still running.
          await new Promise<void>((r) => setTimeout(r, 120));
          return 0;
        },
      });
      try {
        // Wait long enough for ~6 ticks to fire while the first sweep is
        // still in flight, guaranteeing at least a couple of overlap skips.
        await new Promise<void>((r) => setTimeout(r, 150));
      } finally {
        stop();
      }
      const h = getRepingSchedulerHealth();
      assert.ok(runs >= 1, "at least one sweep should have started");
      assert.ok(
        h.ticksSkippedByOverlap >= 1,
        `expected at least one tick skipped by overlap, got ${h.ticksSkippedByOverlap}`,
      );
      assert.equal(
        h.sweepsStarted,
        runs,
        "sweepsStarted should match the actual runner invocations",
      );
    } finally {
      stopRepingScheduler();
      if (ORIGINAL_INTERVAL === undefined)
        delete process.env.ESCALATION_REPING_CHECK_INTERVAL_MS;
      else process.env.ESCALATION_REPING_CHECK_INTERVAL_MS = ORIGINAL_INTERVAL;
      if (ORIGINAL_STUCK === undefined)
        delete process.env.ESCALATION_REPING_STUCK_THRESHOLD_MS;
      else process.env.ESCALATION_REPING_STUCK_THRESHOLD_MS = ORIGINAL_STUCK;
    }
  });

  test("stopRepingScheduler clears startedAt so consumers don't see stale liveness", async () => {
    const stop = startRepingScheduler({ runner: async () => 0 });
    assert.notEqual(getRepingSchedulerHealth().startedAt, null);
    stop();
    assert.equal(
      getRepingSchedulerHealth().startedAt,
      null,
      "startedAt should be cleared after stop so the scheduler isn't reported as still running",
    );
  });

  test("GET /internal/reping-health returns the scheduler health snapshot", async () => {
    await runMonitoredRepingSweep({
      stuckThresholdMs: 60_000,
      runner: async () => 3,
    });
    const res = await api<{
      sweepsCompleted: number;
      lastSweepDispatched: number | null;
      lastSweepCompletedAt: string | null;
      watchdogWarnings: number;
    }>(null, "GET", "/api/internal/reping-health");
    assert.equal(res.status, 200);
    assert.equal(res.body.sweepsCompleted, 1);
    assert.equal(res.body.lastSweepDispatched, 3);
    assert.notEqual(res.body.lastSweepCompletedAt, null);
    assert.equal(res.body.watchdogWarnings, 0);
  });

  test("an erroring sweep increments sweepsFailed and records lastSweepError", async () => {
    await assert.rejects(
      runMonitoredRepingSweep({
        stuckThresholdMs: 60_000,
        runner: async () => {
          throw new Error("db blew up");
        },
      }),
      /db blew up/,
    );

    const h = getRepingSchedulerHealth();
    assert.equal(h.sweepsStarted, 1);
    assert.equal(h.sweepsCompleted, 0);
    assert.equal(h.sweepsFailed, 1);
    assert.equal(h.currentSweepStartedAt, null);
    assert.notEqual(h.lastSweepError, null);
    assert.equal(h.lastSweepError?.message, "db blew up");
  });
});
