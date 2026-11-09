import {
  ConnectError,
  connectError,
  decodeFrames,
  encodeFrame,
} from "./connect.ts";
import { parseModels } from "./models.ts";
import { buildRequest, pairToolResults, ResponseDecoder } from "./request.ts";
import {
  devinBrowserOAuth,
  parseCredentials,
  parseDevinUserStatus,
  parseRateLimitResetMs,
  presentAccount,
} from "./resources.ts";
import { devinProvider } from "./provider.ts";
import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function rejects(
  action: () => unknown | Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (String(error).includes(message)) return;
    throw error;
  }
  throw new Error(`Expected rejection containing ${message}`);
}

function endFrame(value: JsonValue = {}): Uint8Array {
  const frame = encodeFrame(value);
  frame[0] = 2;
  return frame;
}

async function* chunks(
  bytes: Uint8Array,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let index = 0; index < bytes.length; index += size) {
    yield bytes.slice(index, index + size);
  }
}

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function request(): LlmRequest {
  return {
    instructions: "Test instructions",
    messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
    tools: [],
    reasoning: { enabled: false, effort: null },
    latency: "standard",
    maxOutputTokens: 128,
    cacheKey: "test-conversation",
  };
}

Deno.test("Connect frames preserve Unicode across arbitrary HTTP boundaries", async () => {
  const expected: JsonValue[] = [{ deltaText: "Olá wörld 😀" }, {
    stopReason: "STOP_REASON_STOP_PATTERN",
  }];
  const bytes = join(...expected.map(encodeFrame), endFrame());
  for (let size = 1; size <= bytes.length; size++) {
    const actual = [];
    for await (const frame of decodeFrames(chunks(bytes, size))) {
      actual.push(frame);
    }
    equal(actual, expected);
  }
});

Deno.test("Connect rejects truncated/error/compressed streams and data after the end", async () => {
  const collect = async (bytes: Uint8Array) => {
    for await (const _ of decodeFrames(chunks(bytes, 3))) { /* consume */ }
  };
  await rejects(
    () => collect(encodeFrame({ deltaText: "partial" })),
    "before its final",
  );
  await rejects(
    () => collect(join(encodeFrame({}), endFrame().slice(0, 4))),
    "before its final",
  );
  await rejects(
    () =>
      collect(
        endFrame({ error: { code: "unauthenticated", message: "Expired" } }),
      ),
    "unauthenticated",
  );
  const compressed = encodeFrame({});
  compressed[0] = 1;
  await rejects(() => collect(compressed), "frame flags");
  await rejects(
    () => collect(join(endFrame(), encodeFrame({}))),
    "after EndStream",
  );
  const enormous = new Uint8Array([0, 2, 0, 0, 0]);
  await rejects(() => collect(enormous), "frame limit");
});

Deno.test("Credential import accepts existing CLI TOML and renewable API keys without UI exposure", () => {
  equal(
    parseCredentials(
      'windsurf_api_key = "devin-session-token$test"\napi_server_url = "https://server.codeium.com"',
      "credentials.toml",
    ),
    [{
      token: "devin-session-token$test",
      apiKey: null,
      displayName: "Devin CLI",
    }],
  );
  equal(
    parseCredentials('{"name":"Account","api_key":"durable"}', "account.json"),
    [{ token: "", apiKey: "durable", displayName: "Account" }],
  );
  equal(
    parseCredentials("devin-session-token$pasted", "pasted.txt"),
    [{ token: "devin-session-token$pasted", apiKey: null, displayName: "Devin account" }],
  );
  equal(
    parseCredentials("a-durable-api-key", "pasted.txt"),
    [{ token: "", apiKey: "a-durable-api-key", displayName: "Devin account" }],
  );
  equal(
    parseCredentials(
      'windsurf_api_key = "devin-session-token$pasted-toml"',
      "pasted.txt",
    ),
    [{ token: "devin-session-token$pasted-toml", apiKey: null, displayName: "Devin CLI" }],
  );
  const error = connectError(
    '{"code":"unauthenticated","message":"invalid secret-token"}',
    401,
    ["secret-token"],
  );
  equal(error.message.includes("secret-token"), false);
  equal(error instanceof ConnectError, true);
});

