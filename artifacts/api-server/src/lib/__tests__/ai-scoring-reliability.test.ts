import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks for the OpenAI SDK and DB. The DB mock captures every metric row
// the pipeline records so we can assert the new outcome / jsonAttempts /
// transientAttempts / elapsedMs columns are populated correctly.
const createMock = vi.fn();

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: createMock,
      },
    },
  },
}));

const insertedRows: any[] = [];
vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({
      values: async (row: any) => {
        insertedRows.push(row);
      },
    }),
  },
  aiScoringMetricsTable: {},
}));

// Minimal error shapes that match the openai SDK's public contract
// (name + status). The production helpers in ai-scoring.ts classify
// errors by structural duck-typing, so the test fakes don't need to
// extend any specific SDK class — they just need the same .name / .status.
class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "APIError";
    this.status = status;
  }
}
class FakeRateLimitError extends FakeAPIError {
  constructor(message: string) {
    super(429, message);
    this.name = "RateLimitError";
  }
}
class FakeAPIConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "APIConnectionError";
  }
}
class FakeAPIUserAbortError extends Error {
  constructor() {
    super("Request was aborted");
    this.name = "APIUserAbortError";
  }
}

// Import AFTER mocks so the module under test sees them.
const { callVLM, ScoringError } = await import("../ai-scoring.js");

const validVlmBody = {
  reasoning: {
    sort: "frame 1: only needed items on bench",
    set: "frame 1: tools racked, walkways clear",
    shine: "frame 1: floor clean, no debris",
    standardize: "frame 1: shadow board outlined",
    sustain: "frame 1: today's checklist signed",
  },
  pillar_scores: { sort: 4, set: 4, shine: 4, standardize: 4, sustain: 4 },
  issues: [],
  recommendations: [],
  profile: { items: [], machines: [], layout: [], observedIssues: [], summary: "ok" },
};

function fakeResponse(content: unknown) {
  return {
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
  };
}

const callOpts = {
  framePaths: [],
  areaName: "Line 3",
  machineTag: null,
  learnedProfile: null,
  environmentType: "factory" as const,
};

