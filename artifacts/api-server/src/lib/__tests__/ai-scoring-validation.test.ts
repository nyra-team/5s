import { describe, it, expect } from "vitest";
import { validateVlmJson } from "../ai-scoring.js";

const validReasoning = {
  sort: "frame 1: workspace mostly free of clutter",
  set: "frame 2: tool board labeled, walkways clear",
  shine: "frame 1: floor swept, no dust",
  standardize: "frame 3: visual standards posted",
  sustain: "frame 2: today's checklist signed",
};

const validBody = {
  reasoning: validReasoning,
  pillar_scores: { sort: 4, set: 3, shine: 4, standardize: 3, sustain: 4 },
  issues: [],
  recommendations: [],
  profile: { items: [], machines: [], layout: [], observedIssues: [], summary: "ok" },
};

describe("validateVlmJson", () => {
  it("accepts a fully-populated, in-range response", () => {
    expect(validateVlmJson(validBody)).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(validateVlmJson(null)).toMatch(/JSON object/);
    expect(validateVlmJson("nope")).toMatch(/JSON object/);
  });

  it("rejects missing pillar_scores", () => {
    const { pillar_scores, ...rest } = validBody;
    expect(validateVlmJson(rest)).toMatch(/pillar_scores/);
  });

  it("rejects out-of-range pillar score", () => {
    const bad = {
      ...validBody,
      pillar_scores: { ...validBody.pillar_scores, sort: 9 },
    };
    expect(validateVlmJson(bad)).toMatch(/sort/);
  });

  it("rejects non-numeric pillar score", () => {
    const bad = {
      ...validBody,
      pillar_scores: { ...validBody.pillar_scores, shine: "good" as any },
    };
    expect(validateVlmJson(bad)).toMatch(/shine/);
  });

  it("rejects missing reasoning block", () => {
    const { reasoning, ...rest } = validBody;
    expect(validateVlmJson(rest)).toMatch(/reasoning/);
  });

  it("rejects empty reasoning string for any pillar", () => {
    const bad = {
      ...validBody,
      reasoning: { ...validReasoning, set: "   " },
    };
    expect(validateVlmJson(bad)).toMatch(/reasoning\.set/);
  });

  it("rejects non-array issues", () => {
    expect(validateVlmJson({ ...validBody, issues: "oops" as any })).toMatch(/issues/);
  });

  it("rejects non-array recommendations", () => {
    expect(validateVlmJson({ ...validBody, recommendations: {} as any })).toMatch(/recommendations/);
  });
});
