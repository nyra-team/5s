import { describe, it, expect } from "vitest";
import { buildUploadErrorToast } from "../operator";

// Mirrors the shape that `customFetch` throws via `ApiError`. We deliberately
// build plain objects (rather than `new ApiError(...)`) so the test doesn't
// depend on the api-client-react package internals — `buildUploadErrorToast`
// is intentionally structural so it works against anything that quacks like
// an ApiError.
function apiError(status: number, data: Record<string, unknown> | null) {
  return { status, statusText: "", data, headers: new Headers(), url: "/api/submissions" };
}

describe("buildUploadErrorToast", () => {
  it("surfaces the SCORING_FAILED hint with a 'couldn't score your capture' title (not the generic title)", () => {
    const t = buildUploadErrorToast(
      apiError(502, {
        error: "Failed to score submission",
        code: "SCORING_FAILED",
        hint: "Try again with brighter lighting and a steadier angle.",
        retryable: true,
      }),
      "Submission failed",
    );
    expect(t.variant).toBe("destructive");
    // The title MUST distinguish "AI declined to score" from "submission
    // failed entirely" so the operator knows whether to fix capture quality.
    expect(t.title).toBe("Couldn't score your capture");
    expect(t.title).not.toBe("Submission failed");
    expect(t.description).toBe("Try again with brighter lighting and a steadier angle.");
  });

  it("falls back to a built-in scoring message when the SCORING_FAILED payload has no hint", () => {
    const t = buildUploadErrorToast(
      apiError(502, { error: "Failed to score submission", code: "SCORING_FAILED" }),
      "Re-upload failed",
    );
    expect(t.title).toBe("Couldn't score your capture");
    expect(t.description).toMatch(/scoring service/i);
    // The fallback copy must still be actionable about what the operator
    // should change, not a vague "try again".
    expect(t.description).toMatch(/lighting|angle|capture/i);
  });

  it("uses the API's hint for MEDIA_REQUIRED so the operator knows what's missing", () => {
    const t = buildUploadErrorToast(
      apiError(400, {
        error: "Media file is required",
        code: "MEDIA_REQUIRED",
        hint: "Pick a photo or video before re-uploading.",
      }),
      "Re-upload failed",
    );
    expect(t.title).toBe("Re-upload failed");
    expect(t.description).toBe("Pick a photo or video before re-uploading.");
  });

  it("preserves the API error message for FORBIDDEN re-uploads", () => {
    const t = buildUploadErrorToast(
      apiError(403, {
        error: "You can only re-upload your own submissions",
        code: "FORBIDDEN",
      }),
      "Re-upload failed",
    );
    expect(t.title).toBe("Re-upload failed");
    expect(t.description).toBe("You can only re-upload your own submissions");
  });

  it("treats a 404 SUBMISSION_NOT_FOUND with the same dedicated copy", () => {
    const t = buildUploadErrorToast(
      apiError(404, { error: "Submission not found", code: "SUBMISSION_NOT_FOUND" }),
      "Re-upload failed",
    );
    expect(t.title).toBe("Re-upload failed");
    expect(t.description).toBe("Submission not found");
  });

  it("falls back to the API's hint or `error` field when the code is unknown", () => {
    // Real-world example: a future error code we haven't taught the client
    // about yet. We must still surface whatever actionable text the server
    // sent rather than the generic "There was an error uploading…".
    const t = buildUploadErrorToast(
      apiError(500, {
        error: "Storage backend unavailable",
        code: "STORAGE_DOWN",
        hint: "Try again in a minute.",
      }),
      "Submission failed",
    );
    expect(t.title).toBe("Submission failed");
    expect(t.description).toBe("Try again in a minute.");
  });

  it("falls back to the API's bare `error` string when no hint is given for an unknown code", () => {
    const t = buildUploadErrorToast(
      apiError(500, { error: "Storage backend unavailable" }),
      "Submission failed",
    );
    expect(t.description).toBe("Storage backend unavailable");
  });

  it("uses the generic copy when the server payload is empty", () => {
    const t = buildUploadErrorToast(apiError(500, null), "Submission failed");
    expect(t.title).toBe("Submission failed");
    expect(t.description).toBe("There was an error uploading. Please try again.");
  });

  // Task #203: structured pipeline failures get distinct, actionable copy.
  // Each test asserts both the title (so the operator can scan toasts) AND
  // the description (so the action they should take is clear) — and it
  // explicitly checks that the server-supplied `hint` always wins so copy
  // can be tuned without a client release.
  describe("structured ScoringError codes", () => {
    it("VIDEO_UNREADABLE: tells the operator to record a different video or use a still", () => {
      const t = buildUploadErrorToast(
        apiError(422, {
          error: "We couldn't read this video.",
          code: "VIDEO_UNREADABLE",
          hint: "The video appears unreadable. Try recording again as a short MP4 or capture a still photo instead.",
          retryable: true,
        }),
        "Submission failed",
      );
      expect(t.title).toBe("We couldn't read this video");
      expect(t.title).not.toBe("Submission failed");
      expect(t.description).toMatch(/MP4|still photo/i);
    });

    it("FRAMES_TOO_DARK: tells the operator to add more light", () => {
      const t = buildUploadErrorToast(
        apiError(422, {
          error: "Capture is too dark to score.",
          code: "FRAMES_TOO_DARK",
          retryable: true,
        }),
        "Submission failed",
      );
      expect(t.title).toBe("Capture is too dark");
      expect(t.description).toMatch(/light|torch/i);
    });

    it("AI_RATE_LIMITED: tells the operator to wait and retry — capture is fine", () => {
      const t = buildUploadErrorToast(
        apiError(502, {
          error: "Our AI is rate-limited right now.",
          code: "AI_RATE_LIMITED",
          retryable: true,
        }),
        "Submission failed",
      );
      expect(t.title).toBe("AI is busy right now");
      expect(t.description).toMatch(/wait|minute/i);
      // The operator should NOT be told to fix capture quality here.
      expect(t.description).toMatch(/capture is fine|try again/i);
    });

    it("AI_TIMEOUT: tells the operator the model didn't respond in time", () => {
      const t = buildUploadErrorToast(
        apiError(502, {
          error: "AI scoring timed out.",
          code: "AI_TIMEOUT",
          retryable: true,
        }),
        "Submission failed",
      );
      expect(t.title).toBe("AI scoring timed out");
      expect(t.description).toMatch(/respond|time/i);
    });

    it("AI_MALFORMED: tells the operator to retry the same capture", () => {
      const t = buildUploadErrorToast(
        apiError(502, {
          error: "AI returned an unusable response.",
          code: "AI_MALFORMED",
          retryable: true,
        }),
        "Submission failed",
      );
      expect(t.title).toBe("AI returned an unusable response");
      expect(t.description).toMatch(/transient|try the same capture/i);
    });

    it("server-supplied hint always wins so copy can be tuned without a client release", () => {
      const t = buildUploadErrorToast(
        apiError(502, {
          error: "Our AI is rate-limited right now.",
          code: "AI_RATE_LIMITED",
          hint: "Backed off until 14:32 IST — please wait two minutes.",
          retryable: true,
        }),
        "Submission failed",
      );
      expect(t.description).toBe("Backed off until 14:32 IST — please wait two minutes.");
    });
  });

  it("uses a connectivity-specific message when the error has no status (network failure)", () => {
    // Simulates fetch rejecting before a Response is received — e.g. the
    // operator's phone went offline mid-upload. The toast should call out
    // connectivity instead of mentioning the scoring service.
    const t = buildUploadErrorToast(
      { name: "TypeError", message: "Failed to fetch" },
      "Submission failed",
    );
    expect(t.title).toBe("Submission failed");
    expect(t.description).toMatch(/connection/i);
    expect(t.description).not.toMatch(/scoring/i);
  });
});
