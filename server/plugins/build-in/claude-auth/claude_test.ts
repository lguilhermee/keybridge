import { claudeModels } from "./models.ts";
import { claudeProvider } from "./provider.ts";
import {
  anthropicUsage,
  buildRequest,
  decloakName,
  mergeUsage,
  MESSAGES_URL,
} from "./request.ts";
import {
  claudeBrowserOAuth,
  credentialImport,
  externalRedirectUri,
  parseClaudeUsage,
  parseCredentials,
  parseResetHintMs,
  presentAccount,
  quotaState,
  splitAuthorizationCode,
  PROFILE_URL,
  TOKEN_URL,
  USAGE_URL,
  type AccountData,
} from "./resources.ts";
import type { PluginContext } from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";

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

function context(overrides: Partial<PluginContext["network"]> = {}): PluginContext {
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

function request(): LlmRequest {
  return {
    instructions: "Test instructions",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [{
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
    }],
    reasoning: { enabled: false, effort: null },
    latency: "standard",
    maxOutputTokens: 256,
    cacheKey: "conversation-1",
  };
}

function account(): AccountData {
  return {
    accessToken: "sk-ant-oat01-test-token",
    refreshToken: "sk-ant-ort01-refresh",
    expiresAtMs: Date.now() + 3600_000,
    scope: "user:inference",
    displayName: "Claude account",
  };
}

function resource(data: AccountData = account()) {
  return {
    id: "r1",
    type: "claude-account",
    key: "claude:test@example.com",
    privateData: data,
    state: { status: "ready" as const },
  };
}

Deno.test("Claude OAuth begin builds the authorization URL from 9router's shape", async () => {
  const begun = await claudeBrowserOAuth.begin(
    {
      redirectUri: "http://127.0.0.1:54321/callback",
      state: "state-1",
      codeChallenge: "challenge-1",
    },
    context(),
  );
  const url = new URL(begun.authorizationUrl);
  assert(
    url.origin + url.pathname === "https://claude.ai/oauth/authorize",
    `unexpected authorize URL ${begun.authorizationUrl}`,
  );
  equal(url.searchParams.get("code"), "true");
  equal(
    url.searchParams.get("client_id"),
    "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  );
  equal(url.searchParams.get("response_type"), "code");
  equal(
    url.searchParams.get("redirect_uri"),
    "http://localhost:54321/callback",
  );
  equal(
    url.searchParams.get("scope"),
    "org:create_api_key user:profile user:inference",
  );
  equal(url.searchParams.get("code_challenge"), "challenge-1");
  equal(url.searchParams.get("code_challenge_method"), "S256");
  equal(url.searchParams.get("state"), "state-1");
  equal(externalRedirectUri("http://127.0.0.1:9/callback"), "http://localhost:9/callback");
  equal(externalRedirectUri("http://localhost:9/callback"), "http://localhost:9/callback");
});

Deno.test("Claude token exchange posts JSON and honours code#state", async () => {
  let sent: Record<string, unknown> | null = null;
  const ctx = context({
    fetch: async (url, init) => {
      if (url.startsWith(USAGE_URL)) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            five_hour: {
              utilization: 10,
              resets_at: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
        };
      }
      if (url === PROFILE_URL) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            account: { email: "user@example.com", uuid: "acct-1" },
            organization: {
              uuid: "org-1",
              name: "Acme",
              rate_limit_tier: "default_claude_max_20x",
            },
          }),
        };
      }
      assert(url === TOKEN_URL, `unexpected URL ${url}`);
      sent = JSON.parse(init?.body ?? "{}");
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: "sk-ant-oat01-new",
          refresh_token: "sk-ant-ort01-new",
          expires_in: 3600,
          scope: "user:inference",
        }),
      };
    },
  });
  const draft = await claudeBrowserOAuth.complete(
    { createdAtMs: Date.now(), state: "state-1", redirectUri: "http://localhost:5/callback" },
    {
      code: "auth-code#state-1",
      redirectUri: "http://127.0.0.1:5/callback",
      codeVerifier: "verifier-1",
    },
    ctx,
  );
  equal(sent, {
    code: "auth-code",
    state: "state-1",
    grant_type: "authorization_code",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirect_uri: "http://localhost:5/callback",
    code_verifier: "verifier-1",
  });
  equal(draft[0].key, "claude:user@example.com");
  const data = draft[0].privateData as Record<string, unknown>;
  equal(data.accessToken, "sk-ant-oat01-new");
  equal(data.refreshToken, "sk-ant-ort01-new");
  equal(data.displayName, "user@example.com (Acme)");
  equal(data.accountUuid, "acct-1");
  equal(splitAuthorizationCode("abc#st"), { code: "abc", state: "st" });
  equal(splitAuthorizationCode("abc"), { code: "abc", state: null });
});

