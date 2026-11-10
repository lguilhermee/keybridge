import { laneForModel, opencodeModels } from "./models.ts";
import {
  applyFingerprint,
  freeModels,
  generateSessionId,
  isFreeModelId,
  opencodeFreeChannel,
  sessionFor,
} from "./free.ts";
import { opencodeChannel, sessionId } from "./channel.ts";
import {
  type AccountData,
  authHeaders,
  credentialImport,
  isOpenCodeQuotaError,
  MODELS_URL,
  OPENCODE_SESSION_RE,
  parseCredentials,
  parseOpenCodeUsage,
  parseResetHintMs,
  presentAccount,
  quotaState,
  USAGE_URL,
} from "./resources.ts";
import type { ProviderContext } from "cursor-byok:provider";
import type { LlmRequest, ModelEvent } from "cursor-byok:channel";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function* lineStream(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function context(overrides: Partial<ProviderContext["network"]> = {}): ProviderContext {
  return {
    signal: new AbortController().signal,
    network: {
      fetch: () => Promise.reject(new Error("fetch is not used")),
      stream: () => Promise.reject(new Error("stream is not used")),
      streamBytes: () => Promise.reject(new Error("streamBytes is not used")),
      ...overrides,
    },
  };
}

function account(): AccountData {
  return {
    apiKey: "sk-oc-test-key-1234",
    displayName: "OpenCode Go (...1234)",
    planLabel: "OpenCode Go",
  };
}

function resource(data: AccountData = account()) {
  return {
    id: "r1",
    type: "opencode-account",
    key: "opencode-go:...1234",
    privateData: data,
    state: { status: "ready" as const },
  };
}

function request(): LlmRequest {
  return {
    instructions: "Test instructions",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    reasoning: { enabled: false, effort: null },
    latency: "standard",
    maxOutputTokens: 128,
    contextWindow: null,
    cacheKey: "conv-1",
  };
}

Deno.test("Credential import parses flat JSON, account.json, and raw keys", () => {
  equal(parseCredentials("key.json", '{"key": "sk-oc-a"}'), ["sk-oc-a"]);
  equal(parseCredentials("key.json", '{"apiKey": "sk-oc-b"}'), ["sk-oc-b"]);
  equal(
    parseCredentials(
      "account.json",
      JSON.stringify({
        accounts: {
          a: { serviceID: "opencode-go", credential: { type: "api", key: "sk-oc-go" } },
          b: { serviceID: "local", credential: { type: "api", key: "sk-local" } },
          c: { serviceID: "zen", credential: { type: "api", key: "sk-oc-zen" } },
        },
      }),
    ).sort(),
    ["sk-oc-go", "sk-oc-zen"],
  );
  equal(parseCredentials("key.txt", "sk-oc-raw"), ["sk-oc-raw"]);
  let failed = false;
  try {
    parseCredentials("empty.txt", "   ");
  } catch {
    failed = true;
  }
  assert(!failed, "empty txt returns no keys instead of throwing");
  failed = false;
  try {
    parseCredentials("bad.txt", "not a key");
  } catch (error) {
    failed = String(error).includes("API key");
  }
  assert(failed, "whitespace-bearing txt should be rejected");
});

Deno.test("Usage parsing maps percent-used to remaining with cooling", () => {
  const now = Date.now();
  const quota = parseOpenCodeUsage({
    usage: {
      rolling: { percent: 25, resetsAt: new Date(now + 600_000).toISOString() },
      weekly: { percent: 100, resetsAt: new Date(now + 86_400_000).toISOString() },
      monthly: { percent: 60 },
    },
  }, now)!;
  equal(quota.rolling?.remainingPercent, 75);
  equal(quota.weekly?.remainingPercent, 0);
  equal(quota.monthly?.remainingPercent, 40);
  equal(quota.limitReached, true);
  const state = quotaState(quota, now);
  equal(state.status, "cooling");
  equal((state as { retryAtMs?: number }).retryAtMs, now + 86_400_000);
  equal(parseOpenCodeUsage({ usage: {} }, now), null);
  equal(parseOpenCodeUsage({}, now), null);
});

Deno.test("Reset hints and quota-error classification", () => {
  const now = 1_000_000;
  equal(
    parseResetHintMs('{"resetsAt":"2026-10-12T20:00:00Z"}', now),
    Date.parse("2026-10-12T20:00:00Z"),
  );
  equal(parseResetHintMs("retry-after: 45", now), now + 45_000);
  assert(isOpenCodeQuotaError("HTTP 429: rate limit exceeded"), "429 text");
  assert(isOpenCodeQuotaError("Quota exceeded"), "quota text");
  assert(!isOpenCodeQuotaError("HTTP 400: bad request"), "400 is not quota");
});

Deno.test("Import validates the key against the usage endpoint", async () => {
  let ok = 0;
  const ctx = context({
    fetch: async (url, init) => {
      assert(url === USAGE_URL, `unexpected URL ${url}`);
      assert(
        init?.headers?.authorization === "Bearer sk-oc-good",
        "usage probe must authenticate",
      );
      ok++;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          usage: { weekly: { percent: 40, resetsAt: null } },
        }),
      };
    },
  });
  const result = await credentialImport.parse(
    [{ name: "key.json", content: '{"key":"sk-oc-good"}' }],
    ctx,
  );
  equal(result.resources.length, 1);
  equal(result.resources[0].key, "opencode-go:...good");
  const data = result.resources[0].privateData as AccountData;
  equal(data.displayName, "OpenCode Go (...good)");
  equal(data.quota?.weekly?.remainingPercent, 60);
  assert(ok === 1, "usage probe should run once");

  const denied = context({
    fetch: async () => ({
      status: 401,
      headers: {},
      body: '{"error":{"message":"invalid"}}',
    }),
  });
  let rejected = false;
  try {
    await credentialImport.parse(
      [{ name: "key.json", content: '{"key":"sk-oc-bad"}' }],
      denied,
    );
  } catch (error) {
    rejected = String(error).includes("Invalid OpenCode API key");
  }
  assert(rejected, "401 from usage should reject the key");
});

