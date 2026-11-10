import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  ProviderContext,
} from "cursor-byok:provider";
import type { LlmRequest, ModelEvent } from "cursor-byok:channel";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { codexDeviceOAuth } from "./oauth.ts";
import { parseOfficialModels } from "./models.ts";
import { buildResponsesBody } from "cursor-byok:protocol/openai-responses";
import { codexChannel, isQuotaError } from "./channel.ts";
import {
  accountIdentity,
  consumeResetCardAction,
  credentialDraft,
  listResetCardsAction,
  parseCodexUsage,
  parseCredentialFiles,
  presentAccount,
  quotaState,
  RESOURCE_TYPE,
} from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

function jwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(
    /\//g,
    "_",
  );
  return `header.${encoded}.signature`;
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
    key: "codex:acct-1",
    privateData,
    state: { status: "ready" },
  };
}

async function* sse(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function request(): LlmRequest {
  return {
    instructions: "You are a coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "medium" },
    latency: "fast",
    maxOutputTokens: 128_000,
    cacheKey: "conversation-1",
  };
}

Deno.test("account identity prioritizes ChatGPT account ID and drafts keep tokens private-side", async () => {
  const token = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    sub: "subject-1",
    email: "person@example.com",
  });
  assertEquals(await accountIdentity(token), {
    key: "codex:acct-1",
    displayName: "person@example.com",
  });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  assertEquals(draft.key, "codex:acct-1");
  const view = presentAccount(snapshot(draft.privateData));
  assert(!JSON.stringify(view).includes(token), "resource view exposed an access token");
  assertEquals(view.displayName, "person@example.com");
});

Deno.test("credential import accepts Codex auth JSON files", () => {
  const { credentials, warnings } = parseCredentialFiles([
    {
      name: "auth.json",
      content: JSON.stringify({
        tokens: {
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          id_token: jwt({ email: "person@example.com" }),
        },
      }),
    },
    { name: "broken.json", content: "{not json" },
  ]);
  assertEquals(credentials, [{
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    displayName: "person@example.com",
  }]);
  assertEquals(warnings, ["broken.json: not valid JSON"]);
});

Deno.test("usage maps secondary to weekly and primary to five-hour quota", () => {
  const quota = parseCodexUsage({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 80, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 25, reset_at: 1_900_000_000 },
    },
    rate_limit_reset_credits: { available_count: 2 },
  }, 1_700_000_000_000);
  assertEquals(quota.planLabel, "ChatGPT Plus");
  assertEquals(quota.weekly?.remainingPercent, 75);
  assertEquals(quota.fiveHour?.remainingPercent, 20);
  assertEquals(quota.weekly?.resetAtMs, 1_900_000_000_000);
  assertEquals(quota.resetCreditsAvailable, 2);
  assertEquals(quotaState(quota, 1_700_000_000_000), { status: "ready" });
});

Deno.test("reset card action lists safe card metadata and optional expiry", async () => {
  const result = await listResetCardsAction.run(
    snapshot({
      accessToken: "access-secret",
      accountId: "acct-1",
      refreshToken: null,
      displayName: "person@example.com",
      quota: null,
    }),
    null,
    context({
      fetch: (url, init) => {
        assertEquals(url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
        assertEquals(init?.headers?.["ChatGPT-Account-Id"], "acct-1");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            available_count: 1,
            credits: [{
              id: "credit-1",
              reset_type: "codex_rate_limits",
              status: "available",
              granted_at: "2026-06-12T01:33:14Z",
              expires_at: "2026-07-12T01:33:14Z",
              title: "One free rate limit reset",
            }],
          }),
        };
      },
    }),
  );
  assertEquals(result.cards, [{
    id: "credit-1",
    title: "One free rate limit reset",
    status: "available",
    grantedAtMs: Date.parse("2026-06-12T01:33:14Z"),
    expiresAtMs: Date.parse("2026-07-12T01:33:14Z"),
    fields: [{
      id: "reset-type",
      label: { "en-US": "Reset type", "zh-CN": "重置类型" },
      value: "codex_rate_limits",
    }],
  }]);
});

