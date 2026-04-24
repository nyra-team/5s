import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  submissionsTable,
  escalationsTable,
} from "@workspace/db";
import { recoverPendingEscalationNotifications } from "../notifications";

// Verifies the new NO_PROVIDER_CONFIGURED breadcrumb. When dispatch runs but
// neither Slack (SLACK_WEBHOOK_URL) nor Resend (RESEND_API_KEY +
// NOTIFICATION_FROM_EMAIL) is configured, escalations targeted at managers
// who have channels enabled must end up stamped NO_PROVIDER_CONFIGURED so the
// inbox can show "no channel configured" instead of pretending the alert
// went out.
//
// We exercise this through the startup recovery sweep — the simplest entry
// point that synchronously runs dispatch on a row we control end-to-end.

const RUN_TAG = `no-provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORIGINAL = {
  recoveryWindow: process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS,
  groupingWindow: process.env.ESCALATION_NOTIFICATION_WINDOW_MS,
  slack: process.env.SLACK_WEBHOOK_URL,
  resend: process.env.RESEND_API_KEY,
  from: process.env.NOTIFICATION_FROM_EMAIL,
};

let operatorId: number;
let managerId: number;
let area: { id: number; name: string };
let submissionId: number;
const inserted: number[] = [];

beforeAll(async () => {
  // Disable grouping so dispatch runs synchronously inside the recovery
  // sweep, and pin the recovery window so a recent row stays in-window.
  process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS = String(60 * 60 * 1000);
  process.env.ESCALATION_NOTIFICATION_WINDOW_MS = "0";
  // Strip any provider config so the dispatch path takes the no-provider
  // branch deterministically regardless of the developer's local env.
  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFICATION_FROM_EMAIL;

  const [op] = await db
    .insert(usersTable)
    .values({ email: `${RUN_TAG}-op@test.local`, passwordHash: "x", role: "OPERATOR" })
    .returning();
  operatorId = op.id;

  // A manager with email enabled — without this, dispatch's "no targeted
  // managers" short-circuit would stamp DELIVERED for unrelated reasons and
  // we'd never exercise the new branch.
  const [mgr] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-mgr@test.local`,
      passwordHash: "x",
      role: "MANAGER",
      notifyEmailEnabled: true,
      notifySlackEnabled: false,
    })
    .returning();
  managerId = mgr.id;

  const [a] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-area` })
    .returning();
  area = { id: a.id, name: a.name };

  const [sub] = await db
    .insert(submissionsTable)
    .values({
      userId: operatorId,
      areaId: area.id,
      shift: "A",
      scoreTotal: 8,
      scoreJson: { sort: 1, set: 1, shine: 2, standardize: 2, sustain: 2 },
      suggestionsJson: [],
      imageUrl: `/uploads/${RUN_TAG}.jpg`,
      mediaType: "image",
    })
    .returning();
  submissionId = sub.id;
});

afterAll(async () => {
  if (inserted.length > 0) {
    await db.delete(escalationsTable).where(inArray(escalationsTable.id, inserted));
  }
  if (submissionId) {
    await db.delete(submissionsTable).where(eq(submissionsTable.id, submissionId));
  }
  if (area?.id) {
    await db.delete(areasTable).where(eq(areasTable.id, area.id));
  }
  if (managerId) {
    await db.delete(usersTable).where(eq(usersTable.id, managerId));
  }
  if (operatorId) {
    await db.delete(usersTable).where(eq(usersTable.id, operatorId));
  }
  for (const [k, original] of Object.entries(ORIGINAL) as Array<[
    keyof typeof ORIGINAL,
    string | undefined,
  ]>) {
    const envName = (
      {
        recoveryWindow: "ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS",
        groupingWindow: "ESCALATION_NOTIFICATION_WINDOW_MS",
        slack: "SLACK_WEBHOOK_URL",
        resend: "RESEND_API_KEY",
        from: "NOTIFICATION_FROM_EMAIL",
      } as const
    )[k];
    if (original === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = original;
    }
  }
  await pool.end();
});

beforeEach(async () => {
  if (inserted.length > 0) {
    await db.delete(escalationsTable).where(inArray(escalationsTable.id, inserted));
    inserted.length = 0;
  }
});

async function insertEscalation(opts: { createdAt: Date }): Promise<number> {
  const [row] = await db
    .insert(escalationsTable)
    .values({
      submissionId,
      areaId: area.id,
      operatorId,
      scoreTotal: 8,
      scorePercent: 32,
      failingPillarsJson: ["sort"],
      recommendedActionsJson: ["Reset workstation"],
      evidenceUrlsJson: [],
      status: "OPEN",
      createdAt: opts.createdAt,
    })
    .returning();
  inserted.push(row.id);
  return row.id;
}

describe("dispatch — NO_PROVIDER_CONFIGURED", () => {
  it("stamps NO_PROVIDER_CONFIGURED when neither Slack nor Resend is configured", async () => {
    const id = await insertEscalation({
      // Recent so the recovery sweep re-dispatches instead of skipping.
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    await recoverPendingEscalationNotifications();

    const [row] = await db
      .select({
        notifiedAt: escalationsTable.notifiedAt,
        notifyDeliveryStatus: escalationsTable.notifyDeliveryStatus,
      })
      .from(escalationsTable)
      .where(eq(escalationsTable.id, id));

    expect(row.notifiedAt).not.toBeNull();
    expect(row.notifyDeliveryStatus).toBe("NO_PROVIDER_CONFIGURED");
  });

  it("still stamps DELIVERED once a provider is configured", async () => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.example.invalid/skip";
    // Make sure the sole manager has Slack enabled so the now-configured
    // provider actually serves a channel they have on. Otherwise this test
    // would still see NO_PROVIDER_CONFIGURED for the right reason and we
    // wouldn't be exercising the DELIVERED path we care about.
    await db
      .update(usersTable)
      .set({ notifySlackEnabled: true })
      .where(eq(usersTable.id, managerId));

    const id = await insertEscalation({
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    // Stub fetch so the configured Slack webhook actually "succeeds". The
    // recovery sweep now treats genuine provider failure as transient and
    // re-queues (task #157), which would block DELIVERED stamping; here
    // we're asserting that the NO_PROVIDER_CONFIGURED branch doesn't fire
    // when a provider IS configured, so a healthy 200 response is the
    // right shape for this test.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://hooks.example.invalid/")) {
        return new Response("ok", { status: 200 });
      }
      return originalFetch(input as RequestInfo, _init);
    }) as typeof fetch;

    try {
      await recoverPendingEscalationNotifications();
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.SLACK_WEBHOOK_URL;
      await db
        .update(usersTable)
        .set({ notifySlackEnabled: false })
        .where(eq(usersTable.id, managerId));
    }

    const [row] = await db
      .select({
        notifyDeliveryStatus: escalationsTable.notifyDeliveryStatus,
      })
      .from(escalationsTable)
      .where(eq(escalationsTable.id, id));

    // The Slack webhook URL above is intentionally invalid so no real network
    // call goes anywhere meaningful, but dispatch only inspects whether the
    // env var is *set* when picking the status — it deliberately stamps
    // DELIVERED even when individual provider sends fail (that policy is
    // documented on the NotifyDeliveryStatus type).
    expect(row.notifyDeliveryStatus).toBe("DELIVERED");
  });
});
