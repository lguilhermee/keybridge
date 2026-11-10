import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  ProviderContext,
} from "cursor-byok:provider";
import type { LlmRequest, ModelEvent } from "cursor-byok:channel";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { antigravityChannel, antigravitySessionId, isQuotaError } from "./channel.ts";
import { parseAntigravityModels } from "./models.ts";
import { RESOURCE_TYPE } from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

type RequestInit = { body?: string; headers?: Record<string, string> };
type FetchHandler = (url: string, init?: RequestInit) => NetworkResponse;
type StreamHandler = (url: string, init?: RequestInit) => NetworkEventStream;

function context(handlers: { fetch?: FetchHandler; stream?: StreamHandler }): ProviderContext {
  return {
    network: {
      streamBytes: () => Promise.reject(new Error("binary stream was not expected")),
      fetch: (url, init) => {
        if (!handlers.fetch) throw new Error("fetch was not expected");
        return Promise.resolve(handlers.fetch(url, init));
      },
      stream: (url, init) => {
        if (!handlers.stream) throw new Error("stream was not expected");
        return Promise.resolve(handlers.stream(url, init));
      },
    },
    signal: new AbortController().signal,
  };
}

function snapshot(privateData: JsonValue): ResourceSnapshot {
  return {
    id: "resource-1",
    type: RESOURCE_TYPE,
    key: "antigravity:user-1",
    privateData,
    state: { status: "ready" },
  };
}

async function* sse(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function request(): LlmRequest {
  return {
    instructions: "You are an AI coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "medium" },
    latency: "standard",
    maxOutputTokens: 65536,
    cacheKey: "conv-1",
  };
}

Deno.test("provider parses usage metadata including cachedContentTokenCount as cacheReadTokens", async () => {
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];

  const result = await antigravityChannel.invoke(
    {
      model: {
        id: "gemini-3.7-flash-medium",
        displayName: "Gemini 3.7 Flash Medium",
        privateData: {},
      },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: (url, init) => {
        assert(url.includes("/v1internal:streamGenerateContent?alt=sse"));
        requestBody = init?.body ?? "";
        requestHeaders = init?.headers ?? {};
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}}',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}}',
            'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":15,"totalTokenCount":135,"cachedContentTokenCount":80}}}',
          ]),
        };
      },
    }),
  );

  assertEquals(result, { status: "completed" });
  assertEquals(requestHeaders["authorization"], "Bearer mock-access-token");
  assertEquals(requestHeaders.accept, "text/event-stream");
  assert(!("session-id" in requestHeaders), "Codex-only session-id header was sent");
  assert(!("thread-id" in requestHeaders), "Codex-only thread-id header was sent");
  assert(!("x-client-request-id" in requestHeaders), "request-id header was reused as cache key");
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.project, "test-project-123");
  assertEquals(body.model, "gemini-3.7-flash-medium");
  assert(!("sessionId" in body), "sessionId must live inside request, not at the top level");
  assert(!("conversationId" in body), "unsupported conversationId field was sent");
  const inner = body.request as Record<string, unknown>;
  assertEquals(inner.sessionId, await antigravitySessionId("conv-1"));
  assert(/^\d+$/.test(String(inner.sessionId)), "sessionId is not a decimal string");
  assert(!("serviceTier" in inner), "standard latency requested a service tier");
  assert(
    !("X-Vertex-AI-LLM-Shared-Request-Type" in requestHeaders),
    "standard latency sent the priority header",
  );

  assertEquals(events, [
    { type: "thinking-start" },
    { type: "thinking-delta", text: "Thinking..." },
    { type: "thinking-end" },
    { type: "text-start" },
    { type: "text-delta", text: "Hello world" },
    { type: "text-end" },
    {
      type: "usage",
      usage: {
        inputTokens: 40,
        outputTokens: 15,
        totalTokens: 135,
        cacheReadTokens: 80,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("Gemini 4 Argon resolves to the medium tier and omits toolConfig", async () => {
  let requestBody = "";
  const argonRequest: LlmRequest = {
    ...request(),
    tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
  };

  await antigravityChannel.invoke(
    {
      model: { id: "gemini-4-argon", displayName: "Gemini 4 Argon", privateData: {} },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: argonRequest,
    },
    { emit: () => {} },
    context({
      stream: (_url, init) => {
        requestBody = init?.body ?? "";
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}',
          ]),
        };
      },
    }),
  );

  const body = JSON.parse(requestBody) as { model: string; request: Record<string, unknown> };
  assertEquals(body.model, "gemini-4-argon-medium");
  assert(Array.isArray(body.request.tools), "tools were not sent");
  assert(!("toolConfig" in body.request), "toolConfig was sent for Argon");
});