Deno.test("Catalog uses current model limits, images and stable IDs, excluding routers", () => {
  equal(
    parseModels({
      clientModelConfigs: [
        {
          modelUid: "m",
          label: "Model",
          supportsImages: true,
          modelInfo: { maxOutputTokens: 300 },
        },
        { modelUid: "m", label: "Duplicate" },
        { modelUid: "router", isModelRouter: true },
      ],
    }),
    [{
      id: "m",
      displayName: "Model",
      description: "Devin - m",
      maxOutputTokens: 300,
      capabilities: { images: true },
      privateData: { contextWindow: null, provider: null },
    }],
  );
});

function familyModel(
  modelUid: string,
  family: string,
  effort: string,
  fast: boolean | null,
): Record<string, unknown> {
  return {
    modelUid,
    label: modelUid,
    modelInfo: { modelFamilyUid: family },
    modelFamilyMetadata: {
      entries: [
        {
          key: "Effort",
          value: { order: 2, name: effort, controlType: "STEPPER" },
        },
        ...(fast === null ? [] : [{
          key: "Fast Mode",
          value: { ...(fast ? { order: 1 } : {}), controlType: "OPTION" },
        }]),
      ],
    },
  };
}

Deno.test("Catalog links each model to its Fast Mode sibling in the same family", () => {
  const models = parseModels({
    clientModelConfigs: [
      familyModel("opus-high", "opus", "High", false),
      familyModel("opus-high-fast", "opus", "High", true),
      familyModel("opus-max", "opus", "Max", false),
      familyModel("opus-max-fast", "opus", "Max", true),
      familyModel("opus-low", "opus", "Low", false),
      familyModel("glm-high", "glm", "High", null),
    ],
  });
  const fast = Object.fromEntries(
    models.map((model) => [
      model.id,
      (model.privateData as Record<string, unknown>).fastModelId ?? null,
    ]),
  );
  equal(fast, {
    "opus-high": "opus-high-fast",
    "opus-high-fast": null,
    "opus-max": "opus-max-fast",
    "opus-max-fast": null,
    "opus-low": null,
    "glm-high": null,
  });
});

Deno.test("Fast latency sends the Fast Mode sibling; models without one stay standard", async () => {
  const sent: string[] = [];
  const context: PluginContext = {
    signal: new AbortController().signal,
    network: {
      stream: () => Promise.reject(new Error("SSE is not used")),
      fetch: () => Promise.reject(new Error("fetch is not used")),
      streamBytes: async (_url, init) => {
        const body = Uint8Array.from(
          atob(init?.bodyBase64 ?? ""),
          (character) => character.charCodeAt(0),
        );
        sent.push(JSON.parse(new TextDecoder().decode(body.subarray(5))).chatModelUid);
        const reply = join(
          encodeFrame({ deltaText: "OK", stopReason: "STOP_REASON_STOP_PATTERN" }),
          endFrame(),
        );
        return { status: 200, headers: {}, chunks: chunks(reply, 7) };
      },
    },
  };
  const invoke = (
    model: { id: string; displayName: string; privateData?: JsonValue },
    latency: "fast" | "standard",
  ) =>
    devinProvider.invoke(
      {
        model,
        resource: {
          id: "r",
          type: "devin-account",
          key: "account",
          privateData: { token: "devin-session-token$t", displayName: "Account" },
          state: { status: "ready" as const },
        },
        request: { ...request(), latency },
      },
      { emit: () => {} },
      context,
    );
  const opus = {
    id: "opus-high",
    displayName: "Opus High",
    privateData: { fastModelId: "opus-high-fast" },
  };
  await invoke(opus, "fast");
  await invoke(opus, "standard");
  await invoke({ id: "glm-high", displayName: "GLM High" }, "fast");
  equal(sent, ["opus-high-fast", "opus-high", "glm-high"]);
});

