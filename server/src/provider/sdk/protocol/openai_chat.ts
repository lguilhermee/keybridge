import type { JsonValue, ProviderContext } from "../provider.ts";
import type { ChannelOutput, LlmContentPart, LlmRequest, ModelEvent } from "../channel.ts";

/** Replay-state kinds this protocol produces; identical to the host's built-in Chat Provider so they can replay each other. */
export const REPLAY_KIND = "openai_chat";

/** Thrown when upstream returns non-2xx; carries the full response body for the caller to classify. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}: ${body}`);
  }
}

export type OpenAiChatCall = {
  url: string;
  model: string;
  request: LlmRequest;
  headers?: Record<string, string>;
  /** Merged into the request body last. */
  extraBody?: Record<string, JsonValue>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Plain-text messages stay strings; with mixed images they expand into a parts array. */
function chatContent(parts: LlmContentPart[]): JsonValue {
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.type === "text" ? part.text : "").join("");
  }
  return parts.map((part): JsonValue =>
    part.type === "text" ? { type: "text", text: part.text } : {
      type: "image_url",
      image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
    }
  );
}

export function buildChatBody(call: OpenAiChatCall): Record<string, JsonValue> {
  const messages: JsonValue[] = [];
  if (call.request.instructions) {
    messages.push({ role: "system", content: call.request.instructions });
  }
  for (const message of call.request.messages) {
    if (message.role === "assistant") {
      const reasoning = message.replayState?.protocolKind === REPLAY_KIND
        ? text(record(message.replayState.value)?.reasoning_content)
        : null;
      // Chat Completions rejects empty-string assistant content; an assistant message with
      // no visible content at all is not sent.
      if (!message.text && message.toolCalls.length === 0 && !reasoning) continue;
      const value: Record<string, JsonValue> = {
        role: "assistant",
        content: message.text ? message.text : null,
      };
      if (reasoning) value.reasoning_content = reasoning;
      if (message.toolCalls.length > 0) {
        value.tool_calls = message.toolCalls.map((toolCall) => ({
          id: toolCall.callId,
          type: "function",
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
        }));
      }
      messages.push(value);
    } else if (message.role === "tool") {
      messages.push({
        role: "tool",
        content: message.parts.length === 0 ? message.content : chatContent(message.parts),
        tool_call_id: message.callId,
      });
    } else {
      messages.push({ role: message.role, content: chatContent(message.content) });
    }
  }
  const body: Record<string, JsonValue> = {
    model: call.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (call.request.tools.length > 0) {
    body.tools = call.request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (call.request.maxOutputTokens !== null) {
    body.max_completion_tokens = call.request.maxOutputTokens;
  }
  if (call.request.reasoning.effort !== null) {
    body.reasoning_effort = call.request.reasoning.effort;
  }
  // OpenAI's canonical tier value is priority; "fast" is only a client-side alias upstream rejects.
  if (call.request.latency === "fast") body.service_tier = "priority";
  if (call.request.cacheKey !== null) body.prompt_cache_key = call.request.cacheKey;
  return { ...body, ...call.extraBody };
}

type ToolState = {
  callId: string;
  name: string;
  arguments: string;
  emitted: number;
  started: boolean;
};

/** Some upstreams resend whole chunks instead of deltas; dedupe before concatenating. */
function mergeFragment(target: string, fragment: string): string {
  if (target === fragment || target.endsWith(fragment)) return target;
  if (fragment.startsWith(target)) return fragment;
  return target + fragment;
}

function updateTool(
  index: number,
  callId: string | null,
  name: string | null,
  argumentsDelta: string | null,
  tools: Map<number, ToolState>,
): ModelEvent[] {
  let tool = tools.get(index);
  if (!tool) {
    tool = { callId: "", name: "", arguments: "", emitted: 0, started: false };
    tools.set(index, tool);
  }
  if (callId !== null) tool.callId = mergeFragment(tool.callId, callId);
  if (name !== null) tool.name = mergeFragment(tool.name, name);
  if (argumentsDelta !== null) tool.arguments += argumentsDelta;

  const events: ModelEvent[] = [];
  if (!tool.started && tool.callId && tool.name) {
    tool.started = true;
    events.push({ type: "tool-call-start", index, callId: tool.callId, name: tool.name });
  }
  if (tool.started && tool.emitted < tool.arguments.length) {
    events.push({
      type: "tool-call-arguments-delta",
      index,
      delta: tool.arguments.slice(tool.emitted),
    });
    tool.emitted = tool.arguments.length;
  }
  return events;
}

function eventError(value: Record<string, unknown>): string | null {
  const error = value.error;
  if (error === undefined || error === null) return null;
  if (typeof error === "string") return error;
  return text(record(error)?.message) ?? JSON.stringify(error);
}

function usageEvent(value: unknown): ModelEvent {
  const usage = record(value) ?? {};
  const promptTokens = count(usage.prompt_tokens);
  const cachedTokens = count(record(usage.prompt_tokens_details)?.cached_tokens);
  return {
    type: "usage",
    usage: {
      inputTokens: promptTokens === null ? null : Math.max(0, promptTokens - (cachedTokens ?? 0)),
      outputTokens: count(usage.completion_tokens),
      totalTokens: count(usage.total_tokens),
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: null,
      reasoningTokens: count(record(usage.completion_tokens_details)?.reasoning_tokens),
    },
  };
}

type Finish = "stop" | "length" | "tool-use" | "refusal";

function mapFinish(reason: string, hasTools: boolean): Finish {
  if (reason === "tool_calls" || reason === "function_call") return "tool-use";
  if (reason === "length") return "length";
  if (reason === "stop") return "stop";
  // A filtered answer is declined on policy grounds; it is not an ordinary stop.
  if (reason === "content_filter") return "refusal";
  return hasTools ? "tool-use" : "stop";
}

async function readBody(lines: AsyncIterable<string>): Promise<string> {
  const collected: string[] = [];
  for await (const line of lines) collected.push(line);
  return collected.join("\n");
}

/**
 * Runs one Chat Completions streaming call, emitting normalized events matching the host's unified event set,
 * including text/thinking boundaries and tool-argument deltas. Non-2xx responses throw `HttpError`,
 * in-stream failures throw `Error`; the caller classifies quota vs auth issues.
 */
export async function streamOpenAiChat(
  call: OpenAiChatCall,
  output: ChannelOutput,
  context: ProviderContext,
): Promise<void> {
  const response = await context.network.stream(call.url, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      ...call.headers,
    },
    body: JSON.stringify(buildChatBody(call)),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(response.status, await readBody(response.lines));
  }

  let textOpen = false;
  let thinkingOpen = false;
  let reasoning = "";
  const tools = new Map<number, ToolState>();
  let finalUsage: ModelEvent | null = null;
  let finish: Finish | null = null;
  let sawDoneMarker = false;

  for await (const line of response.lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      sawDoneMarker = true;
      break;
    }
    let value: Record<string, unknown>;
    try {
      value = record(JSON.parse(payload)) ?? {};
    } catch {
      throw new Error("OpenAI Chat SSE returned invalid JSON");
    }
    const error = eventError(value);
    if (error !== null) throw new Error(`OpenAI Chat error: ${error}`);
    if (value.usage !== undefined && value.usage !== null) {
      finalUsage = usageEvent(value.usage);
    }
    const choice = Array.isArray(value.choices) ? record(value.choices[0]) : null;
    if (!choice) continue;
    const delta = record(choice.delta) ?? {};
    const reasoningDelta = text(delta.reasoning_content) ?? text(delta.reasoning);
    if (reasoningDelta) {
      if (!thinkingOpen) {
        thinkingOpen = true;
        output.emit({ type: "thinking-start" });
      }
      reasoning += reasoningDelta;
      output.emit({ type: "thinking-delta", text: reasoningDelta });
    }
    const content = text(delta.content);
    if (content) {
      if (thinkingOpen) {
        thinkingOpen = false;
        output.emit({ type: "thinking-end" });
      }
      if (!textOpen) {
        textOpen = true;
        output.emit({ type: "text-start" });
      }
      output.emit({ type: "text-delta", text: content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const [position, rawTool] of delta.tool_calls.entries()) {
        const toolDelta = record(rawTool);
        if (!toolDelta) continue;
        const index = count(toolDelta.index) ?? position;
        const fn = record(toolDelta.function) ?? {};
        for (
          const event of updateTool(
            index,
            text(toolDelta.id),
            text(fn.name),
            text(fn.arguments),
            tools,
          )
        ) {
          output.emit(event);
        }
      }
    }
    const finishReason = text(choice.finish_reason);
    if (finishReason !== null) finish = mapFinish(finishReason, tools.size > 0);
  }

  if (thinkingOpen) output.emit({ type: "thinking-end" });
  if (textOpen) output.emit({ type: "text-end" });
  for (const [index, tool] of tools) {
    if (!tool.started) {
      if (!tool.name) throw new Error("OpenAI Chat tool call is missing name");
      if (!tool.callId) tool.callId = `call-${index}`;
      tool.started = true;
      output.emit({ type: "tool-call-start", index, callId: tool.callId, name: tool.name });
      if (tool.arguments) {
        tool.emitted = tool.arguments.length;
        output.emit({ type: "tool-call-arguments-delta", index, delta: tool.arguments });
      }
    }
    output.emit({ type: "tool-call-end", index });
  }
  if (finalUsage !== null) output.emit(finalUsage);
  if (reasoning) {
    output.emit({
      type: "replay-state",
      protocolKind: REPLAY_KIND,
      value: { reasoning_content: reasoning },
    });
  }
  const reason = finish ??
    (sawDoneMarker ? (tools.size > 0 ? "tool-use" : "stop") : null);
  if (reason === null) {
    throw new Error("OpenAI Chat stream ended without finish_reason");
  }
  output.emit(
    reason === "refusal"
      ? { type: "done", reason, category: null, explanation: null }
      : { type: "done", reason },
  );
}