Deno.test("Lane routing follows the model family", () => {
  equal(laneForModel("kimi-k3"), "chat");
  equal(laneForModel("glm-5.3-flash"), "chat");
  equal(laneForModel("grok-4.7"), "responses");
  equal(laneForModel("gpt-6-luna"), "responses");
  equal(laneForModel("muse-spark-1.3"), "responses");
  equal(laneForModel("unknown-model"), "chat");
});

Deno.test("Model list prefers the live catalog, falls back to curated", async () => {
  const withResource = context({
    fetch: async (url) => {
      assert(url === MODELS_URL, `unexpected URL ${url}`);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: [{ id: "kimi-k3" }, { id: "grok-4.7" }, "new-model-9"],
        }),
      };
    },
  });
  const live = await opencodeModels.list({ resource: resource() }, withResource);
  equal(live.map((model) => model.id), ["kimi-k3", "grok-4.7", "new-model-9"]);
  equal(
    (live[1].privateData as { lane: string }).lane,
    "responses",
  );
  const fallback = await opencodeModels.list({ resource: null }, context());
  assert(
    fallback.some((model) => model.id === "kimi-k3"),
    "curated catalog must include kimi",
  );
  assert(
    fallback.every((model) => model.id.length > 0),
    "curated catalog must be non-empty ids",
  );
});

Deno.test("Session id matches the official client shape", async () => {
  const a = await sessionId("conv-1");
  const b = await sessionId("conv-1");
  const c = await sessionId("conv-2");
  assert(OPENCODE_SESSION_RE.test(a), `bad session shape: ${a}`);
  equal(a, b);
  assert(a !== c, "different conversations get different sessions");
});