Deno.test("Tool history keeps one assistant prompt and pairs parallel results by ID", () => {
  const assistant = {
    messageId: "a",
    source: 2,
    thinking: "Signed",
    toolCalls: [{ id: "one", name: "first", argumentsJson: "{}" }, {
      id: "two",
      name: "second",
      argumentsJson: "{}",
    }],
  };
  const one = { messageId: "1", source: 4, toolCallId: "one", prompt: "1" };
  const two = { messageId: "2", source: 4, toolCallId: "two", prompt: "2" };
  equal(pairToolResults([assistant, two, one]), [assistant, one, two]);
});

Deno.test("Request translation preserves schemas, aliases, replay, and current-turn images", async () => {
  const value = request();
  value.tools = [{
    name: "mcp::read",
    description: "Read exactly",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Exact path" } },
    },
  }];
  value.messages = [
    {
      role: "user",
      content: [{ type: "image", mediaType: "image/png", dataBase64: "OLD" }],
    },
    {
      role: "assistant",
      text: "",
      thinking: "Thought",
      replayState: {
        providerKind: "devin",
        value: {
          modelUid: "model",
          signature: "sig",
          signatureType: "sealed.v1",
          outputId: "output",
        },
      },
      toolCalls: [{
        index: 0,
        callId: "call",
        name: "mcp::read",
        arguments: { path: "file" },
      }],
    },
    {
      role: "tool",
      callId: "call",
      name: "mcp::read",
      content: "Done",
      isError: false,
      parts: [],
    },
    {
      role: "user",
      content: [{ type: "image", mediaType: "image/png", dataBase64: "NEW" }],
    },
  ];
  const first = await buildRequest(value, "model", "secret");
  const second = await buildRequest(value, "model", "secret");
  const body = first.body as Record<string, any>;
  equal(body.cascadeId, (second.body as Record<string, any>).cascadeId);
  equal(body.chatMessagePrompts[0].images, undefined);
  equal(body.chatMessagePrompts.at(-1).images[0].base64Data, "NEW");
  equal(body.chatMessagePrompts[1].signature, "sig");
  equal(first.originalNames.get(body.tools[0].name), "mcp::read");
  equal(body.tools[0].description, body.tools[0].name);
  equal(JSON.parse(body.tools[0].jsonSchemaString), {
    type: "object",
    properties: { path: { type: "string" } },
  });
  if (
    !body.prompt.includes("# tools descriptions\n<tool name=\"") ||
    !body.prompt.includes(">\nRead exactly") ||
    !body.prompt.includes("- path (string): Exact path")
  ) {
    throw new Error("Tool descriptions were not injected into the prompt");
  }
  const identity = (await buildRequest(
    {
      ...value,
      instructions: "You are an AI coding assistant.\nYou  operate in cursor.",
    },
    "model",
    "secret",
  )).body as Record<string, any>;
  if (!identity.prompt.includes("You operate in a code editor.")) {
    throw new Error("Competitor identity claim was not rewritten");
  }
  if (/you\s+operate\s+in\s+cursor/i.test(identity.prompt)) {
    throw new Error("Blocked identity phrase leaked into the Devin prompt");
  }
  const changed = (await buildRequest(value, "different-model", "secret"))
    .body as Record<string, any>;
  equal(changed.chatMessagePrompts[1].signature, undefined);
  await rejects(
    () =>
      buildRequest(
        {
          ...value,
          messages: value.messages.filter((message) => message.role !== "tool"),
        },
        "model",
        "secret",
      ),
    "Missing result",
  );
});

