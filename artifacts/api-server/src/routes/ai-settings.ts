import { Router, type IRouter } from "express";
import { sql, eq } from "drizzle-orm";
import { db, aiSettingsTable, usersTable } from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import {
  DEFAULT_VLM_MODEL,
  VLM_MODEL_VALIDATOR,
  VLM_MODEL_MAX_LENGTH,
  getDbAiSettings,
  getEnvVlmModel,
  loadEffectiveVlmModel,
} from "../lib/ai-settings.js";

const router: IRouter = Router();

interface AiSettingsPayload {
  /** env > DB > default. */
  vlmModel: string;
  /** Shipped fallback. */
  defaults: { vlmModel: string };
  /** Env-var overrides snapshot (null = not pinned). */
  envOverrides: { vlmModel: string | null };
  /** DB row override (null = no DB override). */
  dbOverrides: { vlmModel: string | null };
  updatedAt: string | null;
  updatedByUserId: number | null;
  updatedByUserEmail: string | null;
}

async function resolveEmail(userId: number | null): Promise<string | null> {
  if (userId == null) return null;
  const [row] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.email ?? null;
}

async function buildPayload(): Promise<AiSettingsPayload> {
  const [effective, dbRow] = await Promise.all([
    loadEffectiveVlmModel(),
    getDbAiSettings(),
  ]);
  const env = getEnvVlmModel();
  const updatedByUserEmail = await resolveEmail(dbRow.updatedByUserId);
  return {
    vlmModel: effective,
    defaults: { vlmModel: DEFAULT_VLM_MODEL },
    envOverrides: { vlmModel: env },
    dbOverrides: { vlmModel: dbRow.vlmModel },
    updatedAt: dbRow.updatedAt ? dbRow.updatedAt.toISOString() : null,
    updatedByUserId: dbRow.updatedByUserId,
    updatedByUserEmail,
  };
}

router.get("/ai-settings", authMiddleware, async (_req, res): Promise<void> => {
  res.json(await buildPayload());
});

// Manager-only write for the singleton DB row. Per-field PATCH semantics:
//   omitted → leave alone, null → clear override, value → set override.
// We reject the whole request on a bad model id rather than commit silently.
router.put(
  "/ai-settings",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const { userId } = (req as any).user as { userId: number };
    const body = (req.body ?? {}) as Record<string, unknown>;

    let nextVlmModel: string | null | undefined;
    if ("vlmModel" in body) {
      const v = body.vlmModel;
      if (v === null) {
        nextVlmModel = null;
      } else if (VLM_MODEL_VALIDATOR(v)) {
        nextVlmModel = v.trim();
      } else {
        res.status(400).json({
          error: "Invalid vlmModel",
          fields: {
            vlmModel: `Must be a non-empty string up to ${VLM_MODEL_MAX_LENGTH} characters`,
          },
        });
        return;
      }
    }

    if (nextVlmModel !== undefined) {
      // Singleton row at id=1, mirroring operator_settings / facility_settings.
      const changedAt = new Date();
      await db
        .insert(aiSettingsTable)
        .values({
          id: 1,
          vlmModel: nextVlmModel,
          updatedByUserId: userId,
          updatedAt: changedAt,
        })
        .onConflictDoUpdate({
          target: aiSettingsTable.id,
          set: {
            vlmModel: nextVlmModel,
            updatedByUserId: userId,
            updatedAt: changedAt,
          },
        });

      // Keep the serial sequence aligned with our explicit id=1 write.
      await db.execute(
        sql`SELECT setval(pg_get_serial_sequence('ai_settings', 'id'), GREATEST((SELECT MAX(id) FROM ai_settings), 1))`,
      );
    }

    res.json(await buildPayload());
  },
);

export default router;
