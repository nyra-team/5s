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