Deno.test("Response decoder preserves signed reasoning, tool deltas, aliases, and usage", () => {
  const events: ModelEvent[] = [];
  const decoder = new ResponseDecoder(
    "model",
    new Map([["tool", "mcp::read"]]),
    (event) => events.push(event),
  );
  decoder.push({
    deltaThinking: "Thought",
    deltaSignature: "first",
    deltaSignatureType: "sealed.v1",
  });
  decoder.push({ deltaText: "Working" });
  decoder.push({
    deltaToolCalls: [{ id: "call", name: "tool", argumentsJson: '{"path":' }],
  });
  decoder.push({ deltaToolCalls: [{ argumentsJson: '"file"}' }] });
  decoder.push({
    deltaSignature: "last",
    outputId: "out",
    stopReason: "STOP_REASON_FUNCTION_CALL",
    usage: { inputTokens: "5", outputTokens: "3", cacheReadTokens: "7" },
  });
  decoder.finish();
  equal(events.find((event) => event.type === "tool-call-start"), {
    type: "tool-call-start",
    index: 0,
    callId: "call",
    name: "mcp::read",
  });
  equal(events.find((event) => event.type === "replay-state"), {
    type: "replay-state",
    providerKind: "devin",
    value: {
      modelUid: "model",
      signature: "firstlast",
      signatureType: "sealed.v1",
      outputId: "out",
    },
  });
  equal(events.at(-1), { type: "done", reason: "tool-use" });
  equal(events.filter((event) => event.type === "thinking-start").length, 1);
});

Deno.test("Response decoder fails closed for malformed tools, refusal and incomplete answers", async () => {
  await rejects(() => {
    const decoder = new ResponseDecoder("m", new Map(), () => {});
    decoder.push({ deltaToolCalls: [{ name: "tool", argumentsJson: "{" }] });
    decoder.finish();
  }, "JSON");
  await rejects(() => {
    const decoder = new ResponseDecoder("m", new Map(), () => {});
    decoder.push({ deltaText: "Partial" });
    decoder.finish();
  }, "confirm completion");
  await rejects(() => {
    const decoder = new ResponseDecoder("m", new Map(), () => {});
    decoder.push({ usage: { providerRefusal: true } });
  }, "refused");
});

Deno.test("Provider renews authentication only before any output, and never replays a lost response", async () => {
  let calls = 0;
  let renewals = 0;
  const events: ModelEvent[] = [];
  let partial = false;
  const context: PluginContext = {
    signal: new AbortController().signal,
    network: {
      stream: () => Promise.reject(new Error("SSE is not used")),
      fetch: async (_url, init) => {
        equal(init?.headers?.["x-api-key"], "durable");
        renewals++;
        return {
          status: 200,
          headers: {},
          body: '{"sessionToken":"devin-session-token$new"}',
        };
      },
      streamBytes: async () => {
        calls++;
        const error = endFrame({
          error: { code: "unauthenticated", message: "Expired" },
        });
        const body = partial
          ? join(encodeFrame({ deltaText: "Partial" }), error)
          : calls === 1
          ? error
          : join(
            encodeFrame({
              deltaText: "OK",
              stopReason: "STOP_REASON_STOP_PATTERN",
            }),
            endFrame(),
          );
        return { status: 200, headers: {}, chunks: chunks(body, 3) };
      },
    },
  };
  const input = {
    model: { id: "m", displayName: "Model" },
    resource: {
      id: "r",
      type: "devin-account",
      key: "account",
      privateData: {
        token: "devin-session-token$old",
        apiKey: "durable",
        displayName: "Account",
      },
      state: { status: "ready" as const },
    },
    request: request(),
  };
  equal(
    (await devinProvider.invoke(input, {
      emit: (event) => events.push(event),
    }, context)).status,
    "completed",
  );
  equal([calls, renewals], [2, 1]);
  calls = renewals = 0;
  partial = true;
  equal(
    (await devinProvider.invoke(input, { emit: () => {} }, context)).status,
    "resource-error",
  );
  equal([calls, renewals], [1, 0]);
});

