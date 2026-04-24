import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({
      values: async () => undefined,
    }),
  },
  aiScoringMetricsTable: {},
}));

const { callVLM } = await import("../ai-scoring.js");

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

const EXPECTED_REQUEST_KEYS = new Set([
  "model",
  "response_format",
  "max_completion_tokens",
  "top_p",
  "seed",
  "messages",
]);

// Parameters gpt-5 silently rejects (or that we've explicitly chosen not to
// send). If any of these reappear in the request body, the regression that
// took down production in task #168 is back. Keep this list explicit so a
// failure points the reader straight at the offending field.
const FORBIDDEN_PARAMS = [
  "temperature",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "max_tokens", // gpt-5 uses max_completion_tokens, not max_tokens
];

describe("callVLM request payload", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  afterEach(() => {
    createMock.mockReset();
  });

  it("does not send any gpt-5-incompatible parameter on the initial call", async () => {
    createMock.mockResolvedValueOnce(fakeResponse(validVlmBody));

    await callVLM(callOpts);

    expect(createMock).toHaveBeenCalledTimes(1);
    const req = createMock.mock.calls[0][0];

    for (const k of FORBIDDEN_PARAMS) {
      expect(req, `request must NOT include "${k}"`).not.toHaveProperty(k);
    }
  });

  it("sends exactly the documented set of parameters on the initial call", async () => {
    createMock.mockResolvedValueOnce(fakeResponse(validVlmBody));

    await callVLM(callOpts);

    const req = createMock.mock.calls[0][0];

    expect(req.model).toBe("gpt-5-mini");
    expect(req.response_format).toEqual({ type: "json_object" });
    // Must be high enough to cover the gpt-5 family's hidden reasoning tokens AND the
    // structured JSON output — see the comment on `baseRequest` in
    // ai-scoring.ts. A regression to a small cap (e.g. 2048) leaves the
    // entire budget consumed by reasoning, the response body comes back
    // empty, and every submission falls through to the AI-unavailable
    // fallback.
    expect(req.max_completion_tokens).toBe(8192);
    expect(req.top_p).toBe(1);
    expect(req.seed).toBe(5);
    expect(Array.isArray(req.messages)).toBe(true);
    expect(req.messages.length).toBeGreaterThan(0);

    // Lock the surface area: any new top-level field is something a future
    // model rev might not support. Adding one should be a deliberate choice
    // that updates this list (and the EXPECTED_REQUEST_KEYS allowlist).
    const actualKeys = new Set(Object.keys(req));
    for (const k of actualKeys) {
      expect(EXPECTED_REQUEST_KEYS, `unexpected request field "${k}"`).toContain(k);
    }
    for (const k of EXPECTED_REQUEST_KEYS) {
      expect(actualKeys, `missing required request field "${k}"`).toContain(k);
    }
  });

  it("re-uses the same parameter shape on the retry call (no temperature, etc)", async () => {
    // First response: malformed JSON so callVLM enters the retry branch.
    createMock.mockResolvedValueOnce(fakeResponse("not actually json"));
    // Second response: valid so callVLM returns successfully.
    createMock.mockResolvedValueOnce(fakeResponse(validVlmBody));

    await callVLM(callOpts);

    expect(createMock).toHaveBeenCalledTimes(2);

    for (let i = 0; i < 2; i++) {
      const req = createMock.mock.calls[i][0];
      for (const k of FORBIDDEN_PARAMS) {
        expect(req, `call #${i + 1} must NOT include "${k}"`).not.toHaveProperty(k);
      }
      expect(req.model).toBe("gpt-5-mini");
      expect(req.response_format).toEqual({ type: "json_object" });
      expect(req.max_completion_tokens).toBe(8192);
      expect(req.top_p).toBe(1);
      expect(req.seed).toBe(5);
    }

    // Sanity check: the retry's messages array is strictly longer than the
    // initial call's (it appends the assistant reply + a corrective user
    // turn) — proving both code paths actually went through `baseRequest`.
    const firstMessages = createMock.mock.calls[0][0].messages;
    const retryMessages = createMock.mock.calls[1][0].messages;
    expect(retryMessages.length).toBeGreaterThan(firstMessages.length);
  });
});
