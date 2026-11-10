import type { Model, ModelInput } from "../../shared/api";
import type { ModelDraft } from "./ModelEditor";

export function modelInput(model: Model): ModelInput {
  const { model_hash: _hash, created_at_ms: _created, updated_at_ms: _updated, ...input } = model;
  return input;
}

/** Returns the value when every model in the group agrees; otherwise null (an empty form field keeps each model's own value). */
export function sharedValue(values: string[]): string | null {
  const [first, ...rest] = values;
  if (first === undefined) return null;
  return rest.every((value) => value === first) ? first : null;
}

export function draftInput(draft: ModelDraft): ModelInput {
  const model = {
    ...draft.model,
    display_name: draft.model.display_name.trim(),
    base_url: draft.model.base_url.trim(),
    api_key: draft.model.api_key.trim(),
    tooltip_data: draft.model.tooltip_data.trim(),
    model_id: draft.model.model_id.trim(),
    openai_extra_params: parseObject(draft.openAIExtraParamsText, t("OpenAI extra parameters")),
    custom_headers: parseHeaders(draft.customHeadersText),
    anthropic_extra_params: parseObject(draft.anthropicExtraParamsText, t("Anthropic extra parameters")),
  };
  if (!model.display_name || !model.base_url || !model.api_key || !model.tooltip_data || !model.model_id) throw new Error(t("Server address or complete request URL, API Key, model name, display name, and note are required"));
  for (const [label, value] of [[t("Context window tokens"), model.context_window_tokens], [t("Maximum output tokens"), model.type === "openai" ? model.max_completion_tokens : model.anthropic_max_tokens], [t("Thinking budget tokens"), model.thinking_budget_tokens]] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(t("{label} must be an integer greater than 0", { label }));
  }
  return model;
}

export function parseHeaders(text: string): Record<string, string> {
  const parsed = parseObject(text, t("Custom Headers"));
  if (Object.values(parsed).some((value) => typeof value !== "string")) throw new Error(t("All custom Header values must be strings"));
  return parsed as Record<string, string>;
}

export function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || "{}"); } catch { throw new Error(t("{label} must be valid JSON", { label })); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(t("{label} must be a JSON object", { label }));
  return parsed as Record<string, unknown>;
}

export function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
