import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatAnalysisMs, KeyframeMetricsBlock } from "../submissions";
import type { KeyframeMetrics } from "@workspace/api-client-react";

describe("formatAnalysisMs", () => {
  it("renders sub-second durations in milliseconds so step rows do not collapse to 0.0s", () => {
    expect(formatAnalysisMs(0)).toBe("0 ms");
    expect(formatAnalysisMs(42)).toBe("42 ms");
    expect(formatAnalysisMs(999)).toBe("999 ms");
  });

  it("flips to seconds with one decimal for longer durations so the breakdown still fits on a phone", () => {
    expect(formatAnalysisMs(1000)).toBe("1.0 s");
    expect(formatAnalysisMs(1499)).toBe("1.5 s");
    expect(formatAnalysisMs(12_345)).toBe("12.3 s");
  });

  it("guards against bad numbers from the API", () => {
    expect(formatAnalysisMs(Number.NaN)).toBe("—");
    expect(formatAnalysisMs(-1)).toBe("—");
    expect(formatAnalysisMs(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("KeyframeMetricsBlock", () => {
  const baseMetrics: KeyframeMetrics = {
    candidatesProduced: 12,
    candidatesKept: 8,
    droppedDuplicate: 4,
    droppedOverCap: 0,
    sceneDetectMs: 1200,
    fallbackSampleMs: null,
    dedupMs: 300,
    compressMs: 800,
    totalMs: 2300,
    usedFallback: false,
  };

  function rowTextFor(label: RegExp): string {
    const labelNode = screen.getByText(label);
    const row = labelNode.closest("div.flex");
    if (!row) throw new Error(`Could not find metric row for ${label}`);
    return row.textContent ?? "";
  }

  it("shows produced / kept / dropped frame counts so managers can spot a noisy capture", () => {
    render(<KeyframeMetricsBlock metrics={baseMetrics} />);
    expect(rowTextFor(/Candidates produced/i)).toContain("12");
    expect(rowTextFor(/Frames kept/i)).toContain("8");
    expect(rowTextFor(/Dropped as duplicates/i)).toContain("4");
    expect(rowTextFor(/Dropped over cap/i)).toContain("0");
  });

  it("shows total analysis time and per-step breakdown so slow phases are visible", () => {
    render(<KeyframeMetricsBlock metrics={baseMetrics} />);
    expect(rowTextFor(/Total analysis time/i)).toContain("2.3 s");
    expect(rowTextFor(/Scene detection/i)).toContain("1.2 s");
    expect(rowTextFor(/Deduplication/i)).toContain("300 ms");
    expect(rowTextFor(/Compression/i)).toContain("800 ms");
  });

  it("hides the fallback-sampling row when scene detection found enough scenes on its own", () => {
    render(<KeyframeMetricsBlock metrics={baseMetrics} />);
    expect(screen.queryByText(/Fallback sampling/i)).toBeNull();
  });

  it("surfaces the fallback-sampling row when the analyzer had to take uniform samples", () => {
    render(
      <KeyframeMetricsBlock
        metrics={{ ...baseMetrics, usedFallback: true, fallbackSampleMs: 450 }}
      />,
    );
    expect(rowTextFor(/Fallback sampling/i)).toContain("450 ms");
  });
});
