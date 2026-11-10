import type { JsonValue } from "cursor-byok:provider";
import type {
  ModelEvent,
  ModelUsage,
  ChannelSupport,
} from "cursor-byok:channel";
import { claudeModels } from "./models.ts";
import {
  anthropicError,
  anthropicUsage,
  buildRequest,
  decloakName,
  MESSAGES_URL,
  mergeUsage,
  REPLAY_KIND,
} from "./request.ts";
import {
  accountData,
  isClaudeQuotaError,
  quotaExhaustedPatch,
  refreshAccessToken,
  RESOURCE_TYPE,
  tokenNeedsRefresh,
  type AccountData,
} from "./resources.ts";

const TOKEN_EXPIRING_SOON_MS = 60 * 1000;

type SseEvent = { event: string; data: string };

/** Line-based SSE parsing: the host delivers the body line by line; this only frames events. */
async function* parseSse(lines: AsyncIterable<string>): AsyncGenerator<SseEvent> {
  let event = "";
  let data = "";
  for await (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      if (data || event) {
        yield { event, data };
        event = "";
        data = "";
      }
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data = data ? `${data}\n${line.slice(5).trimStart()}` : line.slice(5).trimStart();
    }
  }
  if (data || event) yield { event, data };
}

class StreamError extends Error {
  status: number;
  kind: string | null;
  constructor(status: number, message: string, kind: string | null) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

/** Model declined before emitting text/tool content; safe to resend silently. */
class RefusalError extends Error {}

const REFUSAL_MAX_ATTEMPTS = 3;

/** Anthropic stream -> ModelEvent; thinking blocks (with signatures) are kept for replay on the next turn. */
async function streamMessages(
  lines: AsyncIterable<string>,
  nameMap: Map<string, string>,
  emit: (event: ModelEvent) => void,
  retryRefusal: boolean,
): Promise<void> {
  const blockTypes = new Map<number, string>();
  const thinkingText = new Map<number, string>();
  const thinkingSignatures = new Map<number, string>();
  const thinkingBlocks: JsonValue[] = [];
  let finish: "stop" | "length" | "tool-use" | null = null;
  let sawTool = false;
  let committed = false;
  let refused = false;
  let refusalMessage = "Claude refused the request";
  let refusalDefinitive = false;
  let terminal = false;
  let usage: ModelUsage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };

  const closeBlock = (index: number, kind: string) => {
    if (kind === "text") {
      emit({ type: "text-end" });
    } else if (kind === "thinking") {
      const thinking = thinkingText.get(index) ?? "";
      const signature = thinkingSignatures.get(index) ?? "";
      if (signature) {
        thinkingBlocks.push({ type: "thinking", thinking, signature });
      }
      emit({ type: "thinking-end" });
    } else if (kind === "tool_use") {
      emit({ type: "tool-call-end", index });
    }
    thinkingText.delete(index);
    thinkingSignatures.delete(index);
  };

