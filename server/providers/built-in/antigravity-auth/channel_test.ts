import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  ProviderContext,
} from "cursor-byok:provider";
import type { LlmRequest, ModelEvent } from "cursor-byok:channel";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { antigravityChannel, antigravitySessionId, isQuotaError } from "./channel.ts";
import { antigravityModels, parseAntigravityModels, STATIC_ANTIGRAVITY_MODELS } from "./models.ts";

/** The catalog model Cursor would select for this ID, or a bare model for wire IDs. */
function catalogModel(id: string) {
  return STATIC_ANTIGRAVITY_MODELS.find((model) => model.id === id) ??
    { id, displayName: id, privateData: {} };
}
import { presentAccount, queryAccountQuota, refreshAccount, RESOURCE_TYPE } from "./resources.ts";

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
    contextWindow: null,
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
      model: catalogModel("gemini-4-argon"),
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
      model: catalogModel(modelId),
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

Deno.test("Carbon and Antigravity Claude replay tool calls with matching IDs", async () => {
  const messages: LlmRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: "Read two files" }] },
    {
      role: "assistant",
      text: "",
      thinking: "",
      replayState: null,
      toolCalls: [
        { index: 0, callId: "call_first", name: "read_file", arguments: { path: "a" } },
        { index: 1, callId: "call_second", name: "read_file", arguments: { path: "b" } },
      ],
    },
    {
      role: "tool",
      callId: "call_first",
      name: "read_file",
      content: "a",
      isError: false,
      parts: [],
    },
    {
      role: "tool",
      callId: "call_second",
      name: "read_file",
      content: "b",
      isError: false,
      parts: [],
    },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ];

  for (const model of ["gemini-4-carbon", "claude-sonnet-5-5"]) {
    const { body } = await captureCall(model, { messages });
    const contents = body.request.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const calls = contents[1].parts.map((part) => part.functionCall as Record<string, unknown>);
    const results = contents[2].parts.flatMap((part) =>
      part.functionResponse ? [part.functionResponse as Record<string, unknown>] : []
    );
    assertEquals(calls.map((call) => call.id), ["call_first", "call_second"]);
    assertEquals(results.map((result) => result.id), ["call_first", "call_second"]);
  }
});

Deno.test("Cursor Effort selects the Gemini 4 wire tier", async () => {
  const cases: Array<[string, string | null, string]> = [
    ["gemini-4-neon", "low", "gemini-4-neon-low"],
    ["gemini-4-neon", "medium", "gemini-4-neon-medium"],
    ["gemini-4-neon", "high", "gemini-4-neon-high"],
    ["gemini-4-neon", "xhigh", "gemini-4-neon-xhigh"],
    ["gemini-4-neon", "max", "gemini-4-neon-xhigh"],
    ["gemini-4-hydrogen", "xhigh", "gemini-4-hydrogen-xhigh"],
    ["gemini-4-carbon", "low", "gemini-4-carbon-low"],
    ["gemini-4-carbon", "medium", "gemini-4-carbon-medium"],
    ["gemini-4-carbon", "high", "gemini-4-carbon-high"],
    ["gemini-4-carbon", "max", "gemini-4-carbon-high"],
    ["gemini-4-argon", "xhigh", "gemini-4-argon-high"],
    ["gemini-4-argon", null, "gemini-4-argon-medium"],
    ["claude-opus-5-5", "high", "claude-opus-5-5-high"],
    ["claude-sonnet-5-5", "low", "claude-sonnet-5-5-low"],
  ];
  for (const [model, effort, wire] of cases) {
    const { body } = await captureCall(model, {
      reasoning: { enabled: effort !== null, effort },
    });
    assertEquals(body.model, wire);
  }
});

Deno.test("Fast latency requests priority inference across all Gemini 4 families", async () => {
  for (const model of ["gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon", "gemini-4-argon"]) {
    const fast = await captureCall(model, { latency: "fast" });
    assertEquals(fast.body.request.serviceTier, "SERVICE_TIER_PRIORITY");
    assertEquals(fast.headers["X-Vertex-AI-LLM-Shared-Request-Type"], "priority");
  }

  const other = await captureCall("gemini-3.7-flash-medium", { latency: "fast" });
  assert(!("serviceTier" in other.body.request), "priority was requested on an unverified model");
  assert(!("X-Vertex-AI-LLM-Shared-Request-Type" in other.headers));
});

