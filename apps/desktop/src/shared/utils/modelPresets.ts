import type { ModelType } from "../api";
import abliterationIcon from "../assets/provider-icons/abliteration.svg";
import deepseekIcon from "../assets/provider-icons/deepseek.svg";
import huoshanIcon from "../assets/provider-icons/huoshan.png";
import kimiIcon from "../assets/provider-icons/kimi.svg";
import minimaxIcon from "../assets/provider-icons/minimax.svg";
import orcarouterIcon from "../assets/provider-icons/orcarouter.png";
import refuselessIcon from "../assets/provider-icons/refuseless.png";
import uncensoredllmIcon from "../assets/provider-icons/uncensoredllm.svg";
import zhipuIcon from "../assets/provider-icons/zhipu.svg";
import { defaultCustomHeaders } from "./modelDefaults";

export interface ModelPresetEntry {
  model_id: string;
  display_name: string;
  context_window_tokens: number | null;
  max_output_tokens: number | null;
}

/** A provider endpoint under one protocol (anthropic / openai). */
export interface ModelPresetEndpoint {
  baseUrl: string;
  /** When true, baseUrl is the complete request URL; when false, the protocol appends its standard endpoint path. */
  useFullUrl: boolean;
  /** Request endpoint for the openai protocol (ignored when useFullUrl is true). */
  openaiEndpoint: string;
  /** When non-empty, custom headers are sent (claude-cli impersonation headers). */
  customHeaders: Record<string, string> | null;
}

export interface ModelPreset {
  key: string;
  name: string;
  icon: string;
  keyHint: string;
  /** Every preset provider offers both Anthropic- and OpenAI-compatible protocols. */
  endpoints: { anthropic: ModelPresetEndpoint; openai: ModelPresetEndpoint };
  models: ModelPresetEntry[];
}

const entry = (
  modelId: string,
  displayName: string,
  contextWindowTokens: number | null,
  maxOutputTokens: number | null,
): ModelPresetEntry => ({
  model_id: modelId,
  display_name: displayName,
  context_window_tokens: contextWindowTokens,
  max_output_tokens: maxOutputTokens,
});

const claudeHeaders = { ...defaultCustomHeaders };
/** anthropic protocol: enter the Base URL, /v1/messages is appended automatically. */
const anthropic = (baseUrl: string): ModelPresetEndpoint => ({ baseUrl, useFullUrl: false, openaiEndpoint: "", customHeaders: claudeHeaders });
/** anthropic protocol on a general API gateway: same path rule, no claude-cli impersonation headers. */
const anthropicPlain = (baseUrl: string): ModelPresetEndpoint => ({ baseUrl, useFullUrl: false, openaiEndpoint: "", customHeaders: null });
/** openai protocol: enter the Base URL, /v1/chat/completions is appended automatically. */
const openaiChat = (baseUrl: string): ModelPresetEndpoint => ({ baseUrl, useFullUrl: false, openaiEndpoint: "/v1/chat/completions", customHeaders: null });
/** openai protocol: irregular path, provide the full request URL directly. */
const openaiFullUrl = (url: string): ModelPresetEndpoint => ({ baseUrl: url, useFullUrl: true, openaiEndpoint: "/v1/chat/completions", customHeaders: null });