Deno.test("Credential import accepts claudeAiOauth blocks and plain token JSON", async () => {
  const parsed = parseCredentials(JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-a",
      refreshToken: "sk-ant-ort01-a",
      expiresAt: Date.now() + 60_000,
      subscriptionType: "max",
    },
  }));
  equal(parsed.length, 1);
  equal(parsed[0].accessToken, "sk-ant-oat01-a");
  equal(parsed[0].planLabel, "Claude Max");
  const array = parseCredentials(
    JSON.stringify([{ access_token: "sk-ant-oat01-b" }]),
  );
  equal(array[0].accessToken, "sk-ant-oat01-b");
  let failed = false;
  try {
    parseCredentials('{"accessToken":""}');
  } catch (error) {
    failed = String(error).includes("access token");
  }
  assert(failed, "empty access token should be rejected");
  assert(credentialImport.accept.includes(".json"), "import must accept .json");
});

Deno.test("Credential import accepts a pasted setup-token", () => {
  const pasted = parseCredentials("sk-ant-oat01-pasted-setup-token");
  equal(pasted.length, 1);
  equal(pasted[0].accessToken, "sk-ant-oat01-pasted-setup-token");
  equal(pasted[0].refreshToken, null);
  let failed = false;
  try {
    parseCredentials("not a credential at all");
  } catch (error) {
    failed = String(error).includes("setup-token");
  }
  assert(failed, "non-token text should be rejected");
});

Deno.test("Usage parsing maps utilization, scoped windows, and cedar ember grants", () => {
  const now = Date.now();
  const quota = parseClaudeUsage({
    five_hour: { utilization: 82, resets_at: new Date(now + 3600_000).toISOString() },
    seven_day: { utilization: 100, resets_at: new Date(now + 86_400_000).toISOString() },
    seven_day_sonnet: {
      utilization: 40,
      resets_at: new Date(now + 86_400_000).toISOString(),
    },
    limits: [{
      kind: "weekly_scoped",
      percent: 55,
      resets_at: new Date(now + 86_400_000).toISOString(),
      scope: { model: { display_name: "Opus" } },
    }],
    cedar_ember: {
      eligible: true,
      grants: [{ resets_left: 1 }, { resets_left: 0 }, { paused: true, resets_left: 2 }],
    },
  }, now);
  equal(quota.fiveHour?.remainingPercent, 18);
  equal(quota.weekly?.remainingPercent, 0);
  equal(quota.resetGrantsAvailable, 1);
  equal(quota.limitReached, true);
  const labels = quota.scoped.map((w) => w.label).sort();
  equal(labels, ["weekly opus (7d)", "weekly sonnet (7d)"]);
  const state = quotaState(quota, now);
  equal(state.status, "cooling");
  assert(
    (state as { retryAtMs?: number }).retryAtMs === now + 86_400_000,
    "cooling should end at the weekly reset",
  );
});

Deno.test("Reset hints extract resumption time from error text", () => {
  const now = 1_000_000;
  equal(
    parseResetHintMs('{"error":{"resets_at":"2026-10-12T20:00:00Z"}}', now),
    Date.parse("2026-10-12T20:00:00Z"),
  );
  equal(parseResetHintMs("retry-after: 30", now), now + 30_000);
  equal(parseResetHintMs("no hint", now), null);
});