Deno.test("thinkingConfig, dynamic maxOutputTokens, thoughtsTokenCount, and Claude 5.5 beta headers", async () => {
  const neon = await captureCall("gemini-4-neon", {
    reasoning: { enabled: true, effort: "xhigh" },
    maxOutputTokens: null,
  });
  const neonGen = neon.body.request.generationConfig as Record<string, unknown>;
  assertEquals(neonGen.maxOutputTokens, 262144);
  assertEquals(neonGen.thinkingConfig, { includeThoughts: true });

  const noThink = await captureCall("gemini-4-neon", {
    reasoning: { enabled: false, effort: null },
    maxOutputTokens: 4096,
  });
  const noThinkGen = noThink.body.request.generationConfig as Record<string, unknown>;
  assertEquals(noThinkGen.maxOutputTokens, 4096);
  assert(!("thinkingConfig" in noThinkGen));

  const claude = await captureCall("claude-opus-5-5", {
    reasoning: { enabled: true, effort: "high" },
    maxOutputTokens: null,
  });
  const claudeGen = claude.body.request.generationConfig as Record<string, unknown>;
  assertEquals(claudeGen.maxOutputTokens, 128000);
  assert(
    claude.headers["anthropic-beta"]?.includes("thinking-binding-controls-2026-08-01"),
    `missing v2.34 beta header: ${claude.headers["anthropic-beta"]}`,
  );
});

Deno.test("tool results with image parts forward inlineData alongside functionResponse", async () => {
  const messages: LlmRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: "Take screenshot" }] },
    {
      role: "assistant",
      text: "",
      thinking: "",
      replayState: null,
      toolCalls: [{ index: 0, callId: "call_img", name: "screenshot", arguments: {} }],
    },
    {
      role: "tool",
      callId: "call_img",
      name: "screenshot",
      content: "captured",
      isError: false,
      parts: [
        { type: "text", text: "screen ok" },
        { type: "image", mediaType: "image/png", dataBase64: "iVBORw0=" },
      ],
    },
  ];
  const { body } = await captureCall("gemini-4-neon", { messages });
  const contents = body.request.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  assertEquals(contents[2].parts, [
    { functionResponse: { id: "call_img", name: "screenshot", response: { result: "screen ok" } } },
    { inlineData: { mimeType: "image/png", data: "iVBORw0=" } },
  ]);
});

