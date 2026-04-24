/**
 * VLM model resolver shared by scoring + identification calls.
 * Precedence: env (VLM_MODEL) > DB row in ai_settings > shipped default.
 * Same layered pattern as operator-thresholds / facility-settings.
 */
import { db, aiSettingsTable } from "@workspace/db";

export const DEFAULT_VLM_MODEL = "gpt-5";
export const VLM_MODEL_MAX_LENGTH = 128;

export const VLM_MODEL_VALIDATOR = (v: unknown): v is string =>
  typeof v === "string" &&
  v.trim().length > 0 &&
  v.trim().length <= VLM_MODEL_MAX_LENGTH;

export function getEnvVlmModel(): string | null {
  const raw = process.env.VLM_MODEL;
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!VLM_MODEL_VALIDATOR(trimmed)) return null;
  return trimmed;
}

export async function getDbAiSettings(): Promise<{
  vlmModel: string | null;
  updatedByUserId: number | null;
  updatedAt: Date | null;
}> {
  const [row] = await db
    .select()
    .from(aiSettingsTable)
    .orderBy(aiSettingsTable.id)
    .limit(1);
  if (!row) {
    return { vlmModel: null, updatedByUserId: null, updatedAt: null };
  }
  return {
    vlmModel: row.vlmModel,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/** Pure precedence resolver — env > DB > default. */
export function resolveVlmModel(args: {
  env: string | null;
  dbOverride: string | null;
}): string {
  return args.env ?? args.dbOverride ?? DEFAULT_VLM_MODEL;
}

/** Resolve per request (no cache) so the admin toggle takes effect immediately. */
export async function loadEffectiveVlmModel(): Promise<string> {
  const env = getEnvVlmModel();
  if (env != null) return env;
  const dbRow = await getDbAiSettings();
  return resolveVlmModel({ env: null, dbOverride: dbRow.vlmModel });
}
