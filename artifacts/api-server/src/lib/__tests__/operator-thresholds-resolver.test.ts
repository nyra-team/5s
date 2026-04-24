import { describe, it, expect } from "vitest";
import {
  resolveOperatorThresholds,
  DEFAULT_OPERATOR_THRESHOLDS,
} from "../operator-thresholds";

// Pure unit tests for the precedence chain: env > area-DB > global-DB >
// default. The hot path in /operator/recent calls this without a DB hop, so
// regressing the order would silently give the wrong window for one area
// while everything else looked normal — these tests pin every layer.

const NULL_SOURCES = {
  encouragementMinPercent: null,
  priorBestWindowDays: null,
  dueSoonThresholdMinutes: null,
} as const;

describe("resolveOperatorThresholds", () => {
  it("falls all the way through to defaults when every layer is null", () => {
    const out = resolveOperatorThresholds({
      env: { ...NULL_SOURCES },
      areaOverride: null,
      globalOverride: { ...NULL_SOURCES },
    });
    expect(out).toEqual(DEFAULT_OPERATOR_THRESHOLDS);
  });

  it("uses the global DB layer when area is empty", () => {
    const out = resolveOperatorThresholds({
      env: { ...NULL_SOURCES },
      areaOverride: { ...NULL_SOURCES },
      globalOverride: {
        encouragementMinPercent: 70,
        priorBestWindowDays: 14,
        dueSoonThresholdMinutes: 30,
      },
    });
    expect(out.encouragementMinPercent).toBe(70);
    expect(out.priorBestWindowDays).toBe(14);
    expect(out.dueSoonThresholdMinutes).toBe(30);
  });

  it("prefers the area DB layer over the global DB layer", () => {
    const out = resolveOperatorThresholds({
      env: { ...NULL_SOURCES },
      areaOverride: {
        encouragementMinPercent: null,
        priorBestWindowDays: 3,
        dueSoonThresholdMinutes: null,
      },
      globalOverride: {
        encouragementMinPercent: 70,
        priorBestWindowDays: 14,
        dueSoonThresholdMinutes: 30,
      },
    });
    // Per-field fallthrough: area wins for priorBestWindowDays only;
    // the other two should still come from the global layer.
    expect(out.priorBestWindowDays).toBe(3);
    expect(out.encouragementMinPercent).toBe(70);
    expect(out.dueSoonThresholdMinutes).toBe(30);
  });

  it("env wins over both area and global for the same field", () => {
    const out = resolveOperatorThresholds({
      env: {
        encouragementMinPercent: 90,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
      areaOverride: {
        encouragementMinPercent: 50,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
      globalOverride: {
        encouragementMinPercent: 60,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
    });
    expect(out.encouragementMinPercent).toBe(90);
  });

  it("treats `null` areaOverride identically to no override", () => {
    const withNullObj = resolveOperatorThresholds({
      env: { ...NULL_SOURCES },
      areaOverride: { ...NULL_SOURCES },
      globalOverride: {
        encouragementMinPercent: 65,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
    });
    const withNullArg = resolveOperatorThresholds({
      env: { ...NULL_SOURCES },
      areaOverride: null,
      globalOverride: {
        encouragementMinPercent: 65,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
    });
    expect(withNullObj).toEqual(withNullArg);
    expect(withNullObj.encouragementMinPercent).toBe(65);
  });

  it("resolves per-field independently across all four layers", () => {
    const out = resolveOperatorThresholds({
      env: {
        encouragementMinPercent: 95,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
      areaOverride: {
        encouragementMinPercent: null,
        priorBestWindowDays: 2,
        dueSoonThresholdMinutes: null,
      },
      globalOverride: {
        encouragementMinPercent: null,
        priorBestWindowDays: 14,
        dueSoonThresholdMinutes: 45,
      },
    });
    expect(out.encouragementMinPercent).toBe(95); // from env
    expect(out.priorBestWindowDays).toBe(2); // from area
    expect(out.dueSoonThresholdMinutes).toBe(45); // from global
  });
});