Deno.test("parseAntigravityModels groups xhigh families via groupedModels, respects sorts, and filters internal helpers", () => {
  const models = parseAntigravityModels({
    defaultAgentModelId: "gemini-4-neon-high",
    agentModelSorts: [
      {
        displayName: "Recommended",
        groups: [
          {
            modelIds: [
              "gemini-4-neon-high",
              "gemini-4-neon-xhigh",
              "claude-opus-5-5-high",
            ],
          },
        ],
      },
    ],
    groupedModels: {
      "gemini-4-neon": {
        displayName: "Gemini 4 Neon",
        supportedThinkingLevels: [
          { thinkingSuffix: "low", thinkingDisplayName: "Low" },
          { thinkingSuffix: "medium", thinkingDisplayName: "Medium" },
          { thinkingSuffix: "high", thinkingDisplayName: "High" },
          { thinkingSuffix: "xhigh", thinkingDisplayName: "Extra High" },
        ],
      },
      "claude-opus-5-5": {
        displayName: "Claude Opus 5.5",
        supportedThinkingLevels: [
          { thinkingSuffix: "low", thinkingDisplayName: "Low" },
          { thinkingSuffix: "medium", thinkingDisplayName: "Medium" },
          { thinkingSuffix: "high", thinkingDisplayName: "High" },
        ],
      },
    },
    models: {
      "gemini-4-neon-low": { displayName: "Gemini 4 Neon (Low)", maxTokens: 1048576, maxOutputTokens: 262144, tagDescription: "Deep reasoning" },
      "gemini-4-neon-medium": { displayName: "Gemini 4 Neon (Medium)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-neon-high": { displayName: "Gemini 4 Neon (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-neon-xhigh": { displayName: "Gemini 4 Neon (XHigh)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "claude-opus-5-5-low": { displayName: "Claude Opus 5.5 (Low)", maxTokens: 1000000, maxOutputTokens: 128000 },
      "claude-opus-5-5-medium": { displayName: "Claude Opus 5.5 (Medium)", maxTokens: 1000000, maxOutputTokens: 128000 },
      "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 (High)", maxTokens: 1000000, maxOutputTokens: 128000 },
      "tab_flash_lite_preview": { displayName: "" },
      "gemini-4-hydrogen-tiered-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)" },
      "gemini-4-hydrogen-sonar": { displayName: "" },
    },
  });
  const ids = models.map((m) => m.id);
  assertEquals(ids[0], "gemini-4-neon");
  assertEquals(ids[1], "claude-opus-5-5");
  assert(!ids.includes("gemini-4-neon-xhigh"), "xhigh must collapse into family");
  assert(!ids.includes("tab_flash_lite_preview"), "tab helper must be filtered");
  assert(!ids.includes("gemini-4-hydrogen-tiered-xhigh"), "tiered helper must be filtered");
  assert(!ids.includes("gemini-4-hydrogen-sonar"), "sonar helper must be filtered");
  const neon = models[0];
  assertEquals(neon.options, { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high", fast: true });
  assertEquals(neon.maxOutputTokens, 262144);
  assertEquals(neon.contextWindow, 1_048_576);
  const opus = models[1];
  assertEquals(opus.options, { efforts: ["low", "medium", "high"] });
  assertEquals(opus.contextWindow, 1_000_000);
  assertEquals(opus.maxOutputTokens, 128_000);
});

Deno.test("thoughtsTokenCount maps to reasoningTokens in usage event", async () => {
  const events: ModelEvent[] = [];
  await antigravityChannel.invoke(
    {
      model: catalogModel("gemini-4-neon"),
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
      stream: () => ({
        status: 200,
        headers: {},
        lines: sse([
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"391"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":5,"thoughtsTokenCount":120,"totalTokenCount":175}}}',
        ]),
      }),
    }),
  );
  const usageEvent = events.find((e) => e.type === "usage");
  assert(usageEvent?.type === "usage");
  assertEquals(usageEvent.usage.reasoningTokens, 120);
});

Deno.test("queryAccountQuota reads 5h and weekly buckets from retrieveUserQuotaSummary", async () => {
  const result = await queryAccountQuota("token", context({
    fetch: (url) => {
      if (url.includes("retrieveUserQuotaSummary")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [
                  { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8, resetTime: "2026-11-24T06:00:00Z" },
                  { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.87, resetTime: "2026-11-30T20:00:00Z" },
                ],
              },
              {
                displayName: "Claude and GPT models",
                buckets: [
                  { bucketId: "3p-5h", window: "5h", remainingFraction: 1.0, resetTime: "2026-11-24T11:00:00Z" },
                  { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.17, resetTime: "2026-11-25T02:00:00Z" },
                ],
              },
            ],
          }),
        };
      }
      if (url.includes("loadCodeAssist")) {
        return { status: 200, headers: {}, body: JSON.stringify({ cloudaicompanionProject: "p1", paidTier: { name: "Google AI Ultra" } }) };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ models: {} }) };
    },
  }).network);
  assertEquals(result.quota?.planLabel, "ULTRA");
  assertEquals(result.quota?.gemini?.remainingPercent, 80);
  assertEquals(result.quota?.geminiWeekly?.remainingPercent, 87);
  assertEquals(result.quota?.claude?.remainingPercent, 100);
  assertEquals(result.quota?.claudeWeekly?.remainingPercent, 17);
  const view = presentAccount(snapshot({ accessToken: "t", refreshToken: null, displayName: "u@e.com", quota: result.quota }));
  assertEquals(view.metrics?.map((m) => [m.id, m.value]), [
    ["claude", 100],
    ["claude-weekly", 17],
    ["gemini", 80],
    ["gemini-weekly", 87],
  ]);
});

Deno.test("sessionId is stable per cacheKey and omitted without one", async () => {
  assertEquals(await antigravitySessionId("conv-1"), await antigravitySessionId("conv-1"));
  assert((await antigravitySessionId("conv-1")) !== (await antigravitySessionId("conv-2")));
  const { body } = await captureCall("gemini-4-carbon", { cacheKey: null });
  assert(!("sessionId" in body.request), "sessionId was sent without a cacheKey");
});

Deno.test("tier siblings collapse into one model whose Effort picks the tier", () => {
  const models = parseAntigravityModels({
    models: {
      "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)" },
      "gemini-4-carbon-low": { displayName: "Gemini 4 Carbon (Low)" },
      "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)" },
      "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", supportsThinking: true },
      "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" },
    },
  });
  const ids = models.map((model) => model.id);
  assert(!ids.some((id) => /^gemini-.*-(low|medium|high)$/.test(id)), `tiered IDs leaked: ${ids}`);
  const carbon = models.find((model) => model.id === "gemini-4-carbon");
  assertEquals(carbon?.displayName, "Gemini 4 Carbon");
  assertEquals(carbon?.options, { efforts: ["low", "medium", "high"], fast: true });
  assertEquals(carbon?.privateData, { tiers: ["low", "medium", "high"] });
  const flash = models.find((model) => model.id === "gemini-3.8-flash");
  assertEquals(flash?.options, { efforts: ["low", "medium", "high"] });
  assert(ids.includes("gemini-4-argon"));
  assertEquals(models.find((model) => model.id === "gemini-2.5-pro")?.options, undefined);
});

