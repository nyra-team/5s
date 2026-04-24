import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, submissionsTable } from "@workspace/db";
import { TestWorld } from "./helpers.js";
import {
  runBackfillReasoningTick,
  resetBackfillSchedulerStateForTesting,
  type BackfillSchedulerConfig,
} from "../src/lib/backfill-reasoning-scheduler.js";

/**
 * DB-backed tests for the nightly backfill scheduler. We deliberately seed
 * rows whose `imageUrl` does NOT exist on disk so the underlying batch
 * function classifies them as `missing_media` and never invokes the VLM.
 * That keeps these tests hermetic — the only thing under test here is the
 * scheduler's quiet-hours gating, once-per-window dedup, and crash
 * resilience, all of which work the same regardless of why a row was
 * touched.
 */

interface Cfg extends BackfillSchedulerConfig {}

function cfg(overrides: Partial<Cfg> = {}): Cfg {
  return {
    enabled: true,
    batchSize: 25,
    quietStartHourUtc: 7,
    quietEndHourUtc: 11,
    checkIntervalMs: 60_000,
    ...overrides,
  };
}

function utc(iso: string): Date {
  return new Date(`${iso}:00Z`);
}

async function seedLegacySubmission(
  world: TestWorld,
): Promise<{ id: number }> {
  const operator = await world.createUser("OPERATOR");
  const area = await world.createArea();
  const [s] = await db
    .insert(submissionsTable)
    .values({
      areaId: area.id,
      userId: operator.id,
      shift: "A",
      scoreTotal: 5,
      scoreJson: { sort: 1, set: 1, shine: 1, standardize: 1, sustain: 1 },
      suggestionsJson: [],
      // Path that doesn't exist on disk — forces the missing_media branch
      // so we never hit the VLM in test.
      imageUrl: `/uploads/scheduler-ghost-${area.tag}.jpg`,
      mediaType: "image",
    })
    .returning({ id: submissionsTable.id });
  return s;
}

describe("runBackfillReasoningTick (nightly scheduler)", () => {
  let world: TestWorld;

  beforeEach(() => {
    world = new TestWorld();
    resetBackfillSchedulerStateForTesting();
  });
  afterEach(async () => {
    await world.cleanup();
    resetBackfillSchedulerStateForTesting();
  });

  test("no-ops when disabled by config", async () => {
    await seedLegacySubmission(world);
    const r = await runBackfillReasoningTick(
      utc("2026-04-22T08:00"),
      cfg({ enabled: false }),
    );
    assert.equal(r.ran, false);
    assert.equal(r.reason, "disabled");
  });

  test("no-ops outside the quiet-hours window", async () => {
    await seedLegacySubmission(world);
    const r = await runBackfillReasoningTick(
      utc("2026-04-22T18:00"), // well outside 07:00–11:00
      cfg(),
    );
    assert.equal(r.ran, false);
    assert.equal(r.reason, "outside_quiet_hours");
  });

  test("runs exactly once per quiet-hours window across multiple ticks", async () => {
    const sub = await seedLegacySubmission(world);

    // Three ticks all inside the same morning window. The first should run,
    // the next two should be deduped by the in-memory window key.
    const t0 = utc("2026-04-22T07:05");
    const t1 = utc("2026-04-22T08:30");
    const t2 = utc("2026-04-22T10:45");

    const r0 = await runBackfillReasoningTick(t0, cfg());
    const r1 = await runBackfillReasoningTick(t1, cfg());
    const r2 = await runBackfillReasoningTick(t2, cfg());

    assert.equal(r0.ran, true, "first tick inside window must run");
    assert.equal(r0.reason, "ran");
    assert.ok(r0.summary, "summary present on a run tick");
    assert.equal(r0.windowKey, "2026-04-22");

    assert.equal(r1.ran, false, "second tick same window must skip");
    assert.equal(r1.reason, "already_ran_window");
    assert.equal(r2.ran, false, "third tick same window must skip");
    assert.equal(r2.reason, "already_ran_window");

    // The next morning's window has a different key, so we run again.
    const tNext = utc("2026-04-23T07:30");
    const rNext = await runBackfillReasoningTick(tNext, cfg());
    assert.equal(rNext.ran, true, "fresh window must run again");
    assert.equal(rNext.windowKey, "2026-04-23");

    // Sanity: the seeded row was visited and reported as missing_media (no
    // VLM call was made).
    assert.ok(
      r0.summary && r0.summary.scanned >= 1,
      "scheduler must have scanned at least the seeded legacy row",
    );
    // The row must still exist with NULL reasoning (missing media doesn't
    // overwrite anything).
    const [after] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, sub.id));
    assert.equal(after.aiReasoningJson, null);
  });

  test("wrap-around window (22:00 → 05:00 UTC) is one logical window", async () => {
    await seedLegacySubmission(world);
    const wrap = cfg({ quietStartHourUtc: 22, quietEndHourUtc: 5 });

    const lateNight = utc("2026-04-22T23:30");
    const earlyMorning = utc("2026-04-23T03:00");
    const next = utc("2026-04-23T22:30");

    const r0 = await runBackfillReasoningTick(lateNight, wrap);
    assert.equal(r0.ran, true);
    assert.equal(r0.windowKey, "2026-04-22");

    const r1 = await runBackfillReasoningTick(earlyMorning, wrap);
    assert.equal(r1.ran, false, "early-morning half is the same window");
    assert.equal(r1.reason, "already_ran_window");

    const r2 = await runBackfillReasoningTick(next, wrap);
    assert.equal(r2.ran, true, "next evening opens a fresh window");
    assert.equal(r2.windowKey, "2026-04-23");
  });

  test("empty queue still consumes the window slot (logs no-op, doesn't retry until tomorrow)", async () => {
    // No legacy rows seeded for this test — but other tests may leave some
    // behind. To keep the assertion meaningful, we just check that running
    // with a NULL-reasoning queue returns ran=true and that a second call
    // in the same window is deduped, regardless of how many rows existed.
    const r0 = await runBackfillReasoningTick(utc("2026-04-22T07:05"), cfg());
    assert.equal(r0.ran, true);
    assert.equal(r0.reason, "ran");
    assert.ok(r0.summary, "ran ticks always carry a summary");

    const r1 = await runBackfillReasoningTick(utc("2026-04-22T07:10"), cfg());
    assert.equal(r1.ran, false);
    assert.equal(r1.reason, "already_ran_window");
  });
});
