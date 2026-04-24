import { describe, it, expect } from "vitest";
import { computeVideoUnreadable } from "../submissions";

// Pure-function tests for the derived `videoUnreadable` flag exposed on
// every submission response. The flag is what drives the operator UI's
// "we couldn't analyze this video — re-record a shorter clip or upload a
// still photo" banner, so silently flipping any of these cases would
// either drop the banner where it's needed (operator left guessing) or
// surface it on perfectly-fine submissions (operator distrust).
describe("computeVideoUnreadable", () => {
  it("flags a video FALLBACK with no keyframes (the ffmpeg-gave-up case)", () => {
    expect(
      computeVideoUnreadable({
        mediaType: "video",
        keyframesJson: null,
        scoringMode: "FALLBACK",
      }),
    ).toBe(true);
  });

  it("flags a video FALLBACK with an explicitly-empty keyframes array", () => {
    // The route writes `null` when nothing was kept, but legacy/forward-
    // compatible rows could carry `[]`; both must read the same.
    expect(
      computeVideoUnreadable({
        mediaType: "video",
        keyframesJson: [],
        scoringMode: "FALLBACK",
      }),
    ).toBe(true);
  });

  it("does NOT flag a video FALLBACK that produced keyframes (model/network failure)", () => {
    // Keyframes succeeded — the failure was downstream (VLM error). The
    // remediation differs (retry vs. re-record), so we must not misclassify.
    expect(
      computeVideoUnreadable({
        mediaType: "video",
        keyframesJson: ["/uploads/a.jpg", "/uploads/b.jpg"],
        scoringMode: "FALLBACK",
      }),
    ).toBe(false);
  });

  it("does NOT flag a successfully-scored video with no keyframes (defensive)", () => {
    // Belt-and-braces: even if a row somehow had no keyframes but a real
    // scoringMode, we must not mark it as videoUnreadable.
    expect(
      computeVideoUnreadable({
        mediaType: "video",
        keyframesJson: null,
        scoringMode: "VLM_RUBRIC",
      }),
    ).toBe(false);
  });

  it("does NOT flag image submissions even on FALLBACK", () => {
    // Image FALLBACKs are VLM/network problems — different remediation
    // (brighter lighting, retry), surfaced through the existing FALLBACK
    // toast path, not the videoUnreadable banner.
    expect(
      computeVideoUnreadable({
        mediaType: "image",
        keyframesJson: null,
        scoringMode: "FALLBACK",
      }),
    ).toBe(false);
  });

  it("does NOT flag rows with a missing scoringMode (legacy rows)", () => {
    expect(
      computeVideoUnreadable({
        mediaType: "video",
        keyframesJson: null,
        scoringMode: null,
      }),
    ).toBe(false);
  });
});