Deno.test("Provider streams chat SSE with the opencode client headers", async () => {
  const events: ModelEvent[] = [];
  let captured: Record<string, string> | null = null;
  const result = await opencodeChannel.invoke(
    {
      model: { id: "kimi-k3", displayName: "Kimi K3", privateData: { lane: "chat" } },
      resource: resource(),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: async (url, init) => {
        assert(
          url === "https://opencode.ai/zen/go/v1/chat/completions",
          `unexpected URL ${url}`,
        );
        captured = init?.headers ?? null;
        return {
          status: 200,
          headers: {},
          lines: lineStream([
            'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
            "data: [DONE]",
          ]),
        };
      },
    }),
  );
  equal(result.status, "completed");
  assert(captured !== null, "headers should be captured");
  const headers = captured as unknown as Record<string, string>;
  equal(headers.authorization, "Bearer sk-oc-test-key-1234");
  equal(headers["x-opencode-client"], "desktop");
  equal(headers["user-agent"], "opencode/1.18.31");
  assert(
    OPENCODE_SESSION_RE.test(headers["x-opencode-session"]),
    "session header must match ses_ shape",
  );
  equal(events.map((event) => event.type), [
    "text-start",
    "text-delta",
    "text-end",
    "usage",
    "done",
  ]);
});

Deno.test("Provider maps Cursor effort aliases into Zen's thinking tiers", async () => {
  for (
    const [given, expected] of [
      ["xhigh", "max"],
      ["medium", "high"],
      ["minimal", "low"],
    ]
  ) {
    let capturedEffort: unknown = null;
    await opencodeChannel.invoke(
      {
        model: {
          id: "glm-5.3-flash",
          displayName: "GLM 5.3 Flash",
          privateData: { lane: "chat" },
        },
        resource: resource(),
        request: {
          ...request(),
          reasoning: { enabled: true, effort: given },
        },
      },
      { emit: () => {} },
      context({
        stream: (_url, init) => {
          capturedEffort = JSON.parse(String(init?.body)).reasoning_effort;
          return Promise.resolve({
            status: 200,
            headers: {},
            lines: lineStream(["data: [DONE]"]),
          });
        },
      }),
    );
    equal(capturedEffort, expected);
  }
});

Deno.test("Provider cools on 429 so the host fails over", async () => {
  const result = await opencodeChannel.invoke(
    {
      model: { id: "kimi-k3", displayName: "Kimi K3", privateData: { lane: "chat" } },
      resource: resource(),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: async () => ({
        status: 429,
        headers: {},
        lines: lineStream([
          '{"error":{"type":"rate_limit_error","message":"rate limit"}}',
        ]),
      }),
      fetch: async (url) => {
        assert(url === USAGE_URL, `unexpected URL ${url}`);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            usage: {
              rolling: {
                percent: 100,
                resetsAt: new Date(Date.now() + 1200_000).toISOString(),
              },
            },
          }),
        };
      },
    }),
  );
  equal(result.status, "resource-error");
  equal(result.patch?.state?.status, "cooling");
});

Deno.test("Provider invalidates on 401 and on 403 entitlement errors", async () => {
  for (
    const [status, body] of [
      [401, '{"error":{"message":"bad key"}}'],
      [403, '{"error":{"type":"EntitlementError","message":"subscription required"}}'],
    ] as const
  ) {
    const result = await opencodeChannel.invoke(
      {
        model: { id: "kimi-k3", displayName: "Kimi K3", privateData: { lane: "chat" } },
        resource: resource(),
        request: request(),
      },
      { emit: () => {} },
      context({
        stream: async () => ({
          status,
          headers: {},
          lines: lineStream([body]),
        }),
      }),
    );
    equal(result.status, "resource-error");
    equal(result.patch?.state?.status, "invalid");
  }
});

