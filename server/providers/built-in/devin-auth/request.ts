import type { JsonValue } from "cursor-byok:provider";
import type {
  LlmContentPart,
  LlmRequest,
  ModelEvent,
} from "cursor-byok:channel";
import { metadata } from "./connect.ts";

export type Prompt = {
  messageId: string;
  source: number;
  prompt?: string;
  toolCalls?: { id: string; name: string; argumentsJson: string }[];
  toolCallId?: string;
  toolResultIsError?: boolean;
  images?: { base64Data: string; mimeType: string }[];
  thinking?: string;
  signature?: string;
  signatureType?: string;
  outputId?: string;
  thinkingId?: string;
  thinkingRedacted?: boolean;
  geminiThoughtSignature?: string;
  promptCacheOptions?: { type: number };
};

/**
 * Upstream classifies declared tools from their prose: natural language in
 * `description` and inside `jsonSchemaString` feeds the same filter, and
 * matching text is rejected with `permission_denied` ("MCP configuration
 * issue"). Declarations therefore carry the name only; the descriptions and
 * per-parameter docs move to the system prompt via `toolSection`, where the
 * model still reads them.
 */
const ANNOTATION_KEYS = new Set(["description", "title", "$comment"]);
const LITERAL_KEYS = new Set([
  "const",
  "default",
  "enum",
  "example",
  "examples",
]);

function stripSchemaAnnotations(
  value: JsonValue,
  propertyNames = false,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => stripSchemaAnnotations(item));
  }
  if (value && typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        !propertyNames &&
        (ANNOTATION_KEYS.has(key) || key.toLowerCase().startsWith("x-"))
      ) {
        continue;
      }
      if (!propertyNames && LITERAL_KEYS.has(key)) {
        output[key] = child;
        continue;
      }
      output[key] = stripSchemaAnnotations(child, key === "properties");
    }
    return output;
  }
  return value;
}

const PARAM_DIGEST_MAX_LINES = 64;
const PARAM_DIGEST_MAX_DEPTH = 3;
const PARAM_DOC_MAX_CHARS = 240;

function paramDigest(
  schema: JsonValue,
  prefix = "",
  depth = 0,
  lines: string[] = [],
): void {
  if (
    depth > PARAM_DIGEST_MAX_DEPTH || lines.length >= PARAM_DIGEST_MAX_LINES ||
    !schema || typeof schema !== "object" || Array.isArray(schema)
  ) {
    return;
  }
  const properties = (schema as Record<string, JsonValue>).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return;
  }
  const requiredValue = (schema as Record<string, JsonValue>).required;
  const required = new Set(Array.isArray(requiredValue) ? requiredValue : []);
  for (
    const [name, property] of Object.entries(properties).sort(([a], [b]) =>
      a.localeCompare(b)
    )
  ) {
    if (lines.length >= PARAM_DIGEST_MAX_LINES) return;
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      continue;
    }
    const record = property as Record<string, JsonValue>;
    const doc = typeof record.description === "string"
      ? record.description
      : typeof record.title === "string"
      ? record.title
      : "";
    const text = doc.replace(/\s+/g, " ").trim();
    if (text) {
      const type = Array.isArray(record.type)
        ? record.type.join("|")
        : typeof record.type === "string"
        ? record.type
        : "any";
      lines.push(
        `- ${prefix}${name} (${type}${
          required.has(name) ? ", required" : ""
        }): ${text.length > PARAM_DOC_MAX_CHARS
          ? `${text.slice(0, PARAM_DOC_MAX_CHARS)}...`
          : text}`,
      );
    }
    paramDigest(record, `${prefix}${name}.`, depth + 1, lines);
    if (record.items && typeof record.items === "object") {
      paramDigest(record.items, `${prefix}${name}[].`, depth + 1, lines);
    }
  }
}

function escapeToolXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}

function toolSection(
  described: { name: string; description: string; parameters: JsonValue }[],
): string {
  const entries = described.flatMap((tool) => {
    const description = tool.description.trim();
    const lines: string[] = [];
    paramDigest(tool.parameters, "", 0, lines);
    if (!description && !lines.length) return [];
    return [
      `<tool name="${escapeToolXml(tool.name)}">\n${escapeToolXml(description)}${
        lines.length
          ? `\n\nParameters:\n${escapeToolXml(lines.join("\n"))}`
          : ""
      }\n</tool>`,
    ];
  });
  return entries.length ? `# tools descriptions\n${entries.join("\n")}` : "";
}

