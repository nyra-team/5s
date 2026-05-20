import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

// callIdentificationVLM now resolves the model via loadEffectiveVlmModel,
// which reads ai_settings (single-row select). Stub the chain to return no
// rows so the resolver falls through to the shipped default ("gpt-5-mini").
interface SelectChain extends PromiseLike<unknown[]> {
  from: () => SelectChain;
  orderBy: () => SelectChain;
  limit: () => SelectChain;
}
function emptySelectChain(): SelectChain {
  const chain: SelectChain = {
    from: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (onfulfilled) =>
      Promise.resolve([]).then(onfulfilled) as unknown as PromiseLike<never>,
  };
  return chain;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: () => emptySelectChain(),
  },
  aiScoringMetricsTable: {},
  aiSettingsTable: {},
}));

const { callIdentificationVLM } = await import("../ai-identification.js");

const validIdentificationBody = {
  candidates: [{ areaId: 1, confidence: 0.8 }],
  rationale: "frame shows the bench layout for area 1",
};

function fakeResponse(content: unknown) {
  return {
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
  };
}

const profiles = [
  {
    areaId: 1,
    areaName: "Line 3",
    summary: "bench area",
    items: ["wrench"],
    machines: ["press"],
    layout: ["shadow board on west wall"],
  },
];

let tmpFramePath: string;

beforeEach(() => {
  createMock.mockReset();
  // callIdentificationVLM filters frames through fs.existsSync and reads
  // them via fs.readFileSync, so we need a real file on disk.
  tmpFramePath = path.join(os.tmpdir(), `ai-identification-test-${Date.now()}.jpg`);
  fs.writeFileSync(tmpFramePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});

afterEach(() => {
  createMock.mockReset();
  if (tmpFramePath && fs.existsSync(tmpFramePath)) {
    fs.unlinkSync(tmpFramePath);
  }
});

// Required keys must always be present; response_format is only sent
// when the active model is gpt-5 family. Anthropic's OpenAI-compat
// endpoint rejects `response_format: json_object`, so we omit it for
// claude-* models and rely on the JSON-parse path + fence strip.
const REQUIRED_REQUEST_KEYS = new Set([
  "model",
  "max_completion_tokens",
  "messages",
]);
const OPTIONAL_REQUEST_KEYS = new Set(["response_format"]);
const ALL_REQUEST_KEYS = new Set([...REQUIRED_REQUEST_KEYS, ...OPTIONAL_REQUEST_KEYS]);

// Parameters gpt-5 silently rejects (or that we've explicitly chosen not to
// send). Mirrors the FORBIDDEN_PARAMS list in ai-scoring-vlm-request.test.ts —
// if any of these reappear in the area-identification request body, every
// operator's auto-detect suggestion will silently fall back to "unknown" the
// same way scoring did in production before task #168.
const FORBIDDEN_PARAMS = [
  "temperature",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "max_tokens", // gpt-5 uses max_completion_tokens, not max_tokens
];

describe("callIdentificationVLM request payload", () => {
  it("does not send any gpt-5-incompatible parameter", async () => {
    createMock.mockResolvedValueOnce(fakeResponse(validIdentificationBody));

    await callIdentificationVLM([tmpFramePath], profiles);

    expect(createMock).toHaveBeenCalledTimes(1);
    const req = createMock.mock.calls[0][0];

    for (const k of FORBIDDEN_PARAMS) {
      expect(req, `request must NOT include "${k}"`).not.toHaveProperty(k);
    }
  });

  it("sends exactly the documented set of parameters", async () => {
    createMock.mockResolvedValueOnce(fakeResponse(validIdentificationBody));

    await callIdentificationVLM([tmpFramePath], profiles);

    const req = createMock.mock.calls[0][0];

    expect(req.model).toBe("gpt-5-mini");
    expect(req.response_format).toEqual({ type: "json_object" });
    expect(req.max_completion_tokens).toBe(1024);
    expect(Array.isArray(req.messages)).toBe(true);
    expect(req.messages.length).toBeGreaterThan(0);

    // Lock the surface area: any new top-level field is something a future
    // model rev might not support. Adding one should be a deliberate choice
    // that updates ALL_REQUEST_KEYS. Required keys must all be present;
    // response_format is optional (absent for Claude).
    const actualKeys = new Set(Object.keys(req));
    for (const k of actualKeys) {
      expect(ALL_REQUEST_KEYS, `unexpected request field "${k}"`).toContain(k);
    }
    for (const k of REQUIRED_REQUEST_KEYS) {
      expect(actualKeys, `missing required request field "${k}"`).toContain(k);
    }
  });
});