export const modelPresets: ModelPreset[] = [
  {
    key: "zhipu",
    name: "Zhipu GLM",
    icon: zhipuIcon,
    keyHint: "bigmodel.cn -> GLM Coding Plan -> API Key (plan keys and regular keys are not interchangeable)",
    endpoints: {
      anthropic: anthropic("https://open.bigmodel.cn/api/anthropic"),
      openai: openaiFullUrl("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"),
    },
    models: [
      entry("glm-5.3", "GLM 5.3", 1000000, 65536),
      entry("glm-5.2", "GLM 5.2", 200000, 32768),
      entry("glm-4.7", "GLM 4.7", 200000, 32768),
    ],
  },
  {
    key: "kimi",
    name: "Kimi (Moonshot)",
    icon: kimiIcon,
    keyHint: "Get the API key on the Kimi Code plan page (api.kimi.com/coding endpoint)",
    endpoints: {
      anthropic: anthropic("https://api.kimi.com/coding"),
      openai: openaiChat("https://api.kimi.com/coding"),
    },
    models: [
      entry("k3", "Kimi K3", 1048576, 65536),
      entry("kimi-for-coding", "K2.7 Coding", 262144, 32768),
    ],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    icon: deepseekIcon,
    keyHint: "platform.deepseek.com -> API Keys",
    endpoints: {
      anthropic: anthropic("https://api.deepseek.com/anthropic"),
      openai: openaiChat("https://api.deepseek.com"),
    },
    models: [
      entry("deepseek-v4-pro", "DeepSeek V4 Pro", 1000000, 65536),
      entry("deepseek-v4-flash", "DeepSeek V4 Flash", 1000000, null),
    ],
  },
  {
    key: "volcengine",
    name: "Volcano Engine Ark",
    icon: huoshanIcon,
    keyHint: "Volcano Ark Coding Plan (the ark-code-latest route serves multiple coding models)",
    endpoints: {
      anthropic: anthropic("https://ark.cn-beijing.volces.com/api/coding"),
      openai: openaiFullUrl("https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"),
    },
    models: [entry("ark-code-latest", "Ark Code Latest", 256000, 32768)],
  },
  {
    key: "minimax",
    name: "MiniMax",
    icon: minimaxIcon,
    keyHint: "platform.minimaxi.com -> subscribe to the Coding Plan -> API Key",
    endpoints: {
      anthropic: anthropic("https://api.minimaxi.com/anthropic"),
      openai: { baseUrl: "https://api.minimaxi.com", useFullUrl: false, openaiEndpoint: "/v1/responses", customHeaders: null },
    },
    models: [
      entry("MiniMax-M3", "MiniMax M3", 1000000, 65536),
      entry("MiniMax-M2.7", "MiniMax M2.7", 205000, 32768),
    ],
  },
  {
    key: "abliteration",
    name: "Abliteration",
    icon: abliterationIcon,
    keyHint: "abliteration.ai/console -> API Keys (keys start with ak_)",
    endpoints: {
      anthropic: anthropicPlain("https://api.abliteration.ai"),
      openai: openaiChat("https://api.abliteration.ai"),
    },
    // Context is a combined input + output budget, so the output cap stays on the provider default.
    models: [
      entry("abliterated-model-large-v2", "Abliterated Large v2", 1000000, null),
      entry("abliterated-model-large-flash", "Abliterated Large Flash", 1048576, null),
      entry("abliterated-model", "Abliterated Model", 262144, null),
    ],
  },
  {
    key: "refuseless",
    name: "Refuseless",
    icon: refuselessIcon,
    keyHint: "refuseless.com -> Console -> API Keys (keys start with abl_)",
    endpoints: {
      anthropic: anthropicPlain("https://api.refuseless.com"),
      openai: openaiChat("https://api.refuseless.com"),
    },
    // The docs publish different output caps per client, so the output cap stays on the provider default.
    models: [
      entry("glm-5.3-abliterated", "GLM 5.3 Abliterated", 1048576, null),
      entry("glm-5.3-flash-abliterated", "GLM 5.3 Flash Abliterated", 1048576, null),
      entry("deepseek-v4.1-flash-abliterated", "DeepSeek V4.1 Flash Abliterated", 1048576, null),
    ],
  },
  {
    key: "uncensoredllm",
    name: "UncensoredLLM",
    icon: uncensoredllmIcon,
    keyHint: "app.uncensoredllm.ai/console -> API Keys (keys start with sk-ullm-live-); Fetch models lists the full catalog",
    endpoints: {
      anthropic: anthropicPlain("https://api.uncensoredllm.ai"),
      openai: openaiChat("https://api.uncensoredllm.ai"),
    },
    // Limits come from /v1/catalog; null where the catalog publishes none.
    models: [
      entry("uncensored-coding-agent", "Uncensored Coding Agent", 1048576, 32768),
      entry("glm-5.3-uncensored", "GLM 5.3 Uncensored", null, null),
      entry("deepseek-v4.1-flash-1017-uncensored", "DeepSeek V4.1 Flash 1017 Uncensored", 1048576, null),
      entry("mimo-v2.6-pro-uncensored", "MiMo V2.6 Pro Uncensored", 1048576, 131072),
    ],
  },
  {
    key: "orcarouter",
    name: "OrcaRouter",
    icon: orcarouterIcon,
    keyHint: "orcarouter.ai/console -> API Keys (keys start with sk-orca-); Fetch models lists the full provider-prefixed catalog",
    endpoints: {
      anthropic: anthropicPlain("https://api.orcarouter.ai"),
      openai: openaiChat("https://api.orcarouter.ai"),
    },
    // Only ids served on both /v1/messages and /v1/chat/completions, so the default works under either model type.
    models: [
      entry("anthropic/claude-fable-5.2", "Claude Fable 5.2", 1000000, 128000),
      entry("anthropic/claude-opus-5.5", "Claude Opus 5.5", 1000000, 128000),
      entry("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", 1000000, 128000),
      entry("orcarouter/auto", "OrcaRouter Auto", null, null),
    ],
  },
];

export const trimTrailingSlash = (url: string) => url.replace(/\/+$/, "");

export const presetEndpoint = (preset: ModelPreset, type: ModelType): ModelPresetEndpoint => preset.endpoints[type];
