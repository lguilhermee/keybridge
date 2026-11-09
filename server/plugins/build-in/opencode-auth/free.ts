import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import type {
  LlmMessage,
  LlmRequest,
  LlmTool,
  ProviderOutput,
  ProviderSupport,
} from "cursor-byok:provider";
import {
  HttpError as ChatHttpError,
  REPLAY_KIND as CHAT_REPLAY_KIND,
  streamOpenAiChat,
} from "cursor-byok:protocol/openai-chat";
import {
  HttpError as ResponsesHttpError,
  streamOpenAiResponses,
} from "cursor-byok:protocol/openai-responses";
import { type Lane, laneForModel } from "./models.ts";

/**
 * OpenCode anonymous free lane (/inference/v1), a port of 9router's opencode provider:
 * `Authorization: Bearer public` + the v2 CLI fingerprint. Upstream has three gates:
 * 1. The cipher-list hash of the TLS ClientHello (orchestrated by the host, see manifest tlsEmulation);
 * 2. Session headers: x-opencode-session and three others must carry a time-encoded ses_ prefix
 *    (digest-derived ids get rejected once upstream decodes them);
 * 3. Request body: stream:true, the <env> marker in the system prompt, the read/shell fingerprint tools
 *    (definitions must match verbatim), and multi-turn assistant messages need reasoning_content.
 */
const INFERENCE_CHAT_URL = "https://opencode.ai/inference/v1/chat/completions";
const INFERENCE_RESPONSES_URL = "https://opencode.ai/inference/v1/responses";
const FREE_MODELS_URL = "https://opencode.ai/zen/v1/models";

const OPENCODE_UA = "opencode/latest/2.0.26/cli";
const OPENCODE_CLIENT = "cli";
const MAX_TOOL_NAME_LEN = 128;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

let lastTimestamp = 0;
let counter = 0;

function descendingTimeHex(time: number, counterValue: number): string {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

function randomBase62(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let part = "";
  for (const byte of bytes) part += BASE62[byte % 62];
  return part;
}

/**
 * prefix = ~(timeMs * 0x1000 + counter) low 48 bits, same as the CLI. Upstream decodes
 * the timestamp and checks the counter is small, so the counter must be genuinely incrementing.
 */
export function generateSessionId(now = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    counter = 0;
  }
  counter++;
  return `ses_${descendingTimeHex(now, counter)}${randomBase62()}`;
}

const stableSessions = new Map<string, { session: string; lastUsed: number }>();

/** Each session (cacheKey) stably reuses one session; free quota is metered per session and random ids burn through it. */
export function sessionFor(cacheKey: string | null): string {
  const key = cacheKey ?? "";
  const now = Date.now();
  const hit = stableSessions.get(key);
  if (hit && now - hit.lastUsed < SESSION_TTL_MS) {
    hit.lastUsed = now;
    return hit.session;
  }
  const session = generateSessionId(now);
  if (stableSessions.size >= MAX_SESSIONS) {
    const oldest = stableSessions.keys().next().value;
    if (oldest !== undefined) stableSessions.delete(oldest);
  }
  stableSessions.set(key, { session, lastUsed: now });
  return session;
}

