import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, aiScoringMetricsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  AI_SCORING_METRICS_RETENTION_DAYS,
  runMetricsRetentionSweep,
} from "../src/lib/metrics-retention.js";

/**
 * The dashboard's AI-reliability panel only ever reads aggregates over the
 * last 24h / 7d, so we keep a 30-day rolling buffer and prune everything
 * older. These tests pin that contract.
 */
describe("runMetricsRetentionSweep", () => {
  // Tag every row this suite inserts with a unique marker so cleanup only
  // touches our rows — never any seed data or rows another suite happens to
  // have left behind in the (per-run, but still shared between tests in the
  // same run) database.
  const MARKER = "test-retention-sweep";

  afterEach(async () => {
    await db
      .delete(aiScoringMetricsTable)
      .where(eq(aiScoringMetricsTable.modelVersion, MARKER));
  });

  async function insertMetric(createdAt: Date): Promise<number> {
    const [row] = await db
      .insert(aiScoringMetricsTable)
      .values({
        modelVersion: MARKER,
        retried: false,
        validationError: null,
        createdAt,
      })
      .returning({ id: aiScoringMetricsTable.id });
    return row.id;
  }

  async function exists(id: number): Promise<boolean> {
    const rows = await db
      .select({ id: aiScoringMetricsTable.id })
      .from(aiScoringMetricsTable)
      .where(eq(aiScoringMetricsTable.id, id));
    return rows.length === 1;
  }

  test("retention window constant is 30 days", () => {
    // The dashboard reads a 7-day window; this constant must stay above that
    // so a tweak to the dashboard window doesn't silently lose data.
    assert.equal(AI_SCORING_METRICS_RETENTION_DAYS, 30);
  });

  test("deletes rows older than the retention window and keeps newer ones", async () => {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    // Pick anchors well clear of the 30-day boundary so any clock skew between
    // `now` here and the cutoff `runMetricsRetentionSweep` computes can't
    // flip a row to the wrong side.
    const fresh = await insertMetric(new Date(now.getTime() - 1 * day));
    const justInside = await insertMetric(new Date(now.getTime() - 25 * day));
    const justOutside = await insertMetric(new Date(now.getTime() - 31 * day));
    const ancient = await insertMetric(new Date(now.getTime() - 90 * day));

    const deleted = await runMetricsRetentionSweep(now);

    assert.equal(deleted, 2, "exactly the two rows past 30 days were pruned");
    assert.equal(await exists(fresh), true, "1-day-old row kept");
    assert.equal(await exists(justInside), true, "25-day-old row kept");
    assert.equal(await exists(justOutside), false, "31-day-old row pruned");
    assert.equal(await exists(ancient), false, "90-day-old row pruned");
  });

  test("is a no-op when nothing is past the retention window", async () => {
    const now = new Date();
    const recent = await insertMetric(new Date(now.getTime() - 60 * 1000));
    const deleted = await runMetricsRetentionSweep(now);
    assert.equal(deleted, 0);
    assert.equal(await exists(recent), true);
  });
});
