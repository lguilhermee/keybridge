//! Builds the model catalog file that makes Keybridge models selectable in Codex.
use serde_json::{json, Value};

use crate::api::byok::PublicModel;

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
            json!({
                "slug": model.public_id,
                "display_name": model.display_name,
                "description": "Keybridge",
                "supported_reasoning_levels": [],
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
            })
        })
        .collect::<Vec<_>>();
    json!({ "models": entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_model_is_listed_in_order_with_instructions() {
        let models = [
            PublicModel {
                public_id: "work/model-a".into(),
                internal_id: "hash-a".into(),
                display_name: "Model A".into(),
                context_window: Some(1_000_000),
                images: false,
            },
            PublicModel {
                public_id: "provider:x:y/model-b".into(),
                internal_id: "provider:x/y/model-b".into(),
                display_name: "Model B".into(),
                context_window: None,
                images: true,
            },
        ];
        let catalog = render(&models);
        let entries = catalog["models"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["slug"], "work/model-a");
        assert_eq!(entries[0]["priority"], 0);
        assert_eq!(entries[0]["context_window"], 1_000_000);
        assert_eq!(entries[0]["input_modalities"], json!(["text"]));
        assert_eq!(entries[1]["slug"], "provider:x:y/model-b");
        assert_eq!(entries[1]["priority"], 1);
        assert_eq!(entries[1]["context_window"], DEFAULT_CONTEXT_WINDOW);
        assert_eq!(entries[1]["input_modalities"], json!(["text", "image"]));
        for entry in entries {
            assert_eq!(entry["visibility"], "list");
            assert!(!entry["base_instructions"].as_str().unwrap().is_empty());
        }
    }
}