Deno.test("reset card action consumes a selected card and refreshes quota state", async () => {
  let requestNumber = 0;
  const result = await consumeResetCardAction.run(
    snapshot({
      accessToken: "access-secret",
      accountId: "acct-1",
      refreshToken: null,
      displayName: "person@example.com",
      quota: null,
    }),
    { cardId: "credit-1" },
    context({
      fetch: (url, init) => {
        requestNumber += 1;
        if (requestNumber === 1 || requestNumber === 4) {
          assertEquals(url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
          return {
            status: 200,
            headers: {},
            body: JSON.stringify(
              requestNumber === 1
                ? { available_count: 1, credits: [{ id: "credit-1", status: "available" }] }
                : { available_count: 0, credits: [] },
            ),
          };
        }
        if (requestNumber === 2) {
          assertEquals(
            url,
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
          );
          assertEquals(JSON.parse(init?.body ?? "{}"), {
            credit_id: "credit-1",
            redeem_request_id: JSON.parse(init?.body ?? "{}").redeem_request_id,
          });
          return { status: 200, headers: {}, body: JSON.stringify({ code: "reset" }) };
        }
        assertEquals(url, "https://chatgpt.com/backend-api/wham/usage");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ rate_limit_reset_credits: { available_count: 0 } }),
        };
      },
    }),
  );
  assertEquals(requestNumber, 4);
  assertEquals(result.cards, []);
  const quota = (result.patch?.privateData as Record<string, unknown>).quota as Record<
    string,
    unknown
  >;
  assertEquals(quota.resetCreditsAvailable, 0);
  assertEquals(quota.weekly, null);
  assertEquals(quota.fiveHour, null);
});

Deno.test("exhausted quota projects a cooling state until the latest reset", () => {
  const quota = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 100, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 100, reset_at: 1_900_000_000 },
    },
  }, 1_700_000_000_000);
  assertEquals(quotaState(quota, 1_700_000_000_000), {
    status: "cooling",
    retryAtMs: 1_900_000_000_000,
    message: "ChatGPT quota is exhausted",
  });
});

Deno.test("official model discovery excludes hidden models and puts the default first", () => {
  const models = parseOfficialModels({
    default_model: "gpt-second",
    models: [
      {
        slug: "gpt-first",
        display_name: "GPT First",
        supported_in_api: true,
        visibility: "list",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses" },
          { effort: "medium", description: "Balanced" },
        ],
      },
      {
        slug: "gpt-second",
        supported_in_api: true,
        visibility: "list",
        context_window: 400_000,
      },
      { slug: "gpt-hidden", supported_in_api: true, visibility: "hidden" },
      { slug: "gpt-internal", supported_in_api: false, visibility: "list" },
    ],
  });
  assertEquals(models.map((model) => model.id), ["gpt-second", "gpt-first"]);
  // An upstream window wins; models without one get the 272K Codex fallback.
  assertEquals(models[0].contextWindow, 400_000);
  assertEquals(models[1].contextWindow, 272_000);
  assertEquals(models[1].capabilities, { images: true });
  assertEquals(models[1].privateData, { reasoningEfforts: ["low", "medium"], serviceTiers: [] });
});

Deno.test("model discovery adds a Daybreak Blue model only where the account catalog lists it", () => {
  const models = parseOfficialModels({
    models: [
      {
        slug: "gpt-blue",
        display_name: "GPT Blue",
        supported_in_api: true,
        visibility: "list",
        supported_reasoning_levels: [{ effort: "high" }],
        available_access_programs: { cyber: ["standard", "daybreak_blue"] },
      },
      {
        slug: "gpt-standard",
        supported_in_api: true,
        visibility: "list",
        available_access_programs: { cyber: ["standard"] },
      },
    ],
  });
  assertEquals(models.map((model) => model.id), [
    "gpt-blue",
    "gpt-blue-daybreak-blue",
    "gpt-standard",
  ]);
  assertEquals(models[1].displayName, "GPT Blue Daybreak Blue");
  assertEquals(models[1].privateData, {
    reasoningEfforts: ["high"],
    serviceTiers: [],
    upstreamId: "gpt-blue",
    cyberAccessProgram: "daybreak_blue",
  });
});

Deno.test("model discovery keeps the service tiers each model offers", () => {
  const models = parseOfficialModels({
    models: [
      {
        slug: "gpt-fast",
        supported_in_api: true,
        visibility: "list",
        service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
        available_access_programs: { cyber: ["standard", "daybreak_blue"] },
      },
      { slug: "gpt-mini", supported_in_api: true, visibility: "list", service_tiers: [] },
    ],
  });
  assertEquals(
    models.map((model) => [model.id, (model.privateData as Record<string, unknown>).serviceTiers]),
    [["gpt-fast", ["priority"]], ["gpt-fast-daybreak-blue", ["priority"]], ["gpt-mini", []]],
  );
});

Deno.test("fast latency requests the priority tier only on models that offer it", async () => {
  const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  const tiers: unknown[] = [];
  for (const serviceTiers of [["priority"], []]) {
    await codexChannel.invoke(
      {
        model: { id: "gpt-test", displayName: "GPT Test", privateData: { serviceTiers } },
        resource: snapshot(draft.privateData),
        request: request(),
      },
      { emit: () => {} },
      context({
        stream: (_url, init) => {
          tiers.push(JSON.parse(init?.body ?? "{}").service_tier ?? null);
          return {
            status: 200,
            headers: {},
            lines: sse(['data: {"type":"response.completed","response":{}}']),
          };
        },
      }),
    );
  }
  assertEquals(tiers, ["priority", null]);
});

