//! Builds the model catalog file that makes Keybridge models selectable in Codex.
use serde_json::{json, Value};

use crate::{api::byok::PublicModel, provider::ModelOptions};

/// The instructions Codex gives to models it has no built-in profile for, taken from
/// openai/codex `codex-rs/models-manager/prompt.md` (Apache-2.0). Codex refuses a
/// catalog entry without instructions, so every Keybridge model carries these.
const BASE_INSTRUCTIONS: &str = include_str!("base_instructions.md");

/// Used when a model does not declare its context window. Codex compacts a thread as
/// it approaches this size, so a conservative value avoids overflowing the model.
const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;

/// One catalog entry per model, shaped like the entry Codex itself synthesizes for an
/// unknown model, but visible in the model picker. Reasoning levels are left empty
/// because reasoning is governed by each model's own Keybridge configuration.
pub(super) fn render(models: &[PublicModel]) -> Value {
    let entries = models
        .iter()
        .enumerate()
        .map(|(index, model)| {
            let provider = model.provider_name.trim();
            let description = if provider.is_empty() {
                "Keybridge".to_owned()
            } else {
                format!("Keybridge · {provider}")
            };
            let mut entry = json!({
                "slug": model.public_id,
                "display_name": model.labeled_display_name(),
                "description": description,
                "shell_type": "unified_exec",
                "visibility": "list",
                "supported_in_api": true,
                "priority": index,
                "availability_nux": null,
                "upgrade": null,
                "base_instructions": BASE_INSTRUCTIONS,
                "support_verbosity": false,
                "default_verbosity": null,
                "apply_patch_tool_type": null,
                "truncation_policy": {"mode": "bytes", "limit": 10_000},
                "context_window": model.context_window.unwrap_or(DEFAULT_CONTEXT_WINDOW),
                "experimental_supported_tools": [],
                "input_modalities": if model.images {
                    json!(["text", "image"])
                } else {
                    json!(["text"])
                },
            });
            apply_options(&mut entry, &model.options);
            entry
        })
        .collect::<Vec<_>>();
    json!({ "models": entries })
}

/// Effort levels and Fast tier Codex shows in its picker. Codex sends the chosen effort as
/// `reasoning.effort` and Fast as `service_tier: "priority"`, which the external API maps back.
fn apply_options(entry: &mut Value, options: &ModelOptions) {
    let levels = options
        .efforts
        .iter()
        .map(|effort| json!({"effort": effort, "description": effort}))
        .collect::<Vec<_>>();
    entry["supported_reasoning_levels"] = Value::Array(levels);
    if let Some(effort) = options.preselected_effort() {
        entry["default_reasoning_level"] = json!(effort);
    }
    if options.fast {
        entry["additional_speed_tiers"] = json!(["fast"]);
        entry["service_tiers"] = json!([{
            "id": "priority",
            "name": "Fast",
            "description": "Faster responses, higher usage",
        }]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_model_is_listed_in_order_with_provider_prefix_and_instructions() {
        let models = [
            PublicModel {
                public_id: "work/model-a".into(),
                internal_id: "hash-a".into(),
                provider_name: "Work".into(),
                display_name: "Model A".into(),
                context_window: Some(1_000_000),
                images: false,
                options: ModelOptions::manual(),
            },
            PublicModel {
                public_id: "provider:x:y/model-b".into(),
                internal_id: "provider:x/y/model-b".into(),
                provider_name: "Codex".into(),
                display_name: "Model B".into(),
                context_window: None,
                images: true,
                options: ModelOptions::default(),
            },
        ];
        let catalog = render(&models);
        let entries = catalog["models"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["slug"], "work/model-a");
        assert_eq!(entries[0]["display_name"], "[Work] Model A");
        assert_eq!(entries[0]["description"], "Keybridge · Work");
        assert_eq!(entries[0]["priority"], 0);
        assert_eq!(entries[0]["context_window"], 1_000_000);
        assert_eq!(entries[0]["input_modalities"], json!(["text"]));
        assert_eq!(entries[1]["slug"], "provider:x:y/model-b");
        assert_eq!(entries[1]["display_name"], "[Codex] Model B");
        assert_eq!(entries[1]["description"], "Keybridge · Codex");
        assert_eq!(entries[1]["priority"], 1);
        assert_eq!(entries[1]["context_window"], DEFAULT_CONTEXT_WINDOW);
        assert_eq!(entries[1]["input_modalities"], json!(["text", "image"]));
        let levels = entries[0]["supported_reasoning_levels"].as_array().unwrap();
        assert_eq!(levels.len(), 5);
        assert_eq!(levels[3]["effort"], "xhigh");
        assert_eq!(entries[0]["default_reasoning_level"], "high");
        assert_eq!(entries[0]["service_tiers"][0]["id"], "priority");
        assert_eq!(entries[1]["supported_reasoning_levels"], json!([]));
        assert!(entries[1].get("default_reasoning_level").is_none());
        assert!(entries[1].get("service_tiers").is_none());

        for entry in entries {
            assert_eq!(entry["visibility"], "list");
            assert!(!entry["base_instructions"].as_str().unwrap().is_empty());
        }
    }
}