Deno.test("Provider maps account quota exhaustion into bounded cooling", async () => {
  const context: PluginContext = {
    signal: new AbortController().signal,
    network: {
      fetch: () => Promise.reject(new Error("fetch is not used")),
      stream: () => Promise.reject(new Error("SSE is not used")),
      streamBytes: async () => ({
        status: 200,
        headers: {},
        chunks: chunks(
          endFrame({
            error: { code: "resource_exhausted", message: "Quota reached" },
          }),
          3,
        ),
      }),
    },
  };
  const result = await devinProvider.invoke(
    {
      model: { id: "m", displayName: "Model" },
      resource: {
        id: "r",
        type: "devin-account",
        key: "account",
        privateData: {
          token: "devin-session-token$test",
          apiKey: null,
          displayName: "Account",
        },
        state: { status: "ready" },
      },
      request: request(),
    },
    { emit: () => {} },
    context,
  );
  equal(result.status, "resource-error");
  equal(result.patch?.state?.status, "cooling");
});

Deno.test("Devin browser OAuth, GetUserStatus quota, and rate-limit reset parsing match devin2api", async () => {
  const begun = await devinBrowserOAuth.begin(
    {
      redirectUri: "http://127.0.0.1:54321/callback",
      state: "state-1",
      codeChallenge: "challenge-1",
    },
    {
      signal: new AbortController().signal,
      network: {
        fetch: () => Promise.reject(new Error("unused")),
        stream: () => Promise.reject(new Error("unused")),
        streamBytes: () => Promise.reject(new Error("unused")),
      },
    },
  );
  if (
    !begun.authorizationUrl.startsWith(
      "https://app.devin.ai/auth/cli/continue?",
    ) ||
    !begun.authorizationUrl.includes("prompt=select_account") ||
    !begun.authorizationUrl.includes("code_challenge=challenge-1")
  ) {
    throw new Error(`Unexpected authorization URL: ${begun.authorizationUrl}`);
  }

  const parsed = parseDevinUserStatus(
    {
      userStatus: {
        name: "Amanda Borsoi",
        email: "amandaborsoi7@gmail.com",
        teamsTier: "TEAMS_TIER_DEVIN_MAX",
        planStatus: {
          planInfo: { planName: "Max", isDevin: true },
          dailyQuotaRemainingPercent: 100,
          weeklyQuotaRemainingPercent: 73,
          dailyQuotaResetAtUnix: "1791964800",
          weeklyQuotaResetAtUnix: "1792310400",
        },
      },
    },
    1_700_000_000_000,
  );
  equal(parsed.email, "amandaborsoi7@gmail.com");
  equal(parsed.quota?.planLabel, "Devin Max");
  equal(parsed.quota?.weekly?.remainingPercent, 73);
  equal(parsed.quota?.daily?.remainingPercent, 100);
  equal(parsed.quota?.weekly?.resetAtMs, 1792310400 * 1000);
  equal(parsed.quota?.limitReached, false);

  const view = presentAccount({
    id: "acc-1",
    type: "devin-account",
    key: "devin:amandaborsoi7@gmail.com",
    privateData: {
      token: "devin-session-token$test",
      apiKey: null,
      displayName: "Amanda Borsoi (amandaborsoi7@gmail.com)",
      email: "amandaborsoi7@gmail.com",
      quota: parsed.quota,
    },
    state: { status: "ready" },
  });
  equal(view.description, "Devin Max");
  equal(view.metrics?.length, 2);
  equal(view.metrics?.[0]?.value, 73);
  equal(view.metrics?.[1]?.value, 100);

  const nowMs = 1_700_000_000_000;
  equal(
    parseRateLimitResetMs(
      "Reached overall message rate limit. Your limit will reset in 30 seconds.",
      nowMs,
    ),
    nowMs + 30_000,
  );
  const minuteReset = parseRateLimitResetMs(
    "Reached overall message rate limit. Your limit will reset in 8 minutes.",
    nowMs,
  );
  if (minuteReset === null || minuteReset < nowMs + 8 * 60_000) {
    throw new Error(`Expected minute-aligned reset, got ${minuteReset}`);
  }
});