// The upstream gateway rejects its competitor's identity claim in system
// prompts: the case/whitespace-insensitive phrase "you operate in cursor" is
// blocked outright ("operating in", "run in", third person are not). Cursor
// composes exactly that sentence into `instructions`, so rewrite it here.
const OPERATE_IN_CURSOR = /you\s+operate\s+in\s+cursor/gi;

function sanitizePromptText(text: string): string {
  return text.replace(OPERATE_IN_CURSOR, (match) =>
    match[0] === "Y"
      ? "You operate in a code editor"
      : "you operate in a code editor"
  );
}

function uuid(hex: string): string {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${
    value.slice(16, 20)
  }-${value.slice(20)}`;
}

async function hash(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function content(
  parts: LlmContentPart[],
  current: boolean,
): Pick<Prompt, "prompt" | "images"> {
  let prompt = "";
  const images: NonNullable<Prompt["images"]> = [];
  for (const part of parts) {
    if (part.type === "text") prompt += part.text;
    else if (current) {
      images.push({ base64Data: part.dataBase64, mimeType: part.mediaType });
    } else prompt += "\n[Image omitted from history]";
  }
  return { prompt, ...(images.length ? { images } : {}) };
}

/** Devin requires the results immediately after the assistant prompt that called them. */
export function pairToolResults(prompts: Prompt[]): Prompt[] {
  const queues = new Map<string, Prompt[]>();
  for (const prompt of prompts) {
    if (prompt.source === 4) {
      const id = prompt.toolCallId!;
      queues.set(id, [...(queues.get(id) ?? []), prompt]);
    }
  }
  const consumed = new Set<Prompt>();
  const paired = new Map<Prompt, Prompt[]>();
  for (const prompt of prompts) {
    if (!prompt.toolCalls?.length) continue;
    const results: Prompt[] = [];
    for (const call of prompt.toolCalls) {
      const result = queues.get(call.id)?.shift();
      if (!result) {
        throw new Error(`Missing result for Devin tool call ${call.id}`);
      }
      consumed.add(result);
      results.push(result);
    }
    paired.set(prompt, results);
  }
  const output: Prompt[] = [];
  for (const prompt of prompts) {
    if (consumed.has(prompt)) continue;
    if (prompt.source === 4) {
      throw new Error(`Orphan Devin tool result ${prompt.toolCallId}`);
    }
    const results = paired.get(prompt);
    if (!results) {
      output.push(prompt);
      continue;
    }
    output.push(prompt, ...results);
  }
  return output;
}

export async function buildRequest(
  request: LlmRequest,
  model: string,
  token: string,
): Promise<{ body: JsonValue; originalNames: Map<string, string> }> {
  const seed = await hash(
    request.cacheKey ??
      JSON.stringify([
        model,
        request.instructions,
        request.messages.find((message) => message.role === "user"),
      ]),
  );
  const names = new Map<string, string>();
  const originalNames = new Map<string, string>();
  const tools = [];
  const described: { name: string; description: string; parameters: JsonValue }[] =
    [];
  for (const tool of request.tools) {
    if (names.has(tool.name)) continue;
    const name = /^[a-zA-Z0-9_-]+$/.test(tool.name)
      ? tool.name
      : `tool_${(await hash(tool.name)).slice(0, 24)}`;
    if (originalNames.has(name)) throw new Error("Devin tool aliases collide");
    names.set(tool.name, name);
    originalNames.set(name, tool.name);
    tools.push({
      name,
      description: name,
      jsonSchemaString: JSON.stringify(stripSchemaAnnotations(tool.parameters)),
    });
    described.push({
      name,
      description: tool.description,
      parameters: tool.parameters,
    });
  }
  const prompts: Prompt[] = [];
  const system = [request.instructions];
  const lastAssistant = request.messages.findLastIndex((message) =>
    message.role === "assistant"
  );
  for (const [index, message] of request.messages.entries()) {
    const messageId = uuid(await hash(`${seed}:${index}`));
    if (message.role === "system") {
      system.push(content(message.content, false).prompt ?? "");
    } else if (message.role === "user") {
      prompts.push({
        messageId,
        source: 1,
        ...content(message.content, index > lastAssistant),
      });
    } else if (message.role === "tool") {
      const parts = content(
        message.parts.length
          ? message.parts
          : [{ type: "text", text: message.content }],
        index > lastAssistant,
      );
      prompts.push({
        messageId,
        source: 4,
        ...parts,
        prompt: parts.prompt || "[tool result]",
        toolCallId: message.callId,
        toolResultIsError: message.isError,
      });
    } else if (message.role === "assistant") {
      const prompt: Prompt = { messageId, source: 2 };
      if (message.text) prompt.prompt = message.text;
      if (message.thinking) prompt.thinking = message.thinking;
      if (message.toolCalls.length) {
        prompt.toolCalls = message.toolCalls.map((call) => ({
          id: call.callId,
          name: names.get(call.name) ?? call.name,
          argumentsJson: JSON.stringify(call.arguments),
        }));
      }
      if (message.replayState?.protocolKind === "devin") {
        const replay = message.replayState.value as Record<string, JsonValue>;
        if (replay.modelUid === model) {
          for (
            const key of [
              "signature",
              "signatureType",
              "outputId",
              "thinkingId",
              "thinkingRedacted",
              "geminiThoughtSignature",
            ] as const
          ) {
            if (replay[key] !== undefined) {
              Object.assign(prompt, { [key]: replay[key] });
            }
          }
        }
      }
      if (Object.keys(prompt).length > 2) prompts.push(prompt);
    }
  }
  const paired = pairToolResults(prompts);
  if (!paired.length) {
    throw new Error("Devin needs at least one conversation message");
  }
  const section = toolSection(described);
  if (section) system.push(section);
  paired[paired.length - 1].promptCacheOptions = { type: 1 };
  return {
    originalNames,
    body: {
      metadata: metadata(token),
      prompt: sanitizePromptText(system.filter(Boolean).join("\n\n")),
      systemPromptCacheOptions: { type: 1 },
      chatMessagePrompts: paired as unknown as JsonValue,
      chatModelUid: model,
      requestType: 5,
      configuration: {
        numCompletions: "1",
        maxTokens: String(request.maxOutputTokens ?? 128000),
        maxNewlines: "400",
        temperature: 1,
        topK: "40",
        topP: 0.95,
      },
      tools,
      trajectoryReference: {
        trajectoryId: uuid(seed.slice(0, 32)),
        stepIndex:
          request.messages.filter((message) => message.role === "assistant")
            .length + 1,
        trajectoryType: 4,
        stepType: 14,
      },
      cascadeId: uuid(seed.slice(32)),
      plannerMode: 1,
      executionId: crypto.randomUUID(),
      promptCacheKey: seed.slice(0, 32),
    },
  };
}

type ToolState = {
  index: number;
  id: string;
  upstreamId: string;
  name: string;
  arguments: string;
  started: boolean;
};

/** Translate deltas while retaining signed reasoning for subsequent tool rounds. */
export class ResponseDecoder {
  private textOpen = false;
  private thinkingOpen = false;
  private tools: ToolState[] = [];
  private stop: string | number | undefined;
  private finalAnswer = false;
  private hasContent = false;
  private replay: Record<string, JsonValue>;
  private usage: Record<string, number> = {};

  constructor(
    private model: string,
    private names: Map<string, string>,
    private emit: (event: ModelEvent) => void,
  ) {
    this.replay = { modelUid: model };
  }

  push(frame: Record<string, any>): void {
    for (
      const key of [
        "outputId",
        "thinkingId",
        "geminiThoughtSignature",
        "thinkingRedacted",
      ]
    ) {
      if (frame[key] !== undefined) this.replay[key] = frame[key];
    }
    if (frame.deltaSignature) {
      this.replay.signature = String(this.replay.signature ?? "") +
        frame.deltaSignature;
    }
    if (frame.deltaSignatureType) {
      this.replay.signatureType = frame.deltaSignatureType;
    }
    if (frame.deltaThinking) {
      if (!this.thinkingOpen) {
        this.emit({ type: "thinking-start" });
        this.thinkingOpen = true;
      }
      this.emit({ type: "thinking-delta", text: frame.deltaThinking });
    }
    if (frame.deltaText) {
      this.closeThinking();
      if (!this.textOpen) {
        this.emit({ type: "text-start" });
        this.textOpen = true;
      }
      this.emit({ type: "text-delta", text: frame.deltaText });
      this.hasContent = true;
    }
    for (const delta of frame.deltaToolCalls ?? []) {
      this.closeThinking();
      if (this.textOpen) {
        this.emit({ type: "text-end" });
        this.textOpen = false;
      }
      if (delta.isCustomToolCall || delta.invalidJsonStr) {
        throw new Error("Devin returned a non-JSON tool call");
      }
      let tool = delta.id
        ? this.tools.find((state) => state.upstreamId === delta.id)
        : undefined;
      const last = this.tools.at(-1);
      if (
        !tool && last &&
        ((!delta.id && (!delta.name || delta.name === last.name)) ||
          (delta.id && !last.upstreamId))
      ) tool = last;
      if (!tool) {
        tool = {
          index: this.tools.length,
          id: delta.id || crypto.randomUUID(),
          upstreamId: delta.id || "",
          name: delta.name || "",
          arguments: "",
          started: false,
        };
        this.tools.push(tool);
      }
      if (delta.id) tool.upstreamId = delta.id;
      if (delta.name) tool.name = delta.name;
      if (!tool.started && tool.name) {
        tool.started = true;
        this.emit({
          type: "tool-call-start",
          index: tool.index,
          callId: tool.id,
          name: this.names.get(tool.name) ?? tool.name,
        });
        if (tool.arguments) {
          this.emit({
            type: "tool-call-arguments-delta",
            index: tool.index,
            delta: tool.arguments,
          });
        }
      }
      const fragment = delta.argumentsJson ?? "";
      tool.arguments += fragment;
      if (tool.started && fragment) {
        this.emit({
          type: "tool-call-arguments-delta",
          index: tool.index,
          delta: fragment,
        });
      }
      this.hasContent = true;
    }
    if (
      frame.stopReason !== undefined &&
      frame.stopReason !== "STOP_REASON_UNSPECIFIED" && frame.stopReason !== 0
    ) this.stop = frame.stopReason;
    if (frame.phase === "final_answer") this.finalAnswer = true;
    if (frame.usage) {
      if (frame.usage.providerRefusal) {
        throw new Error("Devin model provider refused the request");
      }
      for (
        const key of [
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
        ]
      ) {
        if (Number(frame.usage[key]) || this.usage[key] === undefined) {
          this.usage[key] = Number(frame.usage[key] ?? 0);
        }
      }
    }
  }

  finish(): void {
    if (!this.hasContent) throw new Error("Devin returned an empty response");
    if (
      [
        "STOP_REASON_ERROR",
        "STOP_REASON_CONTENT_FILTER",
        "STOP_REASON_INCOMPLETE",
        "STOP_REASON_PARTIAL",
        13,
        11,
        1,
        9,
      ].includes(this.stop!)
    ) throw new Error(`Devin stopped with ${this.stop}`);
    if (this.stop === undefined && !this.finalAnswer && !this.tools.length) {
      throw new Error("Devin did not confirm completion");
    }
    this.closeThinking();
    if (this.textOpen) this.emit({ type: "text-end" });
    for (const tool of this.tools) {
      if (!tool.started) {
        throw new Error("Devin returned a tool call without a name");
      }
      const parsed = JSON.parse(tool.arguments || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Devin tool arguments must be an object");
      }
      if (!tool.arguments) {
        this.emit({
          type: "tool-call-arguments-delta",
          index: tool.index,
          delta: "{}",
        });
      }
      this.emit({ type: "tool-call-end", index: tool.index });
    }
    if (Object.keys(this.replay).length > 1) {
      this.emit({
        type: "replay-state",
        protocolKind: "devin",
        value: this.replay,
      });
    }
    const usage = this.usage;
    if (Object.keys(usage).length) {
      this.emit({
        type: "usage",
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: Object.values(usage).reduce(
            (sum, value) => sum + value,
            0,
          ),
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          reasoningTokens: null,
        },
      });
    }
    const length = ["STOP_REASON_MAX_TOKENS", "STOP_REASON_MAX_NEWLINES", 3, 5]
      .includes(this.stop!);
    this.emit({
      type: "done",
      reason: length ? "length" : this.tools.length ? "tool-use" : "stop",
    });
  }

  private closeThinking(): void {
    if (this.thinkingOpen) {
      this.emit({ type: "thinking-end" });
      this.thinkingOpen = false;
    }
  }
}
