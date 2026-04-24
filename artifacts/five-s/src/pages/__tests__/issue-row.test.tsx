/**
 * Focused unit test for the operator's <IssueRow> component (added in
 * task #149). IssueRow is rendered both inside the completed <AreaCard>
 * (covered alongside the rest of the card in area-card.test.tsx) AND
 * inside <RecentDetailDialog> on the recent-audit dialog. Rather than
 * spinning up the full dialog (which would require mocking the
 * useGetSubmission query and a Dialog portal), this test exercises the
 * row in isolation so the dialog's "Observed issues" path is locked in
 * by the same component.
 *
 * What it asserts:
 *   1. AI-provided severity is trusted and recorded as data-severity-source="ai".
 *   2. Missing severity falls back to keyword inference on issue+evidence
 *      (same `inferSuggestionSeverity` helper used by SuggestionRow).
 *   3. The issue text, evidence, location/principle meta line, and pillar
 *      pill all render when present.
 *   4. The severity badge label matches the resolved severity ("High" /
 *      "Medium" / "Low") and exposes an aria-label so screen readers can
 *      announce it.
 */
import { describe, test, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { IssueRow } from "@/pages/operator";

afterEach(() => {
  cleanup();
});

describe("operator <IssueRow>", () => {
  test("trusts the AI-provided severity and renders the matching badge", () => {
    render(
      <ul>
        <IssueRow
          index={0}
          issue={{
            issue: "Leak observed near pump base",
            evidence: "Visible fluid pooling on the floor under the pump.",
            location: "Pump bay",
            pillar: "shine",
            principle: "Cleanliness",
            severity: "high",
          }}
        />
      </ul>,
    );

    const row = screen.getByTestId("issue-row-0");
    expect(row.getAttribute("data-severity")).toBe("high");
    expect(row.getAttribute("data-severity-source")).toBe("ai");
    // Issue text and evidence are both visible to the operator.
    expect(screen.getByText(/Leak observed near pump base/)).toBeInTheDocument();
    expect(
      screen.getByText(/Visible fluid pooling on the floor under the pump\./),
    ).toBeInTheDocument();
    // Location + principle render in the meta line.
    expect(screen.getByText(/Pump bay · Cleanliness/)).toBeInTheDocument();
    // Pillar pill renders separately.
    expect(screen.getByText(/^shine$/)).toBeInTheDocument();
    // Severity badge has an accessible label and the resolved label text.
    const badge = screen.getByLabelText("Severity: High");
    expect(badge).toHaveTextContent("High");
    expect(badge.getAttribute("title")).toContain("AI severity");
  });

  test("falls back to keyword inference when the AI omitted severity", () => {
    render(
      <ul>
        <IssueRow
          index={0}
          issue={{
            // No severity field. The keyword "broken" trips the medium
            // pattern in inferSuggestionSeverity, so the row should render
            // as Medium with data-severity-source="inferred".
            issue: "Storage bin label broken",
            evidence: "Bin tag is illegible.",
            location: "Aisle 2",
          }}
        />
      </ul>,
    );

    const row = screen.getByTestId("issue-row-0");
    expect(row.getAttribute("data-severity")).toBe("medium");
    expect(row.getAttribute("data-severity-source")).toBe("inferred");
    const badge = screen.getByLabelText("Severity: Medium");
    expect(badge).toHaveTextContent("Medium");
    expect(badge.getAttribute("title")).toContain("Inferred severity");
  });

  test("falls back to High via inference when issue text contains a hazard keyword", () => {
    render(
      <ul>
        <IssueRow
          index={0}
          issue={{
            // "spill" is in the high-severity hazard list, so even without
            // an AI-provided severity the row should render as High. Locks
            // in the choice to feed `issue + evidence` into the inference.
            issue: "Chemical spill near workstation",
            evidence: "Floor is slick.",
            location: "Bay 3",
          }}
        />
      </ul>,
    );

    const row = screen.getByTestId("issue-row-0");
    expect(row.getAttribute("data-severity")).toBe("high");
    expect(row.getAttribute("data-severity-source")).toBe("inferred");
  });

  test("renders without a meta line when location and principle are both absent", () => {
    render(
      <ul>
        <IssueRow
          index={0}
          issue={{
            issue: "General housekeeping",
            evidence: "Minor dust on shelf",
            location: "",
            severity: "low",
          }}
        />
      </ul>,
    );

    const row = screen.getByTestId("issue-row-0");
    expect(row.getAttribute("data-severity")).toBe("low");
    // No "Pump bay" / "Cleanliness" style line should appear.
    expect(screen.queryByText(/·/)).toBeNull();
  });
});
