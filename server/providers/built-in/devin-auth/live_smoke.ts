/** Explicit, small upstream checks; this script is never embedded in the provider. */
import type { ProviderContext } from "cursor-byok:provider";
import type {
  LlmMessage,
  LlmRequest,
  ModelEvent,
  ChannelInvokeInput,
} from "cursor-byok:channel";
import { devinModels } from "./models.ts";
import { devinChannel } from "./channel.ts";
import { parseCredentials } from "./resources.ts";

if (Deno.args.length < 1 || Deno.args.length > 2) {
  throw new Error(
    "Supply the Devin CLI credentials.toml path and optional model ID",
  );
}
const account = parseCredentials(
  await Deno.readTextFile(Deno.args[0]),
  "credentials.toml",
)[0];
const controller = new AbortController();
const context: ProviderContext = {
  signal: controller.signal,
  network: {
    fetch: async (url, init = {}) => {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    },
    stream: () =>
      Promise.reject(new Error("Devin uses framed Connect, not SSE")),
    streamBytes: async (url, init = {}) => {
      const { bodyBase64, ...rest } = init;
      const body = bodyBase64
        ? Uint8Array.from(atob(bodyBase64), (value) => value.charCodeAt(0))
        : init.body;
      const response = await fetch(url, {
        ...rest,
        body,
        signal: controller.signal,
      });
      if (!response.body) throw new Error("Empty HTTP response");
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        chunks: response.body,
      };
    },
  },
};
const resource: NonNullable<ChannelInvokeInput["resource"]> = {
  id: "live-smoke",
  type: "devin-account",
  key: "smoke",
  privateData: account,
  state: { status: "ready" },
};
const models = await devinModels.list({ resource }, context);
const selectedModel = Deno.args[1] ?? "swe-1-7-lightning";
const model = models.find((value) => value.id === selectedModel);
if (!model) throw new Error(`The account has no ${selectedModel} model`);
console.log(
  JSON.stringify({
    check: "direct-catalog",
    count: models.length,
    model: model.id,
  }),
);

const request: LlmRequest = {
  instructions: "Follow the user's task. Use the supplied tools when asked.",
  messages: [{
    role: "user",
    content: [{ type: "text", text: "Reply exactly BYOK_DEVIN_OK." }],
  }],
  tools: [],
  reasoning: { enabled: false, effort: null },
  latency: "standard",
  maxOutputTokens: 1024,
  contextWindow: null,
  cacheKey: crypto.randomUUID(),
};
async function generate(request: LlmRequest): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  const result = await devinChannel.invoke(
    { model: model!, resource, request },
    {
      emit: (event) => events.push(event),
    },
    context,
  );
  if (result.status !== "completed") {
    throw new Error(result.message ?? "Devin smoke failed");
  }
  return events;
}
function text(events: ModelEvent[]): string {
  return events.flatMap((event) =>
    event.type === "text-delta" ? [event.text] : []
  ).join("");
}
const basic = await generate(request);
if (!text(basic).includes("BYOK_DEVIN_OK")) {
  throw new Error("Unexpected basic generation result");
}
console.log(JSON.stringify({ check: "generation", text: text(basic).trim() }));

request.messages = [{
  role: "user",
  content: [{
    type: "text",
    text:
      "Use the supplied addition tool with a=19 and b=23. After the tool result, reply with the sum only.",
  }],
}];
request.tools = [{
  name: "mcp::addition",
  description: "Add two integers and return their sum.",
  parameters: {
    type: "object",
    properties: {
      a: { type: "integer", description: "First integer" },
      b: { type: "integer", description: "Second integer" },
    },
    required: ["a", "b"],
    additionalProperties: false,
  },
}];
request.cacheKey = crypto.randomUUID();
const toolEvents = await generate(request);
const start = toolEvents.find((event) => event.type === "tool-call-start");
if (
  !start || start.type !== "tool-call-start" || start.name !== "mcp::addition"
) throw new Error("Devin did not call the original tool name");
const args = JSON.parse(
  toolEvents.flatMap((event) =>
    event.type === "tool-call-arguments-delta" && event.index === start.index
      ? [event.delta]
      : []
  ).join(""),
);
if (args.a !== 19 || args.b !== 23) throw new Error("Wrong tool arguments");
const replay = toolEvents.find((event) => event.type === "replay-state");
const assistant: LlmMessage = {
  role: "assistant",
  text: text(toolEvents),
  thinking: toolEvents.flatMap((event) =>
    event.type === "thinking-delta" ? [event.text] : []
  ).join(""),
  replayState: replay?.type === "replay-state"
    ? { protocolKind: replay.protocolKind, value: replay.value }
    : null,
  toolCalls: [{
    index: start.index,
    callId: start.callId,
    name: start.name,
    arguments: args,
  }],
};
request.messages.push(assistant, {
  role: "tool",
  callId: start.callId,
  name: start.name,
  content: "42",
  isError: false,
  parts: [],
});
const final = await generate(request);
if (text(final).trim() !== "42") {
  throw new Error(`Unexpected tool-result answer: ${text(final)}`);
}
console.log(
  JSON.stringify({
    check: "tool-round",
    tool: start.name,
    arguments: args,
    answer: text(final).trim(),
    signedReplay: Boolean(replay),
  }),
);
