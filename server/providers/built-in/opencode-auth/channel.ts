import type { JsonValue } from "cursor-byok:provider";
import type { ChannelSupport } from "cursor-byok:channel";
import { HttpError as ChatHttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import {
  HttpError as ResponsesHttpError,
  streamOpenAiResponses,
} from "cursor-byok:protocol/openai-responses";
import { opencodeModels, type Lane } from "./models.ts";
import {
  accountData,
  API_BASE,
  authHeaders,
  isOpenCodeQuotaError,
  quotaExhaustedPatch,
  RESOURCE_TYPE,
} from "./resources.ts";

const CHAT_URL = `${API_BASE}/chat/completions`;
const RESPONSES_URL = `${API_BASE}/responses`;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * The x-opencode-session header replicates the official client's ses_<12hex><14base62> format;
 * session affinity + usage attribution are derived stably from the cacheKey.
 */
export async function sessionId(cacheKey: string | null): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `opencode\0cursor-byok\0${cacheKey ?? "default"}`,
      ),
    ),
  );
  const timeHex = [...digest.subarray(0, 6)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  let randomPart = "";
  for (let index = 6; index < 20; index++) {
    randomPart += BASE62[digest[index] % 62];
  }
  return `ses_${timeHex}${randomPart}`;
}

function requestLane(privateData: JsonValue | undefined): Lane {
  const data = privateData as Record<string, JsonValue> | null | undefined;
  return data?.lane === "responses" ? "responses" : "chat";
}

/**
 * Zen's chat lane only accepts three thinking levels: low/high/max; Cursor's aliases
 * (xhigh, minimal, medium, etc.) are clamped into that set; unrecognized values pass through.
 */
export function zenEffort(effort: string | null): string | null {
  if (effort === null) return null;
  switch (effort.toLowerCase()) {
    case "minimal":
    case "none":
    case "off":
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
    case "xhigh":
    case "ultra":
    case "max":
      return "max";
    default:
      return effort;
  }
}

function invalidResource(message: string) {
  return {
    status: "resource-error" as const,
    message,
    patch: {
      state: {
        status: "invalid" as const,
        message: "OpenCode Go API key rejected; import a fresh key",
      },
    },
  };
}

/** 403 EntitlementError = no subscription; other 4xx are treated as request problems. */
function isEntitlementError(body: string): boolean {
  return /EntitlementError|subscription required|no active subscription/i.test(body);
}

export const opencodeChannel: ChannelSupport = {
  id: "opencode-go",
  displayName: "OpenCode Go",
  description:
    "Connect to OpenCode Go with a subscription API key from opencode.ai/auth. Model calls run inside Keybridge.",
  brand: "opencode",
  resourceType: RESOURCE_TYPE,
  models: opencodeModels,
  async invoke(input, output, context) {
    if (!input.resource) {
      return {
        status: "request-error",
        message: "Import an OpenCode Go API key first",
      };
    }
    const data = { ...accountData(input.resource) };
    const session = await sessionId(input.request.cacheKey);
    const headers = {
      ...authHeaders(data.apiKey),
      "x-opencode-session": session,
    };
    const redact = (message: string) =>
      message.replaceAll(data.apiKey, "[redacted]");
    try {
      if (requestLane(input.model.privateData) === "responses") {
        await streamOpenAiResponses(
          {
            url: RESPONSES_URL,
            model: input.model.id,
            request: input.request,
            headers,
            extraBody: { store: false },
          },
          output,
          context,
        );
      } else {
        await streamOpenAiChat(
          {
            url: CHAT_URL,
            model: input.model.id,
            request: {
              ...input.request,
              reasoning: {
                ...input.request.reasoning,
                effort: zenEffort(input.request.reasoning.effort),
              },
            },
            headers,
          },
          output,
          context,
        );
      }
      return { status: "completed" };
    } catch (error) {
      const status = error instanceof ChatHttpError || error instanceof ResponsesHttpError
        ? error.status
        : 0;
      const body = error instanceof ChatHttpError || error instanceof ResponsesHttpError
        ? error.body
        : "";
      const message = redact(error instanceof Error ? error.message : String(error));
      if (status === 401) return invalidResource(message);
      if (status === 403 && isEntitlementError(body)) {
        return {
          status: "resource-error",
          message,
          patch: {
            state: {
              status: "invalid",
              message: "OpenCode Go subscription required for this key",
            },
          },
        };
      }
      if (
        status === 429 || status === 402 || isOpenCodeQuotaError(message) ||
        isOpenCodeQuotaError(body)
      ) {
        return {
          status: "resource-error",
          message,
          patch: await quotaExhaustedPatch(data, message, context),
        };
      }
      return { status: "request-error", message };
    }
  },
};