Deno.test("Request building injects Claude Code identity and cloaks tool names", async () => {
  const { body, headers, nameMap } = await buildRequest(
    { ...request(), reasoning: { enabled: true, effort: "high" } },
    "claude-sonnet-5-5",
    32_000,
    account(),
  );
  const parsed = JSON.parse(body);
  const system = parsed.system as { text: string }[];
  assert(
    system[0].text.startsWith("x-anthropic-billing-header: cc_version=2.1.321."),
    "billing header must be the first system block",
  );
  equal(
    system[1].text,
    "You are Claude Code, Anthropic's official CLI for Claude.",
  );
  equal(system[2].text, "Test instructions");
  equal(
    (system[2] as Record<string, unknown>).cache_control,
    { type: "ephemeral", ttl: "1h" },
  );
  const metadata = JSON.parse(parsed.metadata.user_id);
  assert(/^[0-9a-f]{64}$/.test(metadata.device_id), "device_id must be 64 hex");
  assert(metadata.session_id, "metadata must carry a session id");
  equal(headers["x-claude-code-session-id"], metadata.session_id);
  equal(headers.authorization, "Bearer sk-ant-oat01-test-token");
  assert(
    headers["anthropic-beta"].includes("oauth-2025-04-20"),
    "oauth beta flag required",
  );
  equal(parsed.model, "claude-sonnet-5-5");
  equal(parsed.max_tokens, 256);
  equal(parsed.temperature, 1);
  equal(parsed.stream, true);
  equal(parsed.thinking, { type: "adaptive", display: "summarized" });
  equal(parsed.output_config, { effort: "high" });
  equal(parsed.tools[0].name, "read_file_ide");
  equal(decloakName("read_file_ide", nameMap), "read_file");
  equal(decloakName("Other", nameMap), "Other");
  assert(!("speed" in parsed), "standard latency must not request fast mode");
});

Deno.test("Fast latency requests fast mode only on models that support it", async () => {
  const fast = { ...request(), latency: "fast" as const };
  for (const model of ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-2"]) {
    const { body, headers } = await buildRequest(fast, model, null, account());
    equal(JSON.parse(body).speed, "fast");
    assert(
      headers["anthropic-beta"].includes("fast-mode-2026-02-01"),
      "fast mode beta flag required",
    );
  }
  for (const model of ["claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"]) {
    const { body } = await buildRequest(fast, model, null, account());
    assert(!("speed" in JSON.parse(body)), `${model} rejects speed: "fast"`);
  }
});

Deno.test("Provider streams Anthropic SSE into model events with decloaked tools", async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5}}}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig1"}}',
    "",
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file_ide"}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/a\\"}"}}',
    "",
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
  ];
  const events: ModelEvent[] = [];
  const result = await claudeProvider.invoke(
    {
      model: { id: "claude-sonnet-5-5", displayName: "Sonnet" },
      resource: resource(),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: async (url) => {
        assert(url === MESSAGES_URL, `unexpected URL ${url}`);
        return { status: 200, headers: {}, lines: lineStream(sse) };
      },
    }),
  );
  equal(result.status, "completed");
  const types = events.map((event) => event.type);
  equal(types, [
    "thinking-start",
    "thinking-delta",
    "thinking-end",
    "tool-call-start",
    "tool-call-arguments-delta",
    "tool-call-end",
    "replay-state",
    "usage",
    "done",
  ]);
  const toolStart = events.find((event) => event.type === "tool-call-start") as {
    name: string;
    callId: string;
  };
  equal(toolStart.name, "read_file");
  equal(toolStart.callId, "toolu_1");
  const replay = events.find((event) => event.type === "replay-state");
  if (!replay || replay.type !== "replay-state") throw new Error("replay-state missing");
  equal(replay.providerKind, "claude");
  equal(
    (replay.value as unknown as { blocks: { signature: string }[] })
      .blocks[0].signature,
    "sig1",
  );
  const usage = events.find((event) => event.type === "usage") as {
    usage: { outputTokens: number };
  };
  equal(usage.usage.outputTokens, 7);
  equal((events[events.length - 1] as { reason: string }).reason, "tool-use");
});

