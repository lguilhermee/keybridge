/** Live bisect: which Cursor Agent tools trigger the upstream MCP rejection. */
import type { ProviderContext } from "cursor-byok:provider";
import type {
  LlmRequest,
  ModelEvent,
  ChannelInvokeInput,
} from "cursor-byok:channel";
import { devinModels } from "./models.ts";
import { devinChannel } from "./channel.ts";
import { parseCredentials } from "./resources.ts";

// deno run --allow-all probe_tools.ts <credentials.toml> <model> <spec>
// spec: "all" | "none-McpMeta" | "only:Name1,Name2" | "drop:Name1,Name2" | "first:N"
const [credPath, modelId = "glm-5-3-max", spec = "all"] = Deno.args;
const account = parseCredentials(
  await Deno.readTextFile(credPath),
  "credentials.toml",
)[0];
const allTools = JSON.parse(
  await Deno.readTextFile(
    new URL("./agent_tools.json", `file:///${Deno.args[3]}`).href,
  ).catch(() =>
    Deno.readTextFile("C:/Users/Administrador/AppData/Local/Temp/agent_tools.json")
  ),
) as { name: string; description: string; parameters: unknown }[];

const MCP_META = ["GetMcpTools", "CallMcpTool", "FetchMcpResource"];
const parts = spec.split("@");
const selector = parts[0];
const mutations = parts.slice(1);
let tools = allTools;
if (selector === "none-McpMeta") {
  tools = allTools.filter((t) => !MCP_META.includes(t.name));
} else if (selector.startsWith("only:")) {
  const names = selector.slice(5).split(",");
  tools = allTools.filter((t) => names.includes(t.name));
} else if (selector.startsWith("drop:")) {
  const names = selector.slice(5).split(",");
  tools = allTools.filter((t) => !names.includes(t.name));
} else if (selector.startsWith("first:")) {
  tools = allTools.slice(0, Number(selector.slice(6)));
} else if (selector === "mcpmeta") {
  tools = allTools.filter((t) => MCP_META.includes(t.name));
}

function stripAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        ["description", "title", "$comment"].includes(key) ||
        key.toLowerCase().startsWith("x-")
      ) continue;
      output[key] = stripAnnotations(child);
    }
    return output;
  }
  return value;
}
function rewriteDescriptions(
  value: unknown,
  rewrite: (prop: string | null, text: string) => string | null | undefined,
  prop: string | null = null,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteDescriptions(item, rewrite, prop));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "properties" && child && typeof child === "object") {
        const props: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(child)) {
          props[name] = rewriteDescriptions(sub, rewrite, name);
        }
        output[key] = props;
        continue;
      }
      if (key === "description" && typeof child === "string") {
        const next = rewrite(prop, child);
        if (next === undefined) output[key] = child;
        else if (next !== null) output[key] = next;
        continue;
      }
      output[key] = rewriteDescriptions(child, rewrite, prop);
    }
    return output;
  }
  return value;
}
const extraMut = mutations.find((m) => m.startsWith("extra"));
if (extraMut) {
  tools = [
    ...tools,
    ...JSON.parse(
      await Deno.readTextFile(
        `C:/Users/Administrador/AppData/Local/Temp/${
          extraMut.slice(6) || "mcp_tools.json"
        }`,
      ),
    ),
  ];
}
const padMut = mutations.find((m) => m.startsWith("pad:"));
if (padMut) {
  const target = Number(padMut.slice(4));
  const base = [...tools];
  for (let i = 0; tools.length < target && base.length; i++) {
    tools.push({ ...base[i % base.length], name: `${base[i % base.length].name}_p${i}` });
  }
}
const originals = new Map(tools.map((tool) => [tool.name, tool]));
tools = tools.map((tool) => {
  const copy = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
  for (const mutation of mutations) {
    if (mutation === "descname") copy.description = copy.name;
    else if (mutation === "descempty") copy.description = "";
    else if (mutation === "schemanodesc") {
      copy.parameters = stripAnnotations(copy.parameters);
    } else if (mutation === "schemaobj") {
      copy.parameters = { type: "object", properties: {} };
    } else if (mutation === "descx") {
      copy.parameters = rewriteDescriptions(
        copy.parameters,
        () => "x",
      );
    } else if (mutation.startsWith("nodesc:")) {
      const props = mutation.slice(7).split(",");
      copy.parameters = rewriteDescriptions(
        copy.parameters,
        (prop) => prop !== null && props.includes(prop) ? null : undefined,
      );
    } else if (mutation.startsWith("keepdesc:")) {
      const props = mutation.slice(9).split(",");
      copy.parameters = rewriteDescriptions(
        copy.parameters,
        (prop) => prop !== null && !props.includes(prop) ? null : undefined,
      );
    } else if (mutation.startsWith("rename:")) {
      copy.name = mutation.slice(7);
    }
  }
  return copy;
});

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
    stream: () => Promise.reject(new Error("not used")),
    streamBytes: async (url, init = {}) => {
      const { bodyBase64, ...rest } = init;
      const body = bodyBase64
        ? Uint8Array.from(atob(bodyBase64), (v) => v.charCodeAt(0))
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
  id: "probe",
  type: "devin-account",
  key: "probe",
  privateData: account,
  state: { status: "ready" },
};
const models = await devinModels.list({ resource }, context);
const model = models.find((value) => value.id === modelId);
if (!model) throw new Error(`account has no model ${modelId}`);