/** v2.0.26 CLI verbatim definition; upstream compares description+parameters, so it must not be rewritten. */
const FINGERPRINT_TOOL_DEFINITIONS: Record<string, { description: string; parameters: JsonValue }> =
  {
    read: {
      description:
        "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory to read" },
          offset: {
            type: "integer",
            minimum: 0,
            description: "The line or directory entry to start reading from (1-based)",
          },
          limit: {
            type: "integer",
            minimum: 0,
            description:
              "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    shell: {
      description:
        "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string to execute" },
          workdir: {
            type: "string",
            description:
              "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
          },
          timeout: {
            type: "integer",
            minimum: 0,
            description:
              "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
          },
          background: {
            type: "boolean",
            description:
              "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  };

/** The caller prompt must carry the CLI's <env> marker; the marker content is not gated. */
const ENV_MARKER = [
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "  Working directory: /home/user/project",
  "  Workspace root folder: /home/user/project",
  "  Is directory a git repo: yes",
  "  Platform: linux",
  "  Prefer /tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.",
  "</env>",
].join("\n");

function unavailableNote(names: string[]): string {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  return names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

export type Fingerprint = {
  request: LlmRequest;
  /** On-wire name -> caller's original name; the response side restores them. */
  renamed: Map<string, string>;
};

/**
 * Rewrites the caller request into the shape the free lane accepts: injects the <env> marker and fingerprint tools,
 * renames colliding tools (same-name tool_calls in history are renamed too), and tells the model the fingerprint tools are placeholders.
 */
export function applyFingerprint(request: LlmRequest): Fingerprint {
  const renamed = new Map<string, string>();
  const fingerprintNames = Object.keys(FINGERPRINT_TOOL_DEFINITIONS);
  const taken = new Set(request.tools.map((tool) => tool.name));

  const tools: LlmTool[] = request.tools.map((tool) => {
    if (!fingerprintNames.includes(tool.name)) return tool;
    let alias = `${tool.name}_client`;
    for (let index = 2; taken.has(alias); index++) alias = `${tool.name}_client${index}`;
    taken.add(alias);
    renamed.set(alias, tool.name);
    return { ...tool, name: alias };
  });
  const present = new Set(tools.map((tool) => tool.name));
  const appended: string[] = [];
  for (const [name, definition] of Object.entries(FINGERPRINT_TOOL_DEFINITIONS)) {
    if (present.has(name)) continue;
    tools.push({
      name,
      description: definition.description,
      parameters: definition.parameters,
    });
    appended.push(name);
  }

  // History tool_calls that mention a renamed tool are renamed to the on-wire name too, so the model recognizes its own earlier calls.
  const byOriginal = new Map([...renamed].map(([alias, original]) => [original, alias]));
  const messages = renamed.size
    ? request.messages.map((message) => {
      if (message.role !== "assistant" || message.toolCalls.length === 0) return message;
      return {
        ...message,
        toolCalls: message.toolCalls.map((call) =>
          byOriginal.has(call.name) ? { ...call, name: byOriginal.get(call.name)! } : call
        ),
      };
    })
    : request.messages;

  const sections = [request.instructions, ENV_MARKER];
  if (appended.length) sections.push(unavailableNote(appended));

  return {
    request: {
      ...request,
      instructions: sections.filter((section) => section.trim()).join("\n\n"),
      messages,
      tools,
    },
    renamed,
  };
}

/** Chat lane: every assistant history message must carry reasoning_content; a placeholder is injected when there is no replay state. */
function withReasoningReplay(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((message) =>
    message.role === "assistant" && message.replayState?.providerKind !== CHAT_REPLAY_KIND
      ? {
        ...message,
        replayState: {
          providerKind: CHAT_REPLAY_KIND,
          value: { reasoning_content: " " },
        },
      }
      : message
  );
}

/** Responses lane: pooled accounts cannot decrypt other providers' encrypted_content, so reasoning items are dropped. */
function stripReplay(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((message) =>
    message.role === "assistant" && message.replayState !== null
      ? { ...message, replayState: null }
      : message
  );
}

/** The free lane's chat side accepts the full effort enum; the responses side (OpenAI pool) clamps max to xhigh. */
function laneEffort(effort: string | null, lane: Lane): string | null {
  if (effort === null) return null;
  const normalized = effort.toLowerCase();
  const chatEnum = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (lane === "chat") return chatEnum.includes(normalized) ? normalized : "high";
  if (normalized === "max" || normalized === "ultra") return "xhigh";
  return ["minimal", "low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "high";
}

/** Restores renamed tool calls to the caller's original names before handing them to the host. */
function restoreToolNames(output: ProviderOutput, renamed: Map<string, string>): ProviderOutput {
  if (renamed.size === 0) return output;
  return {
    emit(event) {
      if (event.type === "tool-call-start" && renamed.has(event.name)) {
        output.emit({ ...event, name: renamed.get(event.name)! });
      } else {
        output.emit(event);
      }
    },
  };
}

function requestLane(privateData: JsonValue | undefined): Lane {
  const data = privateData as Record<string, JsonValue> | null | undefined;
  return data?.lane === "responses" ? "responses" : "chat";
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof ChatHttpError || error instanceof ResponsesHttpError
  ) {
    const status = error.status;
    const body = error.body;
    if (status === 429 || /FreeUsageLimit|rate.?limit|quota/i.test(message + body)) {
      return "OpenCode free usage limit reached - wait for the reset or switch to OpenCode Go";
    }
    if (status === 403 || /FreeTier/i.test(body)) {
      return "OpenCode free tier rejected the request (fingerprint or quota gate)";
    }
  }
  return message;
}

export const opencodeFreeProvider: ProviderSupport = {
  id: "opencode-free",
  displayName: "OpenCode Free",
  description:
    "Anonymous free models on OpenCode's inference lane - no API key required. Requests run inside Cursor BYOK and carry the official client's session fingerprint.",
  providerType: "opencode",
  models: {
    list: (input, context) => freeModels.list(input, context),
  },
  async invoke(input, output, context) {
    const lane = requestLane(input.model.privateData);
    const session = sessionFor(input.request.cacheKey);
    const headers = {
      authorization: "Bearer public",
      "user-agent": OPENCODE_UA,
      "x-opencode-client": OPENCODE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": "global",
    };
    const fingerprint = applyFingerprint(input.request);
    const wrapped = restoreToolNames(output, fingerprint.renamed);
    const effort = laneEffort(input.request.reasoning.effort, lane);
    const model = input.model.id.replace(/\([^()]+\)\s*$/, "").trim();
    try {
      if (lane === "responses") {
        await streamOpenAiResponses(
          {
            url: INFERENCE_RESPONSES_URL,
            model,
            request: {
              ...fingerprint.request,
              messages: stripReplay(fingerprint.request.messages),
              reasoning: { ...input.request.reasoning, effort },
            },
            headers,
            extraBody: { store: false, include: [], tool_choice: "auto" },
          },
          wrapped,
          context,
        );
      } else {
        await streamOpenAiChat(
          {
            url: INFERENCE_CHAT_URL,
            model,
            request: {
              ...fingerprint.request,
              messages: withReasoningReplay(fingerprint.request.messages),
              reasoning: { ...input.request.reasoning, effort },
            },
            headers,
          },
          wrapped,
          context,
        );
      }
      return { status: "completed" };
    } catch (error) {
      return { status: "request-error", message: classifyError(error) };
    }
  },
};

const FREE_CATALOG_FALLBACK: { id: string; name: string; lane: Lane; images?: boolean }[] = [
  { id: "big-pickle", name: "Big Pickle", lane: "chat" },
  { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", lane: "chat" },
  { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash Free (Vision)", lane: "chat", images: true },
  { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free", lane: "chat" },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", lane: "chat" },
  {
    id: "nemotron-3.5-super-vl-free",
    name: "Nemotron 3.5 Super VL Free",
    lane: "chat",
    images: true,
  },
  { id: "beam-free", name: "Beam Free", lane: "chat" },
  { id: "flint-40b-free", name: "Flint 40B Free", lane: "chat" },
  { id: "pulse-alpha-free", name: "Pulse Alpha Free", lane: "chat" },
  { id: "crouton-alpha-free", name: "Crouton Alpha Free", lane: "chat" },
  {
    id: "muse-spark-1.3-contributor-free",
    name: "Muse Spark 1.3 Contributor Free",
    lane: "responses",
  },
  {
    id: "muse-spark-1.2-contributor-free",
    name: "Muse Spark 1.2 Contributor Free",
    lane: "responses",
  },
];

/** Free catalog: -free suffix plus big-pickle (a known free model without the suffix). */
export function isFreeModelId(id: string): boolean {
  return id.endsWith("-free") || id === "big-pickle";
}

function displayName(id: string): string {
  const curated = FREE_CATALOG_FALLBACK.find((entry) => entry.id === id);
  if (curated) return curated.name;
  return id
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function supportsImages(entry: Record<string, unknown>): boolean {
  const modalities = entry.modalities as Record<string, unknown> | undefined;
  const input = modalities?.input;
  if (Array.isArray(input) && input.some((mode) => mode === "image")) return true;
  const id = typeof entry.id === "string" ? entry.id : "";
  return /-vl|-vision|vision/i.test(id);
}

async function fetchFreeCatalog(context: PluginContext): Promise<ModelDefinition[]> {
  const response = await context.network.fetch(FREE_MODELS_URL, {
    method: "GET",
    headers: { "x-opencode-client": "desktop", "user-agent": "opencode/1.18.31" },
  });
  if (response.status !== 200) return [];
  const parsed = JSON.parse(response.body) as Record<string, unknown>;
  const list = Array.isArray(parsed.data) ? parsed.data : [];
  return list
    .map((item) => item as Record<string, unknown>)
    .filter((item) => typeof item.id === "string" && isFreeModelId(item.id as string))
    .map((item) => {
      const id = item.id as string;
      return {
        id,
        displayName: displayName(id),
        privateData: { lane: laneForModel(id) },
        ...(supportsImages(item) ? { capabilities: { images: true } } : {}),
      };
    });
}

export const freeModels: ModelSupport = {
  async list(_input, context) {
    try {
      const catalog = await fetchFreeCatalog(context);
      if (catalog.length) return catalog;
    } catch {
      // Falls back to the fallback list when the catalog endpoint fails.
    }
    return FREE_CATALOG_FALLBACK.map((entry) => ({
      id: entry.id,
      displayName: entry.name,
      privateData: { lane: entry.lane },
      ...(entry.images ? { capabilities: { images: true } } : {}),
    }));
  },
};