Deno.test("isQuotaError identifies rate limits and quota exhaustion", () => {
  assert(isQuotaError("RESOURCE_EXHAUSTED: quota exceeded"));
  assert(isQuotaError("Rate limit exceeded for model"));
  assert(isQuotaError("HTTP 429 Too Many Requests"));
  assert(!isQuotaError("Invalid authorization header"));
});

async function blockedEvents(lines: string[]): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  const result = await antigravityChannel.invoke(
    {
      model: catalogModel("gemini-4-hydrogen"),
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
      stream: () => ({ status: 200, headers: {}, lines: sse(lines) }),
    }),
  );
  assertEquals(result, { status: "completed" });
  return events;
}

Deno.test("a prompt block feedback finishes the call as a refusal", async () => {
  const events = await blockedEvents([
    'data: {"response":{"promptFeedback":{"blockReason":"OTHER","blockReasonMessage":"This request was blocked by Gemini\'s filters."}}}',
  ]);
  assertEquals(events, [
    {
      type: "done",
      reason: "refusal",
      category: "other",
      explanation: "This request was blocked by Gemini's filters.",
    },
  ]);
});

Deno.test("a policy finish reason finishes the call as a refusal", async () => {
  const events = await blockedEvents([
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Partial answer"}]}}]}}',
    'data: {"response":{"candidates":[{"finishReason":"SAFETY"}]}}',
  ]);
  assertEquals(events, [
    { type: "text-start" },
    { type: "text-delta", text: "Partial answer" },
    { type: "text-end" },
    { type: "done", reason: "refusal", category: "safety", explanation: null },
  ]);
});

Deno.test("a stream with neither text nor tools finishes the call as a refusal", async () => {
  const events = await blockedEvents(['data: {"response":{"candidates":[{"content":{}}]}}']);
  assertEquals(events, [
    { type: "done", reason: "refusal", category: "empty-response", explanation: null },
  ]);
});

Deno.test("a normal stop stays a stop", async () => {
  const events = await blockedEvents([
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Here is the fix."}]},"finishReason":"STOP"}]}}',
  ]);
  assertEquals(events, [
    { type: "text-start" },
    { type: "text-delta", text: "Here is the fix." },
    { type: "text-end" },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("an empty STOP finishes as a refusal", async () => {
  const events = await blockedEvents([
    'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}',
  ]);
  assertEquals(events, [
    { type: "done", reason: "refusal", category: "empty-response", explanation: null },
  ]);
});

Deno.test("thinking without an answer finishes as a refusal", async () => {
  for (const finish of [[], ['data: {"response":{"candidates":[{"finishReason":"STOP"}]}}']]) {
    const events = await blockedEvents([
      'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking"}]}}]}}',
      ...finish,
    ]);
    assertEquals(events, [
      { type: "thinking-start" },
      { type: "thinking-delta", text: "Thinking" },
      { type: "thinking-end" },
      { type: "done", reason: "refusal", category: "empty-response", explanation: null },
    ]);
  }
});

Deno.test("a tool-only response stays a tool round", async () => {
  for (const finish of [[], ['data: {"response":{"candidates":[{"finishReason":"STOP"}]}}']]) {
    const events = await blockedEvents([
      'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"id":"toolu_existing","name":"read_file","args":{"path":"test.txt"}}}]}}]}}',
      ...finish,
    ]);
    assertEquals(
      events.find((event) => event.type === "tool-call-start")?.callId,
      "toolu_existing",
    );
    assertEquals(events.at(-1), { type: "done", reason: "tool-use" });
  }
});

Deno.test("parseAntigravityModels skips disabled model entries", () => {
  const models = parseAntigravityModels({
    models: {
      "gemini-4-hydrogen-disabled": { displayName: "Gemini 4 Hydrogen" },
      "gemini-4-argon-disabled": { displayName: "Gemini 4 Argon" },
      "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6" },
    },
  });
  const ids = models.map((model) => model.id);
  assert(!ids.includes("gemini-4-hydrogen-disabled"));
  assert(!ids.includes("gemini-4-argon-disabled"));
  assert(!ids.includes("gemini-4-argon"));
  assert(ids.includes("claude-sonnet-4-6"));
});

Deno.test("404 NOT_FOUND returns resource-error for multi-account failover", async () => {
  const result = await antigravityChannel.invoke(
    {
      model: catalogModel("gemini-4-hydrogen-xhigh"),
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: () => ({
        status: 404,
        headers: {},
        lines: sse(['{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}']),
      }),
    }),
  );
  assertEquals(result.status, "resource-error");
  assertEquals("patch" in result ? result.patch : undefined, {});
});

Deno.test("disabledModels short-circuits with resource-error without calling network", async () => {
  let called = false;
  const result = await antigravityChannel.invoke(
    {
      model: catalogModel("gemini-4-hydrogen-xhigh"),
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        displayName: "free-user@example.com",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
        disabledModels: ["gemini-4-hydrogen"],
      }),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: () => {
        called = true;
        throw new Error("should not call stream for disabled model");
      },
    }),
  );
  assert(!called);
  assertEquals(result.status, "resource-error");
  assertEquals("patch" in result ? result.patch : undefined, {});
});