Deno.test("Provider cools the resource on 429 so the host can fail over", async () => {
  const result = await claudeProvider.invoke(
    {
      model: { id: "claude-sonnet-5-5", displayName: "Sonnet" },
      resource: resource(),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: async () => ({
        status: 429,
        headers: {},
        lines: lineStream([
          '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}',
        ]),
      }),
      fetch: async (url) => {
        assert(url.startsWith(USAGE_URL), `unexpected URL ${url}`);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            five_hour: {
              utilization: 100,
              resets_at: new Date(Date.now() + 1800_000).toISOString(),
            },
          }),
        };
      },
    }),
  );
  equal(result.status, "resource-error");
  const state = result.patch?.state as { status: string; retryAtMs?: number };
  equal(state.status, "cooling");
  assert(
    state.retryAtMs !== undefined && state.retryAtMs > Date.now(),
    "cooling should carry the usage reset time",
  );
});

Deno.test("Provider refreshes an expired token once before the first event", async () => {
  let streams = 0;
  let refreshes = 0;
  const events: ModelEvent[] = [];
  const result = await claudeProvider.invoke(
    {
      model: { id: "claude-sonnet-5-5", displayName: "Sonnet" },
      resource: resource(),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      fetch: async (url, init) => {
        assert(url === TOKEN_URL, `unexpected URL ${url}`);
        equal(JSON.parse(init?.body ?? "{}").grant_type, "refresh_token");
        refreshes++;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            access_token: "sk-ant-oat01-fresh",
            refresh_token: "sk-ant-ort01-fresh",
            expires_in: 3600,
          }),
        };
      },
      stream: async (_url, init) => {
        streams++;
        if (streams === 1) {
          return {
            status: 401,
            headers: {},
            lines: lineStream([
              '{"type":"error","error":{"type":"authentication_error","message":"expired"}}',
            ]),
          };
        }
        equal(init?.headers?.authorization, "Bearer sk-ant-oat01-fresh");
        return {
          status: 200,
          headers: {},
          lines: lineStream([
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
            "",
            'event: content_block_start',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
            "",
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
            "",
            'event: content_block_stop',
            'data: {"type":"content_block_stop","index":0}',
            "",
            'event: message_delta',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
            "",
            'event: message_stop',
            'data: {"type":"message_stop"}',
            "",
          ]),
        };
      },
    }),
  );
  equal(result.status, "completed");
  equal([streams, refreshes], [2, 1]);
  equal(
    (result as { patch?: { privateData?: { accessToken?: string } } })
      .patch?.privateData?.accessToken,
    "sk-ant-oat01-fresh",
  );
  assert(
    events.some((event) => event.type === "done"),
    "stream should complete after refresh",
  );
});

Deno.test("Provider invalidates the resource on 401 without a refresh token", async () => {
  const result = await claudeProvider.invoke(
    {
      model: { id: "claude-sonnet-5-5", displayName: "Sonnet" },
      resource: resource({ ...account(), refreshToken: null }),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: async () => ({
        status: 401,
        headers: {},
        lines: lineStream([
          '{"type":"error","error":{"type":"authentication_error","message":"invalid"}}',
        ]),
      }),
    }),
  );
  equal(result.status, "resource-error");
  equal(result.patch?.state?.status, "invalid");
});

const REFUSAL_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
  "",
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
  "",
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  "",
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":3}}',
  "",
  'event: message_stop',
  'data: {"type":"message_stop"}',
  "",
];

const ANSWER_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
  "",
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Here you go"}}',
  "",
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  "",
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
  "",
  'event: message_stop',
  'data: {"type":"message_stop"}',
  "",
];

Deno.test("Provider resends the request when a refusal precedes any content", async () => {
  let streams = 0;
  const events: ModelEvent[] = [];
  const result = await claudeProvider.invoke(
    {
      model: { id: "claude-opus-5-5", displayName: "Opus" },
      resource: resource(),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: async () => {
        streams++;
        return {
          status: 200,
          headers: {},
          lines: lineStream(streams === 1 ? REFUSAL_SSE : ANSWER_SSE),
        };
      },
    }),
  );
  equal(result.status, "completed");
  equal(streams, 2);
  const text = events.find((event) => event.type === "text-delta") as {
    text: string;
  };
  equal(text?.text, "Here you go");
});