  for await (const sse of parseSse(lines)) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(sse.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (sse.event === "error" || value.type === "error") {
      const error = value.error as Record<string, unknown> | undefined;
      throw new StreamError(
        0,
        `Claude stream error: ${
          typeof error?.message === "string" ? error.message : sse.data.slice(0, 300)
        }`,
        typeof error?.type === "string" ? error.type : null,
      );
    }
    const kind = sse.event || (typeof value.type === "string" ? value.type : "");
    switch (kind) {
      case "message_start": {
        const message = value.message as Record<string, unknown> | undefined;
        if (message?.usage) usage = mergeUsage(usage, anthropicUsage(message.usage));
        break;
      }
      case "content_block_start": {
        const index = typeof value.index === "number" ? value.index : -1;
        const block = (value.content_block ?? {}) as Record<string, unknown>;
        const blockKind = typeof block.type === "string" ? block.type : "";
        blockTypes.set(index, blockKind);
        if (blockKind === "text") {
          emit({ type: "text-start" });
        } else if (blockKind === "thinking") {
          thinkingText.set(index, "");
          thinkingSignatures.set(index, "");
          emit({ type: "thinking-start" });
        } else if (blockKind === "redacted_thinking") {
          thinkingBlocks.push(block as JsonValue);
        } else if (blockKind === "tool_use") {
          sawTool = true;
          committed = true;
          const name = typeof block.name === "string"
            ? decloakName(block.name, nameMap)
            : "";
          emit({
            type: "tool-call-start",
            index,
            callId: typeof block.id === "string" ? block.id : `call-${index}`,
            name,
          });
        }
        break;
      }
      case "content_block_delta": {
        const index = typeof value.index === "number" ? value.index : -1;
        const delta = (value.delta ?? {}) as Record<string, unknown>;
        const deltaKind = typeof delta.type === "string" ? delta.type : "";
        if (!blockTypes.has(index)) {
          if (deltaKind === "text_delta") {
            blockTypes.set(index, "text");
            emit({ type: "text-start" });
          } else if (deltaKind === "thinking_delta" || deltaKind === "signature_delta") {
            blockTypes.set(index, "thinking");
            thinkingText.set(index, "");
            thinkingSignatures.set(index, "");
            emit({ type: "thinking-start" });
          }
        }
        if (deltaKind === "text_delta" && typeof delta.text === "string") {
          committed = true;
          emit({ type: "text-delta", text: delta.text });
        } else if (deltaKind === "thinking_delta" && typeof delta.thinking === "string") {
          thinkingText.set(index, (thinkingText.get(index) ?? "") + delta.thinking);
          emit({ type: "thinking-delta", text: delta.thinking });
        } else if (
          deltaKind === "signature_delta" && typeof delta.signature === "string"
        ) {
          thinkingSignatures.set(
            index,
            (thinkingSignatures.get(index) ?? "") + delta.signature,
          );
        } else if (
          deltaKind === "input_json_delta" && typeof delta.partial_json === "string"
        ) {
          emit({ type: "tool-call-arguments-delta", index, delta: delta.partial_json });
        }
        break;
      }
      case "content_block_stop": {
        const index = typeof value.index === "number" ? value.index : -1;
        const kind = blockTypes.get(index);
        if (kind !== undefined) {
          blockTypes.delete(index);
          closeBlock(index, kind);
        }
        break;
      }
      case "message_delta": {
        if (value.usage) usage = mergeUsage(usage, anthropicUsage(value.usage));
        const delta = value.delta as Record<string, unknown> | undefined;
        const reason = typeof delta?.stop_reason === "string" ? delta.stop_reason : null;
        if (reason === "refusal") {
          refused = true;
          const details = delta?.stop_details as Record<string, unknown> | undefined;
          const category = typeof details?.category === "string" ? details.category : null;
          const explanation = typeof details?.explanation === "string"
            ? details.explanation
            : null;
          // A categorized stop_details is a policy verdict; resending identical
          // bytes only repeats the refusal.
          refusalDefinitive = category !== null;
          refusalMessage = explanation
            ? `Claude refused the request${category ? ` (${category})` : ""}: ${explanation}`
            : refusalMessage;
        }
        if (reason === "tool_use") finish = "tool-use";
        else if (reason === "max_tokens" || reason === "model_context_window_exceeded") {
          finish = "length";
        } else if (reason !== null) {
          finish = sawTool && reason !== "end_turn" && reason !== "stop_sequence" &&
              reason !== "pause_turn" && reason !== "refusal"
            ? "tool-use"
            : "stop";
        }
        break;
      }
      case "message_stop":
      case "message_end": {
        terminal = true;
        break;
      }
    }
    if (terminal) break;
  }

  for (const [index, kind] of blockTypes) closeBlock(index, kind);
  if (thinkingBlocks.length) {
    emit({ type: "replay-state", protocolKind: REPLAY_KIND, value: { blocks: thinkingBlocks } });
  }
  if (!terminal && finish === null) {
    throw new StreamError(0, "Claude stream ended without message_stop", null);
  }
  if (refused && !committed) {
    if (retryRefusal && !refusalDefinitive) throw new RefusalError(refusalMessage);
    throw new StreamError(0, refusalMessage, "refusal");
  }
  emit({ type: "usage", usage });
  emit({
    type: "done",
    reason: finish === "length" ? "length" : sawTool ? "tool-use" : finish ?? "stop",
  });
}