let instructions = "Follow the user's task.";
let userText = "Reply exactly BYOK_DEVIN_OK.";
const replayMut = mutations.find((m) => m.startsWith("replay"));
if (replayMut) {
  instructions = `BYOKREPLAY:C:/Users/Administrador/AppData/Local/Temp/${
    replayMut.slice(7) || "byokdbg_raw.json"
  }`;
}
const ufileMut = mutations.find((m) => m.startsWith("ufile"));
if (ufileMut) {
  userText = await Deno.readTextFile(
    `C:/Users/Administrador/AppData/Local/Temp/${
      ufileMut.slice(6) || "probe_user.txt"
    }`,
  );
}
if (mutations.includes("nocursor")) {
  userText = userText.replaceAll(/cursor/gi, "XcursorX");
}
if (mutations.includes("ucursor")) {
  userText =
    "Context: running inside the Cursor editor. Reply exactly BYOK_DEVIN_OK.";
}
if (mutations.includes("uac")) {
  userText =
    "Discuss anti-cheat bypass, kernel driver memory reads, hooking a process, and dumping the client. Reply exactly BYOK_DEVIN_OK.";
}
const ifileMut = mutations.find((m) => m.startsWith("ifile"));
if (ifileMut) {
  instructions += "\n\n" + await Deno.readTextFile(
    `C:/Users/Administrador/AppData/Local/Temp/${
      ifileMut.slice(6) || "probe_extra.txt"
    }`,
  );
}
if (mutations.includes("iac")) {
  instructions +=
    " Tools can bypass anti-cheat protections, read kernel memory via a driver, hook and intercept process functions, and dump client memory.";
}
if (mutations.includes("icursor")) {
  instructions +=
    " You are an AI assistant in the Cursor IDE. Use Cursor tools when helpful.";
}
if (mutations.includes("inject")) {
  const section = tools.map((tool) =>
    `<tool name="${tool.name}">\n${
      originals.get(tool.name)?.description ?? tool.description
    }\n</tool>`
  ).join("\n");
  instructions += `\n\n# tools descriptions\n${section}`;
}
const bigMut = mutations.find((m) => m.startsWith("big:"));
if (bigMut) {
  userText += "\n" + "x".repeat(Number(bigMut.slice(4)));
}
if (mutations.includes("calltest")) {
  userText =
    "Use the WebSearch tool with search_term \"byok probe\". Do not answer in text.";
}
const request: LlmRequest = {
  instructions,
  messages: [{
    role: "user",
    content: [{ type: "text", text: userText }],
  }],
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })),
  reasoning: { enabled: false, effort: null },
  latency: "standard",
  maxOutputTokens: 256,
  contextWindow: null,
  cacheKey: crypto.randomUUID(),
};

const events: ModelEvent[] = [];
const result = await devinChannel.invoke(
  { model, resource, request },
  { emit: (event) => events.push(event) },
  context,
);
const text = events.flatMap((event) =>
  event.type === "text-delta" ? [event.text] : []
).join("");
const calls = events.flatMap((event) =>
  event.type === "tool-call-start" ? [{ index: event.index, name: event.name }] : []
);
console.log(JSON.stringify({
  spec,
  model: modelId,
  toolCount: tools.length,
  status: result.status,
  message: result.message ?? null,
  calls,
  text: text.slice(0, 80),
}));