Deno.test("a refreshed request is classified by its own failure and keeps fresh credentials", async () => {
  for (const status of [401, 403, 404, 429, 400]) {
    let refreshes = 0;
    let initialCalls = 0;
    const result = await antigravityChannel.invoke(
      {
        model: catalogModel("gemini-4-hydrogen"),
        resource: snapshot({
          accessToken: "old-token",
          refreshToken: "refresh-token",
          expiresAtMs: Date.now() + 3600_000,
        }),
        request: request(),
      },
      { emit: () => {} },
      context({
        fetch: (url) => {
          if (url.endsWith("/token")) {
            refreshes++;
            return { status: 200, headers: {}, body: '{"access_token":"fresh-token"}' };
          }
          return { status: 200, headers: {}, body: '{"models":{}}' };
        },
        stream: (_url, init) => {
          if (init?.headers?.authorization === "Bearer old-token") {
            initialCalls++;
            return { status: 401, headers: {}, lines: sse(["Unauthorized"]) };
          }
          assertEquals(init?.headers?.authorization, "Bearer fresh-token");
          return { status, headers: {}, lines: sse([`failure ${status}`]) };
        },
      }),
    );
    assertEquals(refreshes, 1);
    assert(initialCalls > 0);
    assertEquals(result.status, status === 400 ? "request-error" : "resource-error");
    assertEquals((result.patch?.privateData as Record<string, JsonValue>)?.accessToken, "fresh-token");
    if (status === 401) assertEquals(result.patch?.state?.status, "invalid");
    else assert(result.patch?.state?.status !== "invalid");
    if (status === 429) assertEquals(result.patch?.state?.status, "cooling");
  }
});

Deno.test("revoked credentials invalidate an account after a 401", async () => {
  const result = await antigravityChannel.invoke(
    {
      model: catalogModel("gemini-4-hydrogen"),
      resource: snapshot({ accessToken: "old-token", refreshToken: "revoked-token" }),
      request: request(),
    },
    { emit: () => {} },
    context({
      fetch: () => ({ status: 400, headers: {}, body: '{"error":"invalid_grant"}' }),
      stream: () => ({ status: 401, headers: {}, lines: sse(["Unauthorized"]) }),
    }),
  );
  assertEquals(result.status, "resource-error");
  assertEquals(result.patch?.state?.status, "invalid");
});

Deno.test("failed catalog discovery retains known disabled model families", async () => {
  const resource = snapshot({ accessToken: "token", disabledModels: ["gemini-4-argon"] });
  const models = await antigravityModels.list({ resource }, context({
    fetch: () => ({ status: 503, headers: {}, body: "Unavailable" }),
  }));
  assert(models.length > 0);
  assert(!models.some((model) => model.id.startsWith("gemini-4-argon")));
});

Deno.test("quota calculations ignore disabled entries and record disabled families", async () => {
  const result = await queryAccountQuota("token", context({
    fetch: () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ models: {
        "gemini-4-argon-disabled": { quotaInfo: { remainingFraction: 0 } },
        "gemini-4-hydrogen": { quotaInfo: { remainingFraction: 0.8 } },
      } }),
    }),
  }).network);
  assertEquals(result.disabledModels, ["gemini-4-argon"]);
  assertEquals(result.quota?.gemini?.remainingPercent, 80);
});

Deno.test("refresh preserves known disabled models when quota discovery is unavailable", async () => {
  const patch = await refreshAccount(
    snapshot({ accessToken: "token", disabledModels: ["gemini-4-argon"] }),
    context({ fetch: () => ({ status: 503, headers: {}, body: "Unavailable" }) }),
  );
  assertEquals((patch.privateData as Record<string, JsonValue>).disabledModels, ["gemini-4-argon"]);
});
