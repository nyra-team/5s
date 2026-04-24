import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveVlmModel,
  getEnvVlmModel,
  DEFAULT_VLM_MODEL,
  VLM_MODEL_VALIDATOR,
  VLM_MODEL_MAX_LENGTH,
} from "../ai-settings";

// Pure unit tests for the precedence chain: env > DB > shipped default.
// callVLM and callIdentificationVLM both consume `loadEffectiveVlmModel`,
// so a regression here would silently affect both endpoints. Pinning every
// layer keeps a future refactor honest.

describe("resolveVlmModel", () => {
  it("falls all the way through to the shipped default when both layers are null", () => {
    expect(resolveVlmModel({ env: null, dbOverride: null })).toBe(
      DEFAULT_VLM_MODEL,
    );
  });

  it("uses the DB layer when env is null", () => {
    expect(
      resolveVlmModel({ env: null, dbOverride: "gpt-5-mini" }),
    ).toBe("gpt-5-mini");
  });

  it("env wins over DB", () => {
    expect(
      resolveVlmModel({ env: "gpt-5", dbOverride: "gpt-5-mini" }),
    ).toBe("gpt-5");
  });

  it("env wins over default when DB is null", () => {
    expect(resolveVlmModel({ env: "gpt-5-mini", dbOverride: null })).toBe(
      "gpt-5-mini",
    );
  });
});

describe("getEnvVlmModel", () => {
  const originalEnv = process.env.VLM_MODEL;

  beforeEach(() => {
    delete process.env.VLM_MODEL;
  });

  afterEach(() => {
    if (originalEnv == null) {
      delete process.env.VLM_MODEL;
    } else {
      process.env.VLM_MODEL = originalEnv;
    }
  });

  it("returns null when the env var is unset", () => {
    expect(getEnvVlmModel()).toBeNull();
  });

  it("returns null when the env var is empty or whitespace", () => {
    process.env.VLM_MODEL = "";
    expect(getEnvVlmModel()).toBeNull();
    process.env.VLM_MODEL = "   ";
    expect(getEnvVlmModel()).toBeNull();
  });

  it("returns the trimmed value when set to a normal model id", () => {
    process.env.VLM_MODEL = "  gpt-5-mini  ";
    expect(getEnvVlmModel()).toBe("gpt-5-mini");
  });

  it("rejects values longer than the documented cap", () => {
    process.env.VLM_MODEL = "x".repeat(VLM_MODEL_MAX_LENGTH + 1);
    expect(getEnvVlmModel()).toBeNull();
  });
});

describe("VLM_MODEL_VALIDATOR", () => {
  it("accepts realistic model ids", () => {
    expect(VLM_MODEL_VALIDATOR("gpt-5")).toBe(true);
    expect(VLM_MODEL_VALIDATOR("gpt-5-mini")).toBe(true);
    expect(VLM_MODEL_VALIDATOR("openai/gpt-5")).toBe(true);
  });

  it("rejects empty / non-string / oversize values", () => {
    expect(VLM_MODEL_VALIDATOR("")).toBe(false);
    expect(VLM_MODEL_VALIDATOR("   ")).toBe(false);
    expect(VLM_MODEL_VALIDATOR(undefined)).toBe(false);
    expect(VLM_MODEL_VALIDATOR(null)).toBe(false);
    expect(VLM_MODEL_VALIDATOR(42)).toBe(false);
    expect(VLM_MODEL_VALIDATOR("x".repeat(VLM_MODEL_MAX_LENGTH + 1))).toBe(
      false,
    );
  });
});
