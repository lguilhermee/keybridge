import type { JsonValue } from "cursor-byok:provider";
import type {
  LlmContentPart,
  LlmRequest,
  LlmTool,
  ModelUsage,
} from "cursor-byok:channel";
import {
  ANTHROPIC_VERSION,
  CLAUDE_CLI_VERSION,
  type AccountData,
} from "./resources.ts";
import { FAST_MODE_MODELS } from "./models.ts";

export const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";
export const REPLAY_KIND = "claude";
export const TOOL_SUFFIX = "_ide";
const CLAUDE_CODE_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

// Claude Code's own chat headers; OAuth subscription tokens are bound to this
// client identity, so the request must present it end to end.
const BETA_FLAGS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
];

type Block = Record<string, unknown>;

async function sha256Hex(input: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deriveUuid(hash: string): string {
  const hex = hash.replace(/[^0-9a-f]/gi, "").toLowerCase().padEnd(32, "0");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}` +
    `-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function textBlock(text: string): Block {
  return { type: "text", text };
}

function contentParts(parts: LlmContentPart[]): Block[] {
  const blocks: Block[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) blocks.push(textBlock(part.text));
    } else {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType,
          data: part.dataBase64,
        },
      });
    }
  }
  return blocks;
}

function cloakName(name: string): string {
  return `${name}${TOOL_SUFFIX}`;
}

export function decloakName(name: string, map: Map<string, string>): string {
  const mapped = map.get(name);
  if (mapped) return mapped;
  if (name.endsWith(TOOL_SUFFIX) && name.length > TOOL_SUFFIX.length) {
    return name.slice(0, -TOOL_SUFFIX.length);
  }
  return name;
}

function pushMessage(output: Block[], role: string, content: Block[]): void {
  const last = output[output.length - 1];
  if (last?.role === role && Array.isArray(last.content)) {
    (last.content as Block[]).push(...content);
    return;
  }
  output.push({ role, content });
}

function markCacheBreakpoint(messages: Block[]): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const content = message.content as Block[];
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      const kind = content[blockIndex].type;
      if (kind === "text" || kind === "image" || kind === "tool_result") {
        content[blockIndex] = {
          ...content[blockIndex],
          cache_control: { type: "ephemeral", ttl: "5m" },
        };
        return;
      }
    }
  }
}

function messagesFromRequest(request: LlmRequest): Block[] {
  const output: Block[] = [];
  for (const message of request.messages) {
    switch (message.role) {
      case "system":
      case "user": {
        const content = contentParts(message.content);
        if (content.length) pushMessage(output, "user", content);
        break;
      }
      case "tool": {
        const content = message.parts.length
          ? contentParts(message.parts)
          : message.content;
        pushMessage(output, "user", [{
          type: "tool_result",
          tool_use_id: message.callId,
          content,
          ...(message.isError ? { is_error: true } : {}),
        }]);
        break;
      }
      case "assistant": {
        const content: Block[] = [];
        const replay = message.replayState;
        if (replay?.protocolKind === REPLAY_KIND) {
          const blocks = (replay.value as Record<string, JsonValue>)?.blocks;
          if (Array.isArray(blocks)) content.push(...(blocks as Block[]));
        }
        if (message.text) content.push(textBlock(message.text));
        for (const call of message.toolCalls) {
          content.push({
            type: "tool_use",
            id: call.callId,
            name: cloakName(call.name),
            input: call.arguments,
          });
        }
        if (content.length) pushMessage(output, "assistant", content);
        break;
      }
    }
  }
  return output;
}

// Anthropic rejects a tool schema with oneOf/anyOf/allOf at the top level, so
// the branches are folded into one object schema: their properties are merged,
// and only allOf branches contribute required fields.
export function anthropicInputSchema(schema: JsonValue): JsonValue {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema;
  }
  const { oneOf, anyOf, allOf, ...base } = schema as Record<string, JsonValue>;
  if (oneOf === undefined && anyOf === undefined && allOf === undefined) {
    return schema;
  }
  const properties: Record<string, JsonValue> = {};
  const required = new Set<string>();
  const merge = (branch: JsonValue, enforce: boolean) => {
    if (typeof branch !== "object" || branch === null || Array.isArray(branch)) {
      return;
    }
    const fields = branch as Record<string, JsonValue>;
    const props = fields.properties;
    if (typeof props === "object" && props !== null && !Array.isArray(props)) {
      for (const [key, value] of Object.entries(props)) {
        if (!(key in properties)) properties[key] = value;
      }
    }
    if (enforce && Array.isArray(fields.required)) {
      for (const key of fields.required) {
        if (typeof key === "string") required.add(key);
      }
    }
  };
  merge(base, true);
  for (const [branches, enforce] of [[allOf, true], [anyOf, false], [oneOf, false]] as const) {
    if (Array.isArray(branches)) for (const branch of branches) merge(branch, enforce);
  }
  return {
    ...base,
    type: "object",
    properties,
    ...(required.size ? { required: [...required] } : {}),
  };
}