Deno.test("invoke sends the Daybreak Blue program with the upstream model slug", async () => {
  const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  const bodies: Record<string, unknown>[] = [];
  const invoke = (model: { id: string; displayName: string; privateData?: JsonValue }) =>
    codexChannel.invoke(
      { model, resource: snapshot(draft.privateData), request: request() },
      { emit: () => {} },
      context({
        stream: (_url, init) => {
          bodies.push(JSON.parse(init?.body ?? "{}"));
          return {
            status: 200,
            headers: {},
            lines: sse(['data: {"type":"response.completed","response":{}}']),
          };
        },
      }),
    );
  await invoke({
    id: "gpt-blue-daybreak-blue",
    displayName: "GPT Blue Daybreak Blue",
    privateData: {
      reasoningEfforts: ["medium"],
      upstreamId: "gpt-blue",
      cyberAccessProgram: "daybreak_blue",
    },
  });
  await invoke({ id: "gpt-blue", displayName: "GPT Blue", privateData: { reasoningEfforts: [] } });
  assertEquals(bodies[0].model, "gpt-blue");
  assertEquals(bodies[0].access_programs, { cyber: "daybreak_blue" });
  assertEquals(bodies[1].model, "gpt-blue");
  assert(!("access_programs" in bodies[1]), "standard models must not send an access program");
});

Deno.test("device OAuth begins with a host-held session and completes with a resource draft", async () => {
  const accessToken = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-oauth" },
    email: "oauth@example.com",
  });
  let requestNumber = 0;
  const flowContext = context({
    fetch: (url, init) => {
      requestNumber += 1;
      if (requestNumber === 1) {
        assertEquals(url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            device_auth_id: "private-device-id",
            user_code: "ABCD-EFGH",
            expires_in: 900,
            interval: 5,
          }),
        };
      }
      if (requestNumber === 2) {
        assertEquals(url, "https://auth.openai.com/api/accounts/deviceauth/token");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            authorization_code: "authorization-code",
            code_verifier: "pkce-verifier",
          }),
        };
      }
      assertEquals(url, "https://auth.openai.com/oauth/token");
      assert(init?.body?.includes("grant_type=authorization_code"));
      assert(init?.body?.includes("code_verifier=pkce-verifier"));
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: accessToken, refresh_token: "refresh-secret" }),
      };
    },
  });

  const begun = await codexDeviceOAuth.begin(flowContext);
  assertEquals(begun.userCode, "ABCD-EFGH");
  assertEquals(begun.pollIntervalMs, 5000);

  const polled = await codexDeviceOAuth.poll(begun.session, flowContext);
  assert(polled.status === "completed", `expected completed, received ${polled.status}`);
  assertEquals(polled.resources[0].key, "codex:acct-oauth");
  assertEquals(requestNumber, 3);
});

