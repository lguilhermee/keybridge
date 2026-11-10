import type {
  ChannelInvokeInput,
  ChannelOutput,
  ChannelResult,
  ChannelSupport,
} from "cursor-byok:channel";
import type { ProviderContext } from "cursor-byok:provider";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import { grokModels } from "./models.ts";
import { type AccountData, accountData, quotaExhaustedPatch, RESOURCE_TYPE } from "./resources.ts";

const CHAT_URL = "https://api.x.ai/v1/chat/completions";

/** In-stream errors only carry text, classified by credit/quota keywords. */
export function isQuotaError(error: string): boolean {
  const message = error.toLowerCase();
  return message.includes("insufficient_quota") ||
    message.includes("credits exhausted") ||
    message.includes("out of credits") ||
    message.includes("quota_exceeded") ||
    (message.includes("429") &&
      (message.includes("quota") || message.includes("credit") ||
        message.includes("insufficient")));
}

/** HTTP failures carry structured status codes; 429 always means exhausted quota and cools the account. */
function isQuotaHttpError(error: HttpError): boolean {
  if (error.status === 429) return true;
  const body = error.body.toLowerCase();
  return body.includes("insufficient_quota") ||
    body.includes("credits exhausted") ||
    body.includes("out of credits") ||
    // A free account hitting its spend limit returns 403 spending-limit - a quota issue, not auth.
    body.includes("spending-limit") ||
    body.includes("run out of credits") ||
    body.includes("quota_exceeded");
}

function invalidResult(message: string, stateMessage: string): ChannelResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message: stateMessage } },
  };
}

async function invoke(
  input: ChannelInvokeInput,
  output: ChannelOutput,
  context: ProviderContext,
): Promise<ChannelResult> {
  if (!input.resource) {
    return { status: "request-error", message: "add a Grok account before calling Grok" };
  }
  let data: AccountData;
  try {
    data = accountData(input.resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message, message);
  }
  try {
    await streamOpenAiChat(
      {
        url: CHAT_URL,
        model: input.model.id,
        // xAI rejects reasoning_effort and service_tier; thinking is decided by the model itself.
        request: {
          ...input.request,
          reasoning: { enabled: false, effort: null },
          latency: "standard",
        },
        headers: { authorization: `Bearer ${data.accessToken}` },
      },
      output,
      context,
    );
    return { status: "completed" };
  } catch (error) {
    if (error instanceof HttpError) {
      if ((error.status === 401 || error.status === 403) && !isQuotaHttpError(error)) {
        return invalidResult(error.message, "Grok authorization expired; sign in again");
      }
      if (isQuotaHttpError(error)) {
        return {
          status: "resource-error",
          message: error.message,
          patch: quotaExhaustedPatch(data),
        };
      }
      return { status: "request-error", message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isQuotaError(message)) {
      return { status: "resource-error", message, patch: quotaExhaustedPatch(data) };
    }
    return { status: "request-error", message };
  }
}

export const grokChannel: ChannelSupport = {
  id: "grok",
  displayName: "xAI Grok",
  description: {
    "en-US": "SuperGrok subscription access through the official Grok CLI endpoint.",
    "zh-CN": "通过官方 Grok CLI 接口使用 SuperGrok 订阅。",
  },
  brand: "xai",
  resourceType: RESOURCE_TYPE,
  models: grokModels,
  invoke,
};