function toolsFromRequest(request: LlmRequest): {
  tools: Block[];
  nameMap: Map<string, string>;
} {
  const nameMap = new Map<string, string>();
  const tools = request.tools.map((tool: LlmTool, index: number) => {
    const suffixed = cloakName(tool.name);
    nameMap.set(suffixed, tool.name);
    const declaration: Block = {
      name: suffixed,
      description: tool.description,
      input_schema: anthropicInputSchema(tool.parameters),
    };
    if (index + 1 === request.tools.length) {
      declaration.cache_control = { type: "ephemeral", ttl: "1h" };
    }
    return declaration;
  });
  return { tools, nameMap };
}

// Anthropic only issues subscription OAuth tokens to the Claude Code client;
// these fields reproduce that client's request identity.
export async function buildRequest(
  request: LlmRequest,
  model: string,
  maxOutputTokens: number | null,
  account: AccountData,
): Promise<{ body: string; headers: Record<string, string>; nameMap: Map<string, string> }> {
  const tokenHash = await sha256Hex(account.accessToken);
  const sessionHash = await sha256Hex(`session:${request.cacheKey ?? tokenHash}`);
  const sessionId = deriveUuid(sessionHash);
  const deviceHash = await sha256Hex(`device:${account.accessToken}`);
  const accountUuid = account.accountUuid ??
    deriveUuid(await sha256Hex(`account:${account.accessToken}`));

  const billing = `x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION}.${
    tokenHash.slice(0, 3)
  }; cc_entrypoint=sdk-cli; cch=${tokenHash.slice(0, 5)};`;

  const system: Block[] = [textBlock(billing), textBlock(CLAUDE_CODE_PROMPT)];
  if (request.instructions.trim()) {
    system.push({
      type: "text",
      text: request.instructions,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  } else {
    system[system.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
  }

  const messages = messagesFromRequest(request);
  markCacheBreakpoint(messages);
  const { tools, nameMap } = toolsFromRequest(request);

  const body: Record<string, unknown> = {
    model,
    system,
    messages,
    max_tokens: request.maxOutputTokens ?? maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream: true,
    temperature: 1,
    metadata: {
      user_id: JSON.stringify({
        device_id: deviceHash,
        account_uuid: accountUuid,
        session_id: sessionId,
      }),
    },
  };
  if (tools.length) body.tools = tools;
  if (request.reasoning.enabled) {
    body.thinking = { type: "adaptive", display: "summarized" };
  }
  if (request.reasoning.effort) {
    body.output_config = { effort: request.reasoning.effort };
  }
  if (request.latency === "fast" && FAST_MODE_MODELS.has(model)) {
    body.speed = "fast";
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${account.accessToken}`,
    "content-type": "application/json",
    accept: "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": BETA_FLAGS.join(","),
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,
    "x-stainless-helper-method": "stream",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime-version": "v24.14.0",
    "x-stainless-package-version": "0.80.0",
    "x-stainless-runtime": "node",
    "x-stainless-lang": "js",
    "x-stainless-arch": "x64",
    "x-stainless-os": "Windows",
    "x-stainless-timeout": "600",
  };
  return { body: JSON.stringify(body), headers, nameMap };
}

export type AnthropicError = {
  status: number;
  message: string;
  kind: string | null;
};

/** Uniform error-object extraction for non-2xx bodies and SSE error events. */
export function anthropicError(status: number, body: string): AnthropicError {
  let kind: string | null = null;
  let message = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    if (error) {
      kind = typeof error.type === "string" ? error.type : null;
      if (typeof error.message === "string" && error.message) {
        message = error.message;
      }
    }
  } catch {
    // Non-JSON error bodies are returned truncated as-is.
  }
  return { status, message: `Claude HTTP ${status}: ${message}`, kind };
}

export function mergeUsage(total: ModelUsage, update: ModelUsage): ModelUsage {
  const merge = (a: number | null, b: number | null) =>
    b === null ? a : Math.max(a ?? 0, b);
  const inputTokens = merge(total.inputTokens, update.inputTokens);
  const cacheRead = merge(total.cacheReadTokens, update.cacheReadTokens);
  const cacheWrite = merge(total.cacheWriteTokens, update.cacheWriteTokens);
  const outputTokens = merge(total.outputTokens, update.outputTokens);
  const contextInput = inputTokens === null
    ? null
    : inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: contextInput !== null && outputTokens !== null
      ? contextInput + outputTokens
      : merge(total.totalTokens, update.totalTokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: merge(total.reasoningTokens, update.reasoningTokens),
  };
}

export function anthropicUsage(value: unknown): ModelUsage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const read = (key: string) => {
    const raw = usage[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };
  return {
    inputTokens: read("input_tokens"),
    outputTokens: read("output_tokens"),
    totalTokens: read("total_tokens"),
    cacheReadTokens: read("cache_read_input_tokens"),
    cacheWriteTokens: read("cache_creation_input_tokens"),
    reasoningTokens: null,
  };
}