Deno.test("Provider surfaces an uncategorized refusal after the retries", async () => {
  let streams = 0;
  const events: ModelEvent[] = [];
  const result = await claudeProvider.invoke(
    {
      model: { id: "claude-opus-5-5", displayName: "Opus" },
      resource: resource(),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: async () => {
        streams++;
        return { status: 200, headers: {}, lines: lineStream(REFUSAL_SSE) };
      },
    }),
  );
  equal(result.status, "request-error");
  equal(streams, 3);
  assert(
    result.status === "request-error" &&
      result.message === "Claude refused the request",
    "persistent refusal must surface the refusal message",
  );
});

Deno.test("Provider surfaces a categorized refusal without retrying", async () => {
  let streams = 0;
  const policyRefusal = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":4,"cache_creation_input_tokens":467158}}}',
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"Cyber safeguards flagged this message."}},"usage":{"output_tokens":0}}',
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
  ];
  const result = await claudeProvider.invoke(
    {
      model: { id: "claude-opus-5-5", displayName: "Opus" },
      resource: resource(),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: async () => {
        streams++;
        return { status: 200, headers: {}, lines: lineStream(policyRefusal) };
      },
    }),
  );
  equal(result.status, "request-error");
  equal(streams, 1);
  assert(
    result.status === "request-error" &&
      result.message ===
        "Claude refused the request (cyber): Cyber safeguards flagged this message.",
    "categorized refusal must surface the stop_details explanation",
  );
});

Deno.test("Provider does not retry a refusal after content was emitted", async () => {
  let streams = 0;
  const events: ModelEvent[] = [];
  const refusalAfterText = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
    "",
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I cannot help with that."}}',
    "",
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":8}}',
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
  ];
  const result = await claudeProvider.invoke(
    {
      model: { id: "claude-opus-5-5", displayName: "Opus" },
      resource: resource(),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: async () => {
        streams++;
        return { status: 200, headers: {}, lines: lineStream(refusalAfterText) };
      },
    }),
  );
  equal(result.status, "completed");
  equal(streams, 1);
  const text = events.find((event) => event.type === "text-delta") as {
    text: string;
  };
  equal(text?.text, "I cannot help with that.");
});

Deno.test("Usage merge takes the max of each token counter", () => {
  const merged = mergeUsage(
    anthropicUsage({ input_tokens: 10, cache_read_input_tokens: 5 }),
    anthropicUsage({ output_tokens: 7 }),
  );
  equal(merged.inputTokens, 10);
  equal(merged.cacheReadTokens, 5);
  equal(merged.outputTokens, 7);
  equal(merged.totalTokens, 22);
});

Deno.test("Model catalog exposes the Claude subscription models", async () => {
  const models = await claudeModels.list(
    { resource: null },
    context(),
  );
  const ids = models.map((model) => model.id);
  assert(ids.includes("claude-opus-5-5"), "opus missing");
  assert(ids.includes("claude-sonnet-5-5"), "sonnet missing");
  assert(ids.includes("claude-haiku-4-5-20251001"), "haiku missing");
  assert(
    models.every((model) => model.capabilities?.images === true),
    "all models accept images",
  );
});

Deno.test("Present shows plan, quota windows, and reset grants without credentials", async () => {
  const snapshot = resource({
    ...account(),
    displayName: "amanda@example.com (Acme)",
    planLabel: "Claude Max",
    quota: parseClaudeUsage({
      five_hour: { utilization: 30, resets_at: new Date(Date.now() + 600_000).toISOString() },
      seven_day: { utilization: 90 },
      cedar_ember: { eligible: true, grants: [{ resets_left: 1 }] },
    }),
  });
  const view = presentAccount(snapshot);
  equal(view.displayName, "amanda@example.com (Acme)");
  equal(view.description, "Claude Max");
  const metricIds = (view.metrics ?? []).map((metric) => metric.id);
  equal(metricIds, ["five-hour", "weekly", "reset-grants"]);
  const rendered = JSON.stringify(view);
  assert(!rendered.includes("sk-ant-"), "view must not leak tokens");
});