type CapturedCall = {
  body: { model: string; request: Record<string, unknown> };
  headers: Record<string, string>;
};

async function captureCall(modelId: string, overrides: Partial<LlmRequest>): Promise<CapturedCall> {
  let requestBody = "";
  let headers: Record<string, string> = {};
  await antigravityChannel.invoke(
    {
      model: { id: modelId, displayName: modelId, privateData: {} },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: { ...request(), ...overrides },
    },
    { emit: () => {} },
    context({
      stream: (_url, init) => {
        requestBody = init?.body ?? "";
        headers = init?.headers ?? {};
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}',
          ]),
        };
      },
    }),
  );
  return { body: JSON.parse(requestBody), headers };
}

Deno.test("Cursor Effort selects the Gemini 4 wire tier", async () => {
  const cases: Array<[string, string | null, string]> = [
    ["gemini-4-carbon", "low", "gemini-4-carbon-low"],
    ["gemini-4-carbon", "medium", "gemini-4-carbon-medium"],
    ["gemini-4-carbon", "high", "gemini-4-carbon-high"],
    ["gemini-4-carbon", "max", "gemini-4-carbon-high"],
    ["gemini-4-argon", "xhigh", "gemini-4-argon-high"],
    ["gemini-4-argon", null, "gemini-4-argon-medium"],
  ];
  for (const [model, effort, wire] of cases) {
    const { body } = await captureCall(model, {
      reasoning: { enabled: effort !== null, effort },
    });
    assertEquals(body.model, wire);
  }
});

Deno.test("Fast latency requests priority inference only on Gemini 4", async () => {
  const fast = await captureCall("gemini-4-argon", { latency: "fast" });
  assertEquals(fast.body.request.serviceTier, "SERVICE_TIER_PRIORITY");
  assertEquals(fast.headers["X-Vertex-AI-LLM-Shared-Request-Type"], "priority");

  const other = await captureCall("gemini-3.7-flash-medium", { latency: "fast" });
  assert(!("serviceTier" in other.body.request), "priority was requested on an unverified model");
  assert(!("X-Vertex-AI-LLM-Shared-Request-Type" in other.headers));
});

Deno.test("sessionId is stable per cacheKey and omitted without one", async () => {
  assertEquals(await antigravitySessionId("conv-1"), await antigravitySessionId("conv-1"));
  assert((await antigravitySessionId("conv-1")) !== (await antigravitySessionId("conv-2")));
  const { body } = await captureCall("gemini-4-carbon", { cacheKey: null });
  assert(!("sessionId" in body.request), "sessionId was sent without a cacheKey");
});

Deno.test("tiered Gemini 4 upstream IDs collapse into one model per family", () => {
  const models = parseAntigravityModels({
    models: {
      "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)" },
      "gemini-4-carbon-low": { displayName: "Gemini 4 Carbon (Low)" },
      "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)" },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", supportsThinking: true },
    },
  });
  const ids = models.map((model) => model.id);
  assert(!ids.some((id) => /^gemini-4-(carbon|argon)-/.test(id)), `tiered IDs leaked: ${ids}`);
  const carbon = models.find((model) => model.id === "gemini-4-carbon");
  assertEquals(carbon?.privateData, { reasoningEfforts: ["low", "medium", "high"] });
  assert(ids.includes("gemini-4-argon"));
  assert(ids.includes("gemini-3.8-flash-high"));
});

Deno.test("isQuotaError identifies rate limits and quota exhaustion", () => {
  assert(isQuotaError("RESOURCE_EXHAUSTED: quota exceeded"));
  assert(isQuotaError("Rate limit exceeded for model"));
  assert(isQuotaError("HTTP 429 Too Many Requests"));
  assert(!isQuotaError("Invalid authorization header"));
});
