import { describe, expect, it } from "vitest";
import type { EnvironmentType } from "@workspace/db";
import { getEnvironmentLabel, getRubric } from "../ai-scoring.js";

const ENVIRONMENTS: EnvironmentType[] = [
  "factory",
  "warehouse",
  "home",
  "corporate_office",
];

const RUBRIC_SIGNATURES: Record<EnvironmentType, RegExp[]> = {
  factory: [
    /strict 5S \+ GMP auditor for a manufacturing facility/i,
    /GMP principles to apply/i,
    /HYGIENE: hand-wash stations/i,
  ],
  warehouse: [
    /strict 5S auditor for a WAREHOUSE \/ distribution centre/i,
    /WAREHOUSE-specific principles to apply/i,
    /RACKING SAFETY:/i,
  ],
  home: [
    /friendly home-organisation coach/i,
    /Domestic principles to apply/i,
    /SAFETY AT HOME:/i,
  ],
  corporate_office: [
    /strict 5S auditor for a CORPORATE OFFICE workspace/i,
    /CORPORATE-OFFICE-specific principles to cite when violated/i,
    /MEETING ROOM READINESS:/i,
  ],
};

const INDUSTRIAL_TERMS = [
  "PPE",
  "hairnet",
  "GMP",
  "batch record",
  "calibration",
  "forklift",
  "racking",
  "shadow board",
];

function matchedEnvironments(rubric: string): EnvironmentType[] {
  return ENVIRONMENTS.filter((env) =>
    RUBRIC_SIGNATURES[env].every((rx) => rx.test(rubric)),
  );
}

describe("getRubric", () => {
  it.each(ENVIRONMENTS)(
    "returns the matching rubric body for %s and never falls through to another environment",
    (env) => {
      const rubric = getRubric(env);
      expect(matchedEnvironments(rubric)).toEqual([env]);
    },
  );

  it("defaults to the factory rubric when no environment is supplied", () => {
    expect(matchedEnvironments(getRubric(undefined))).toEqual(["factory"]);
  });

  it("always appends the shared output-contract instructions", () => {
    for (const env of ENVIRONMENTS) {
      const rubric = getRubric(env);
      expect(rubric).toMatch(/For each ISSUE you cite/);
      expect(rubric).toMatch(/Output ONLY valid JSON in this exact shape/);
      expect(rubric).toMatch(/"pillar_scores"/);
    }
  });

  it.each(ENVIRONMENTS)(
    "produces a stable snapshot of the %s rubric (locks the prompt language)",
    (env) => {
      expect(getRubric(env)).toMatchSnapshot();
    },
  );
});

describe("office-inappropriate language guard", () => {
  const officeLikeEnvs: EnvironmentType[] = ["corporate_office", "home"];

  it.each(officeLikeEnvs)(
    "%s rubric contains no industrial-floor jargon",
    (env) => {
      // Strip the shared output contract — its example issue mentions a
      // "shadow outline" / shadow board, which is appropriate context for the
      // factory rubric and not a leak into the office/home prompt language.
      const rubric = getRubric(env);
      const sharedAt = rubric.indexOf("For each ISSUE you cite");
      expect(sharedAt).toBeGreaterThan(0);
      const envOnly = rubric.slice(0, sharedAt);

      for (const term of INDUSTRIAL_TERMS) {
        const rx = new RegExp(`(^|[^A-Za-z])${escape(term)}([^A-Za-z]|$)`, "i");
        const offending = findOffendingLines(envOnly, rx);
        expect(
          offending,
          `${env} rubric must not assert "${term}" — found:\n${offending.join("\n")}`,
        ).toEqual([]);
      }
    },
  );
});

describe("getEnvironmentLabel", () => {
  it("returns a unique, environment-appropriate phrase for each value", () => {
    const labels = ENVIRONMENTS.map((env) => getEnvironmentLabel(env));
    expect(new Set(labels).size).toBe(labels.length);

    expect(getEnvironmentLabel("factory")).toBe("manufacturing facility");
    expect(getEnvironmentLabel("warehouse")).toBe(
      "warehouse / distribution centre",
    );
    expect(getEnvironmentLabel("home")).toBe("domestic / home space");
    expect(getEnvironmentLabel("corporate_office")).toBe(
      "corporate office workspace",
    );
  });

  it("defaults to the manufacturing-facility label when no environment is supplied", () => {
    expect(getEnvironmentLabel(undefined)).toBe("manufacturing facility");
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The office/home rubrics actively negate industrial jargon (e.g. "Do NOT
// mention PPE, hairnets..."). Those negations should NOT trigger the guard
// because they're enforcing the very property we're testing for. Drop any
// line containing "Do NOT" / "do not" near the term before failing.
function findOffendingLines(body: string, rx: RegExp): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => rx.test(line) && !/do\s*not/i.test(line));
}
