import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, pool, usersTable, aiSettingsTable } from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// End-to-end coverage for GET / PUT /ai-settings. Mirrors facility-settings.test.ts:
// shared manager + operator fixtures, fresh DB rows per test, supertest against
// the real Express app, and clean env-var teardown so other suites see clean state.

const RUN_TAG = `ai-settings-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let operatorId: number;
let managerToken: string;
let operatorToken: string;
let savedVlmModel: string | undefined;

async function clearAiSettings(): Promise<void> {
  await db.delete(aiSettingsTable);
}

beforeAll(async () => {
  savedVlmModel = process.env.VLM_MODEL;
  delete process.env.VLM_MODEL;

  const [m] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-mgr@test.local`,
      passwordHash: "x",
      role: "MANAGER",
    })
    .returning();
  managerId = m.id;

  const [o] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-op@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  operatorId = o.id;

  managerToken = signToken({ userId: managerId, role: "MANAGER" });
  operatorToken = signToken({ userId: operatorId, role: "OPERATOR" });
});

afterAll(async () => {
  await clearAiSettings();
  await db.delete(usersTable).where(eq(usersTable.id, managerId));
  await db.delete(usersTable).where(eq(usersTable.id, operatorId));
  if (savedVlmModel === undefined) delete process.env.VLM_MODEL;
  else process.env.VLM_MODEL = savedVlmModel;
  await pool.end();
});

beforeEach(async () => {
  await clearAiSettings();
  delete process.env.VLM_MODEL;
});

afterEach(() => {
  delete process.env.VLM_MODEL;
});

describe("GET /api/ai-settings", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/ai-settings");
    expect(res.status).toBe(401);
  });

  it("returns the shipped default when no env / DB override is set", async () => {
    const res = await request(app)
      .get("/api/ai-settings")
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.vlmModel).toBe("gpt-5-mini");
    expect(res.body.defaults).toEqual({ vlmModel: "gpt-5-mini" });
    expect(res.body.envOverrides).toEqual({ vlmModel: null });
    expect(res.body.dbOverrides).toEqual({ vlmModel: null });
    expect(res.body.updatedAt).toBeNull();
  });

  it("reflects an env override and surfaces it in envOverrides", async () => {
    // Pick a value distinct from the shipped default so the assertion
    // actually proves the env layer drove the effective value.
    process.env.VLM_MODEL = "gpt-5";
    const res = await request(app)
      .get("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.vlmModel).toBe("gpt-5");
    expect(res.body.envOverrides).toEqual({ vlmModel: "gpt-5" });
    expect(res.body.dbOverrides).toEqual({ vlmModel: null });
  });

  it("env beats a DB override for the effective value (but DB row is still surfaced)", async () => {
    // Seed a DB override first, then enable an env pin and confirm env wins.
    await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ vlmModel: "claude-x" });

    process.env.VLM_MODEL = "gpt-5";
    const res = await request(app)
      .get("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.body.vlmModel).toBe("gpt-5");
    expect(res.body.envOverrides.vlmModel).toBe("gpt-5");
    expect(res.body.dbOverrides.vlmModel).toBe("claude-x");
  });
});

describe("PUT /api/ai-settings", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app)
      .put("/api/ai-settings")
      .send({ vlmModel: "gpt-5-mini" });
    expect(res.status).toBe(401);
  });

  it("rejects operators (manager-only)", async () => {
    const res = await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ vlmModel: "gpt-5-mini" });
    expect(res.status).toBe(403);
  });

  it("accepts a valid model id from a manager and surfaces it as the effective value", async () => {
    // Use a non-default value so the assertion proves the DB override actually
    // drove the effective value, not just that it happened to match the default.
    const res = await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ vlmModel: "gpt-5" });
    expect(res.status).toBe(200);
    expect(res.body.vlmModel).toBe("gpt-5");
    expect(res.body.dbOverrides).toEqual({ vlmModel: "gpt-5" });
    expect(res.body.updatedByUserId).toBe(managerId);
    expect(res.body.updatedAt).not.toBeNull();
    // Reading back returns the same effective value.
    const get = await request(app)
      .get("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(get.body.vlmModel).toBe("gpt-5");
  });

  it("trims whitespace before storing", async () => {
    const res = await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ vlmModel: "  gpt-5  " });
    expect(res.status).toBe(200);
    expect(res.body.dbOverrides.vlmModel).toBe("gpt-5");
  });

  it("clears the override when given null and falls back to the default", async () => {
    // Seed with a value distinct from the shipped default so the clear step
    // visibly flips the effective model back to the default.
    await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ vlmModel: "gpt-5" });
    const res = await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ vlmModel: null });
    expect(res.status).toBe(200);
    expect(res.body.vlmModel).toBe("gpt-5-mini");
    expect(res.body.dbOverrides).toEqual({ vlmModel: null });
  });

  it("rejects an empty string with 400", async () => {
    const res = await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ vlmModel: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("rejects oversized model ids with 400", async () => {
    const res = await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ vlmModel: "x".repeat(200) });
    expect(res.status).toBe(400);
  });

  it("rejects non-string model ids with 400", async () => {
    const res = await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ vlmModel: 42 });
    expect(res.status).toBe(400);
  });

  it("treats an empty body as a no-op (no DB row created)", async () => {
    const res = await request(app)
      .put("/api/ai-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.dbOverrides).toEqual({ vlmModel: null });
    expect(res.body.updatedAt).toBeNull();
  });
});