describe("callVLM transient + JSON retries (Task #203)", () => {
  beforeEach(() => {
    createMock.mockReset();
    insertedRows.length = 0;
    // Tighten the per-attempt timeout so the timeout test resolves fast.
    process.env.VLM_TIMEOUT_MS = "200";
  });

  afterEach(() => {
    createMock.mockReset();
    delete process.env.VLM_TIMEOUT_MS;
  });

  it("records outcome=success / attempts=1 on a clean first try", async () => {
    createMock.mockResolvedValueOnce(fakeResponse(validVlmBody));

    await callVLM(callOpts);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0];
    expect(row.outcome).toBe("success");
    expect(row.jsonAttempts).toBe(1);
    expect(row.transientAttempts).toBe(1);
    expect(row.retried).toBe(false);
    expect(row.validationError).toBeNull();
    expect(typeof row.elapsedMs).toBe("number");
    expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("retries once on transient 5xx then succeeds; counts as transientAttempts=2 + retried=true", async () => {
    createMock
      .mockRejectedValueOnce(new FakeAPIError(503, "service unavailable"))
      .mockResolvedValueOnce(fakeResponse(validVlmBody));

    await callVLM(callOpts);

    expect(createMock).toHaveBeenCalledTimes(2);
    const row = insertedRows[0];
    expect(row.outcome).toBe("success");
    expect(row.jsonAttempts).toBe(1);
    expect(row.transientAttempts).toBe(2);
    expect(row.retried).toBe(true);
    // The first failure isn't a JSON-shape miss, so validationError stays null.
    expect(row.validationError).toBeNull();
  });

  it("retries on connection errors then succeeds", async () => {
    createMock
      .mockRejectedValueOnce(new FakeAPIConnectionError("ECONNRESET"))
      .mockResolvedValueOnce(fakeResponse(validVlmBody));

    await callVLM(callOpts);

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(insertedRows[0].outcome).toBe("success");
    expect(insertedRows[0].transientAttempts).toBe(2);
  });

  it("throws AI_RATE_LIMITED after MAX_TRANSIENT_RETRIES + 1 consecutive 429s", async () => {
    // 4 calls = initial + 3 retries; all 429.
    for (let i = 0; i < 4; i++) {
      createMock.mockRejectedValueOnce(new FakeRateLimitError("rate limited"));
    }

    await expect(callVLM(callOpts)).rejects.toMatchObject({
      name: "ScoringError",
      code: "AI_RATE_LIMITED",
      retryable: true,
    });

    expect(createMock).toHaveBeenCalledTimes(4);
    const row = insertedRows[0];
    expect(row.outcome).toBe("rate_limited");
    expect(row.transientAttempts).toBe(4);
    expect(row.jsonAttempts).toBe(1);
    expect(row.retried).toBe(true);
  });

  it("throws AI_TIMEOUT when every attempt's AbortController fires", async () => {
    // Each call hangs longer than VLM_TIMEOUT_MS so the per-attempt
    // controller aborts. The mock honours the AbortSignal so we can
    // simulate the real fetch-style abort behaviour without relying on
    // wall-clock timing across the whole test.
    createMock.mockImplementation((_body: any, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const err = new FakeAPIUserAbortError();
          reject(err);
        });
      });
    });

    await expect(callVLM(callOpts)).rejects.toMatchObject({
      name: "ScoringError",
      code: "AI_TIMEOUT",
      retryable: true,
    });

    // initial + 3 retries
    expect(createMock).toHaveBeenCalledTimes(4);
    const row = insertedRows[0];
    expect(row.outcome).toBe("timeout");
    expect(row.transientAttempts).toBe(4);
  }, 30_000);

  it("retries up to 3 JSON-validation attempts then throws AI_MALFORMED", async () => {
    // Three responses, none parseable. After the third the loop gives up.
    createMock
      .mockResolvedValueOnce(fakeResponse("not json #1"))
      .mockResolvedValueOnce(fakeResponse("not json #2"))
      .mockResolvedValueOnce(fakeResponse("not json #3"));

    await expect(callVLM(callOpts)).rejects.toMatchObject({
      name: "ScoringError",
      code: "AI_MALFORMED",
      retryable: false,
    });

    expect(createMock).toHaveBeenCalledTimes(3);
    const row = insertedRows[0];
    expect(row.outcome).toBe("malformed");
    expect(row.jsonAttempts).toBe(3);
    expect(row.transientAttempts).toBe(3); // 1 per JSON attempt, all clean upstream
    expect(row.retried).toBe(true);
    expect(row.validationError).toMatch(/JSON/i);
  });

  it("recovers when the first response is malformed but the second is valid", async () => {
    createMock
      .mockResolvedValueOnce(fakeResponse("oops"))
      .mockResolvedValueOnce(fakeResponse(validVlmBody));

    await callVLM(callOpts);

    expect(createMock).toHaveBeenCalledTimes(2);
    const row = insertedRows[0];
    expect(row.outcome).toBe("success");
    expect(row.jsonAttempts).toBe(2);
    expect(row.transientAttempts).toBe(2);
    expect(row.retried).toBe(true);
    // First validation error must be preserved for the dashboard.
    expect(row.validationError).toMatch(/JSON/i);
  });

  it("appends the JSON skeleton to the corrective turn (so later attempts see the full contract)", async () => {
    createMock
      .mockResolvedValueOnce(fakeResponse("nope"))
      .mockResolvedValueOnce(fakeResponse(validVlmBody));

    await callVLM(callOpts);

    const retryReq = createMock.mock.calls[1][0];
    const lastUser = retryReq.messages[retryReq.messages.length - 1];
    expect(lastUser.role).toBe("user");
    // Skeleton mentions every required top-level key.
    for (const k of ["reasoning", "pillar_scores", "issues", "recommendations", "profile"]) {
      expect(lastUser.content).toContain(k);
    }
  });

  it("permanent 4xx (non-429) is NOT retried and surfaces unwrapped", async () => {
    createMock.mockRejectedValueOnce(new FakeAPIError(400, "bad request"));

    // Permanent errors propagate as the original APIError (via the JSON
    // try/catch wrapping it as a ScoringError would defeat debugging).
    await expect(callVLM(callOpts)).rejects.toMatchObject({
      name: "APIError",
      status: 400,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const row = insertedRows[0];
    // Outcome was set to transient_failure in the catch block since this
    // wasn't a ScoringError; the metric still gets written.
    expect(row.outcome).toBe("transient_failure");
    expect(row.transientAttempts).toBe(1);
  });

  it("ScoringError class is exported with the expected shape", () => {
    const e = new ScoringError("AI_TIMEOUT", "boom", true);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ScoringError");
    expect(e.code).toBe("AI_TIMEOUT");
    expect(e.retryable).toBe(true);
    expect(e.message).toBe("boom");
  });
});