Deno.test("Present shows the plan and quota windows without the key", () => {
  const snapshot = resource({
    ...account(),
    quota: parseOpenCodeUsage({
      usage: {
        rolling: { percent: 20 },
        monthly: { percent: 55, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
      },
    }),
  });
  const view = presentAccount(snapshot);
  equal(view.displayName, "OpenCode Go (...1234)");
  const metricIds = (view.metrics ?? []).map((metric) => metric.id);
  equal(metricIds, ["rolling", "monthly"]);
  assert(
    !JSON.stringify(view).includes("sk-oc-test"),
    "view must not leak the key",
  );
});

Deno.test("Auth headers reproduce the official client fingerprint", () => {
  const headers = authHeaders("sk-oc-x");
  equal(headers.authorization, "Bearer sk-oc-x");
  equal(headers["x-opencode-client"], "desktop");
  assert(headers["user-agent"].startsWith("opencode/"), "UA must be opencode/*");
});

Deno.test("Free session id is time-encoded and memoized per conversation", () => {
  const a = generateSessionId();
  assert(OPENCODE_SESSION_RE.test(a), `bad session shape: ${a}`);
  const a2 = sessionFor("conv-free-1");
  const a3 = sessionFor("conv-free-1");
  equal(a2, a3);
  assert(sessionFor("conv-free-2") !== a2, "different conversations get different sessions");
  // The prefix decodes to ~now mod 2^36 ms (upstream validates the window).
  const prefix = BigInt(`0x${a.slice(4, 16)}`);
  const decodedMs = Number(((((1n << 48n) - 1n) - prefix) / 0x1000n) % (1n << 36n));
  const nowMod = Date.now() % (1 << 36);
  const diff = (nowMod - decodedMs + (1 << 36)) % (1 << 36);
  assert(diff < 60_000, `session prefix must embed a recent timestamp (diff ${diff})`);
});

Deno.test("Fingerprint injects env marker, verbatim tools, and renames collisions", () => {
  const base = request();
  const { request: out, renamed } = applyFingerprint({
    ...base,
    instructions: "Do the thing",
    tools: [
      { name: "read", description: "caller read", parameters: { type: "object" } },
      { name: "write", description: "caller write", parameters: { type: "object" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        text: "ok",
        thinking: "",
        replayState: null,
        toolCalls: [{ index: 0, callId: "c1", name: "read", arguments: { path: "/x" } }],
      },
    ],
  });
  const names = out.tools.map((tool) => tool.name);
  assert(names.includes("read") && names.includes("shell"), "fingerprint tools must be present");
  assert(names.includes("read_client"), "caller read must be renamed");
  assert(names.includes("write"), "unrelated tools pass through");
  equal(renamed.get("read_client"), "read");
  const readTool = out.tools.find((tool) => tool.name === "read")!;
  assert(
    readTool.description.startsWith("Read the contents of a file or directory."),
    "fingerprint read must use the verbatim CLI description",
  );
  assert(out.instructions.includes("<env>"), "instructions must carry the env marker");
  assert(
    out.instructions.includes("placeholder"),
    "instructions must tell the model fingerprint tools are placeholders",
  );
  const assistant = out.messages[1];
  assert(assistant.role === "assistant", "second message must be the assistant turn");
  if (assistant.role === "assistant") {
    equal(assistant.toolCalls[0].name, "read_client");
  }
});

Deno.test("Free provider sends the CLI fingerprint on the chat lane", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> | null = null;
  let capturedBody: Record<string, unknown> | null = null;
  const events: ModelEvent[] = [];
  const result = await opencodeFreeChannel.invoke(
    {
      model: { id: "big-pickle", displayName: "Big Pickle", privateData: { lane: "chat" } },
      resource: null,
      request: {
        ...request(),
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            text: "hello",
            thinking: "",
            replayState: null,
            toolCalls: [],
          },
          { role: "user", content: [{ type: "text", text: "again" }] },
        ],
      },
    },
    { emit: (event) => events.push(event) },
    context({
      stream: async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init?.headers ?? null;
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return {
          status: 200,
          headers: {},
          lines: lineStream([
            'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
            "data: [DONE]",
          ]),
        };
      },
    }),
  );
  equal(result.status, "completed");
  equal(capturedUrl, "https://opencode.ai/inference/v1/chat/completions");
  const headers = capturedHeaders as unknown as Record<string, string>;
  equal(headers.authorization, "Bearer public");
  equal(headers["user-agent"], "opencode/latest/2.0.26/cli");
  equal(headers["x-opencode-client"], "cli");
  const session = headers["x-opencode-session"];
  assert(OPENCODE_SESSION_RE.test(session), `bad session shape: ${session}`);
  equal(headers["x-opencode-session-id"], session);
  equal(headers["x-session-affinity"], session);
  equal(headers["x-session-id"], session);
  equal(headers["x-opencode-project"], "global");

  const body = capturedBody as unknown as {
    stream: boolean;
    messages: Record<string, unknown>[];
    tools: Record<string, unknown>[];
  };
  equal(body.stream, true);
  const system = body.messages.find((message) => message.role === "system");
  assert(system, "a system message must carry the env marker");
  assert(String(system?.content ?? "").includes("<env>"), "env marker missing");
  const assistant = body.messages.find((message) => message.role === "assistant")!;
  equal(assistant.reasoning_content, " ");
  const toolNames = body.tools.map((tool) =>
    (tool as { function?: { name?: string } }).function?.name
  );
  assert(toolNames.includes("read") && toolNames.includes("shell"), "fingerprint tools missing");
});