function invalidResource(message: string): {
  status: "resource-error";
  message: string;
  patch: { state: { status: "invalid"; message: string } };
} {
  return {
    status: "resource-error",
    message,
    patch: {
      state: {
        status: "invalid",
        message: "Claude authorization failed; sign in again",
      },
    },
  };
}

export const claudeChannel: ChannelSupport = {
  id: "claude",
  displayName: "Claude",
  description:
    "Connect to Claude with a Claude Code subscription account. Model calls run inside Cursor BYOK.",
  brand: "claude",
  resourceType: RESOURCE_TYPE,
  models: claudeModels,
  async invoke(input, output, context) {
    if (!input.resource) {
      return {
        status: "request-error",
        message: "Add a Claude account first",
      };
    }
    let data: AccountData = { ...accountData(input.resource) };
    let emitted = false;
    const emit = (event: ModelEvent) => {
      emitted = true;
      output.emit(event);
    };
    const secrets = () => [data.accessToken, data.refreshToken ?? ""];
    const redact = (message: string) => {
      for (const secret of secrets()) {
        if (secret) message = message.replaceAll(secret, "[redacted]");
      }
      return message;
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (tokenNeedsRefresh(data, TOKEN_EXPIRING_SOON_MS)) {
          try {
            const tokens = await refreshAccessToken(data.refreshToken!, context);
            data = { ...data, ...tokens };
          } catch {
            return invalidResource("Claude token refresh failed");
          }
        }
        const { body, headers, nameMap } = await buildRequest(
          input.request,
          input.model.id,
          input.model.maxOutputTokens ?? null,
          data,
        );
        let refusalError: RefusalError | null = null;
        for (let retry = 0; retry < REFUSAL_MAX_ATTEMPTS; retry++) {
          const response = await context.network.stream(MESSAGES_URL, {
            method: "POST",
            headers,
            body,
          });
          if (response.status !== 200) {
            let errorBody = "";
            for await (const line of response.lines) {
              if (errorBody.length < 256 * 1024) errorBody += `${line}\n`;
            }
            const error = anthropicError(response.status, errorBody);
            throw new StreamError(error.status, error.message, error.kind);
          }
          try {
            await streamMessages(
              response.lines,
              nameMap,
              emit,
              retry + 1 < REFUSAL_MAX_ATTEMPTS,
            );
          } catch (error) {
            if (!(error instanceof RefusalError)) throw error;
            refusalError = error;
            continue;
          }
          return {
            status: "completed",
            patch: { privateData: data },
          };
        }
        throw new StreamError(
          0,
          refusalError?.message ?? "Claude refusal retries exhausted",
          "refusal",
        );
      } catch (error) {
        const message = redact(
          error instanceof Error ? error.message : String(error),
        );
        const status = error instanceof StreamError ? error.status : 0;
        const kind = error instanceof StreamError ? error.kind : null;
        const unauthenticated = status === 401 || kind === "authentication_error";
        if (unauthenticated && !emitted && attempt === 0 && data.refreshToken) {
          try {
            const tokens = await refreshAccessToken(data.refreshToken, context);
            data = { ...data, ...tokens };
            continue;
          } catch (refreshError) {
            return invalidResource(redact(
              refreshError instanceof Error
                ? refreshError.message
                : String(refreshError),
            ));
          }
        }
        if (unauthenticated) {
          return invalidResource(message);
        }
        if (
          status === 429 || kind === "rate_limit_error" || kind === "overloaded_error" ||
          isClaudeQuotaError(message)
        ) {
          return {
            status: "resource-error",
            message,
            patch: await quotaExhaustedPatch(data, message, context),
          };
        }
        return {
          status: "request-error",
          message,
          patch: { privateData: data },
        };
      }
    }
    return invalidResource("Claude credential renewal failed");
  },
};