Deno.test("invoke streams normalized events from the Codex Responses API", async () => {
  const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];
  const result = await codexChannel.invoke(
    {
      model: {
        id: "gpt-test",
        displayName: "GPT Test",
        privateData: { reasoningEfforts: ["medium"], serviceTiers: ["priority"] },
      },
      resource: snapshot(draft.privateData),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: (url, init) => {
        assertEquals(url, "https://chatgpt.com/backend-api/codex/responses");
        requestBody = init?.body ?? "";
        requestHeaders = init?.headers ?? {};
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"type":"response.output_text.delta","delta":"Hel"}',
            'data: {"type":"response.output_text.delta","delta":"lo"}',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":4}}}}',
          ]),
        };
      },
    }),
  );
  assertEquals(result, { status: "completed" });
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.model, "gpt-test");
  assertEquals(body.store, false);
  assertEquals(body.reasoning, { summary: "auto", effort: "medium" });
  assertEquals(body.instructions, "You are a coding assistant.");
  assertEquals(body.include, ["reasoning.encrypted_content"]);
  assert(!("max_output_tokens" in body), "Codex endpoint rejects max_output_tokens");
  assertEquals(body.service_tier, "priority");
  assertEquals(body.prompt_cache_key, "conversation-1");
  // The cache-affinity header shares its source with prompt_cache_key.
  assertEquals(requestHeaders["session-id"], "conversation-1");
  assertEquals(requestHeaders["thread-id"], "conversation-1");
  assertEquals(requestHeaders["x-client-request-id"], "conversation-1");
  assertEquals(events, [
    { type: "text-start" },
    { type: "text-delta", text: "Hel" },
    { type: "text-delta", text: "lo" },
    {
      type: "usage",
      usage: {
        inputTokens: 6,
        outputTokens: 2,
        totalTokens: null,
        cacheReadTokens: 4,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "text-end" },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("reasoning replay projects response items to valid input items", () => {
  const replayRequest = request();
  replayRequest.messages = [{
    role: "assistant",
    text: "",
    thinking: "",
    replayState: {
      protocolKind: "openai_responses",
      value: {
        items: [{
          type: "reasoning",
          id: "item-1",
          status: "completed",
          summary: [{ type: "summary_text", text: "why" }],
          content: [],
          encrypted_content: "opaque",
          output_only: true,
        }],
      },
    },
    toolCalls: [],
  }];

  const body = buildResponsesBody({
    url: "https://example.com/responses",
    model: "gpt-test",
    request: replayRequest,
  });
  assertEquals(body.input, [{
    type: "reasoning",
    id: "item-1",
    summary: [{ type: "summary_text", text: "why" }],
    content: [],
    encrypted_content: "opaque",
  }]);
});

Deno.test("invoke streams incremental tool calls and replays reasoning items", async () => {
  const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  const events: ModelEvent[] = [];
  const result = await codexChannel.invoke(
    {
      model: { id: "gpt-test", displayName: "GPT Test" },
      resource: snapshot(draft.privateData),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: () => ({
        status: 200,
        headers: {},
        lines: sse([
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call-1","name":"read_file"}}',
          'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":"}',
          'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"\\"a.ts\\"}"}',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call-1","name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}',
          'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"reasoning","encrypted_content":"opaque"}}',
          'data: {"type":"response.completed","response":{}}',
        ]),
      }),
    }),
  );
  assertEquals(result, { status: "completed" });
  assertEquals(events, [
    { type: "tool-call-start", index: 0, callId: "call-1", name: "read_file" },
    { type: "tool-call-arguments-delta", index: 0, delta: '{"path":' },
    { type: "tool-call-arguments-delta", index: 0, delta: '"a.ts"}' },
    { type: "tool-call-end", index: 0 },
    {
      type: "replay-state",
      protocolKind: "openai_responses",
      value: { items: [{ type: "reasoning", encrypted_content: "opaque" }] },
    },
    { type: "done", reason: "tool-use" },
  ]);
});

Deno.test("invoke reports a refusal from the Responses API instead of a normal or cut-off answer", async () => {
  const draft = await credentialDraft({
    accessToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
    refreshToken: null,
    displayName: null,
  });
  const run = async (lines: string[]) => {
    const events: ModelEvent[] = [];
    const result = await codexChannel.invoke(
      {
        model: { id: "gpt-test", displayName: "GPT Test" },
        resource: snapshot(draft.privateData),
        request: request(),
      },
      { emit: (event) => events.push(event) },
      context({ stream: () => ({ status: 200, headers: {}, lines: sse(lines) }) }),
    );
    assertEquals(result, { status: "completed" });
    return events;
  };
  assertEquals(
    await run([
      'data: {"type":"response.refusal.delta","delta":"I cannot "}',
      'data: {"type":"response.refusal.done","refusal":"I cannot help with that."}',
      'data: {"type":"response.completed","response":{}}',
    ]),
    [{ type: "done", reason: "refusal", category: null, explanation: "I cannot help with that." }],
  );
  assertEquals(
    await run([
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call-1","name":"read_file"}}',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call-1","name":"read_file","arguments":"{}"}}',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","content":[{"type":"refusal","refusal":"No."}]}}',
      'data: {"type":"response.completed","response":{}}',
    ]).then((events) => events.at(-1)),
    { type: "done", reason: "refusal", category: null, explanation: "No." },
  );
  assertEquals(
    await run([
      'data: {"type":"response.output_text.delta","delta":"Par"}',
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}',
    ]),
    [
      { type: "text-start" },
      { type: "text-delta", text: "Par" },
      { type: "text-end" },
      { type: "done", reason: "refusal", category: null, explanation: null },
    ],
  );
  assertEquals(
    await run([
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}',
    ]),
    [{ type: "done", reason: "length" }],
  );
});
Deno.test("invoke maps quota failures to a cooling resource error", async () => {
  assert(!isQuotaError("429 rate_limit_reached"));
  assert(isQuotaError("429 usage_limit_reached: 5-hour limit"));
  const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  const result = await codexChannel.invoke(
    {
      model: { id: "gpt-test", displayName: "GPT Test" },
      resource: snapshot(draft.privateData),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: () => ({
        status: 429,
        headers: {},
        lines: sse(['{"detail":"usage_limit_reached","reset_after_seconds":600}']),
      }),
    }),
  );
  assert(result.status === "resource-error", `expected resource-error, received ${result.status}`);
  assert(result.patch.state?.status === "cooling", "quota failure should cool the resource");
  assert(
    result.patch.state.retryAtMs !== undefined && result.patch.state.retryAtMs > Date.now(),
    "cooling should carry the parsed reset time",
  );
});