Deno.test("Free provider strips replay state and sets store:false on the responses lane", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const result = await opencodeFreeChannel.invoke(
    {
      model: {
        id: "muse-spark-1.3-contributor-free",
        displayName: "Muse Spark 1.3 Contributor Free",
        privateData: { lane: "responses" },
      },
      resource: null,
      request: {
        ...request(),
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          {
            role: "assistant",
            text: "done",
            thinking: "",
            replayState: {
              protocolKind: "openai_responses",
              value: { items: [{ type: "reasoning", encrypted_content: "enc-1" }] },
            },
            toolCalls: [],
          },
          { role: "user", content: [{ type: "text", text: "again" }] },
        ],
      },
    },
    { emit: () => {} },
    context({
      stream: async (url, init) => {
        equal(url, "https://opencode.ai/inference/v1/responses");
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return {
          status: 200,
          headers: {},
          lines: lineStream([
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
            "data: [DONE]",
          ]),
        };
      },
    }),
  );
  equal(result.status, "completed");
  const body = capturedBody as unknown as {
    input: Record<string, unknown>[];
    store: boolean;
    tool_choice: string;
    include: unknown[];
  };
  equal(body.store, false);
  equal(body.tool_choice, "auto");
  equal(body.include, []);
  assert(
    body.input.every((item) => item.type !== "reasoning"),
    "reasoning items must not be replayed under pooled accounts",
  );
});

Deno.test("Free model list keeps only -free ids plus big-pickle", async () => {
  assert(isFreeModelId("big-pickle"), "big-pickle is a known free model");
  assert(isFreeModelId("glm-5.3-flash-free"), "-free suffix must qualify");
  assert(!isFreeModelId("glm-5.3-flash"), "paid ids must not qualify");
  assert(!isFreeModelId("freed-model"), "lookalike suffix must not qualify");
  const ctx = context({
    fetch: async (url) => {
      assert(url === "https://opencode.ai/zen/v1/models", `unexpected URL ${url}`);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: [
            { id: "big-pickle", modalities: { input: ["text"] } },
            { id: "nemotron-3.5-super-vl-free", modalities: { input: ["text", "image"] } },
            { id: "glm-5.3-flash-free" },
            { id: "glm-5.3-flash" },
            { id: "muse-spark-1.3-contributor-free" },
          ],
        }),
      };
    },
  });
  const models = await freeModels.list({ resource: null }, ctx);
  equal(models.map((model) => model.id), [
    "big-pickle",
    "nemotron-3.5-super-vl-free",
    "glm-5.3-flash-free",
    "muse-spark-1.3-contributor-free",
  ]);
  equal(models[1].capabilities?.images, true);
  equal(models[0].capabilities, undefined);
  equal((models[3].privateData as { lane: string }).lane, "responses");
});

Deno.test("Free model list falls back to the curated catalog", async () => {
  const models = await freeModels.list({ resource: null }, context());
  assert(models.some((model) => model.id === "big-pickle"), "fallback must include big-pickle");
  assert(
    models.every((model) => isFreeModelId(model.id)),
    "fallback must only contain free ids",
  );
});

Deno.test("Free provider reports quota errors without a resource", async () => {
  const result = await opencodeFreeChannel.invoke(
    {
      model: { id: "big-pickle", displayName: "Big Pickle", privateData: { lane: "chat" } },
      resource: null,
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: async () => ({
        status: 429,
        headers: {},
        lines: lineStream([
          '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached"}}',
        ]),
      }),
    }),
  );
  equal(result.status, "request-error");
  assert(
    result.status === "request-error" && result.message.includes("free usage limit"),
    "429 must surface a clear free-limit message",
  );
});
