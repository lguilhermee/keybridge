use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::{
    model::ModelConfig,
    provider::{ProviderModelDescriptor, ProviderRegistry},
    store::Store,
    Result,
};

/// A configured model as callers of the external API address it.
#[derive(Clone)]
pub(crate) struct ListedModel {
    pub public_id: String,
    pub internal_id: String,
    pub provider_name: String,
    pub display_name: String,
    pub context_window: Option<u64>,
    pub images: bool,
}

impl ListedModel {
    /// Prefixes the model name with `[Provider]` unless it already carries that tag.
    pub fn labeled_display_name(&self) -> String {
        let provider = self.provider_name.trim();
        let name = self.display_name.trim();
        if provider.is_empty() || has_provider_prefix(name, provider) {
            return name.to_owned();
        }
        format!("[{provider}] {name}")
    }
}

fn has_provider_prefix(display_name: &str, provider_name: &str) -> bool {
    display_name
        .strip_prefix('[')
        .and_then(|rest| rest.split_once(']'))
        .is_some_and(|(tag, _)| tag.trim().to_lowercase() == provider_name.to_lowercase())
}

fn host(base_url: &str) -> Option<String> {
    url::Url::parse(base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_lowercase))
}

fn known_host_provider(host: &str) -> Option<&'static str> {
    match host {
        "open.bigmodel.cn" => Some("Zhipu GLM"),
        "api.kimi.com" | "api.moonshot.cn" | "api.moonshot.ai" => Some("Kimi"),
        "api.deepseek.com" => Some("DeepSeek"),
        "ark.cn-beijing.volces.com" => Some("Volcano Engine Ark"),
        "api.minimaxi.com" | "api.minimax.chat" | "api.minimax.io" => Some("MiniMax"),
        "api.abliteration.ai" => Some("Abliteration"),
        "api.refuseless.com" => Some("Refuseless"),
        "api.uncensoredllm.ai" | "app.uncensoredllm.ai" => Some("UncensoredLLM"),
        "api.orcarouter.ai" => Some("OrcaRouter"),
        "openrouter.ai" => Some("OpenRouter"),
        "api.openai.com" => Some("OpenAI"),
        "api.anthropic.com" => Some("Anthropic"),
        "generativelanguage.googleapis.com" => Some("Google"),
        "api.x.ai" => Some("Grok"),
        "api.groq.com" => Some("Groq"),
        "api.together.xyz" => Some("Together"),
        "api.fireworks.ai" => Some("Fireworks"),
        "api.mistral.ai" => Some("Mistral"),
        "api.cerebras.ai" => Some("Cerebras"),
        "api.siliconflow.cn" | "api.siliconflow.com" => Some("SiliconFlow"),
        _ => None,
    }
}

fn configured_group_slug(model: &ModelConfig) -> String {
    model
        .group_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| host(&model.base_url))
        .unwrap_or_else(|| model.base_url.trim().to_owned())
}

fn configured_provider_name(model: &ModelConfig) -> String {
    if let Some(group) = model
        .group_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return group.to_owned();
    }
    if let Some(host) = host(&model.base_url) {
        return known_host_provider(&host)
            .map(str::to_owned)
            .unwrap_or(host);
    }
    model.base_url.trim().to_owned()
}

fn group_configured_models(mut configured: Vec<ModelConfig>) -> Vec<(ModelConfig, String, String)> {
    configured.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| {
                left.display_name
                    .to_lowercase()
                    .cmp(&right.display_name.to_lowercase())
            })
            .then_with(|| left.display_name.cmp(&right.display_name))
            .then_with(|| left.model_hash.cmp(&right.model_hash))
    });
    let mut group_order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, Vec<(ModelConfig, String, String)>> = HashMap::new();
    for model in configured {
        let group = configured_group_slug(&model);
        let provider_name = configured_provider_name(&model);
        let key = provider_name.to_lowercase();
        if let Some(bucket) = grouped.get_mut(&key) {
            bucket.push((model, group, provider_name));
        } else {
            group_order.push(key.clone());
            grouped.insert(key, vec![(model, group, provider_name)]);
        }
    }
    group_order
        .into_iter()
        .filter_map(|key| grouped.remove(&key))
        .flatten()
        .collect()
}

fn group_provider_models(
    provider_models: Vec<ProviderModelDescriptor>,
) -> Vec<ProviderModelDescriptor> {
    let mut groups: Vec<(String, String, Vec<ProviderModelDescriptor>)> = Vec::new();
    let mut indices: HashMap<String, usize> = HashMap::new();
    for model in provider_models {
        if let Some(&index) = indices.get(&model.provider_id) {
            groups[index].2.push(model);
        } else {
            let index = groups.len();
            indices.insert(model.provider_id.clone(), index);
            groups.push((
                model.provider_name.to_lowercase(),
                model.provider_id.clone(),
                vec![model],
            ));
        }
    }
    groups.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    groups
        .into_iter()
        .flat_map(|(_, _, models)| models)
        .collect()
}

pub(crate) async fn list(store: &Store, providers: &ProviderRegistry) -> Result<Vec<ListedModel>> {
    let mut models = Vec::new();
    let mut ids = HashSet::new();
    for (model, group, provider_name) in group_configured_models(store.models().await?) {
        let public_id = format!("{group}/{}", model.model_id);
        if ids.insert(public_id.clone()) {
            models.push(ListedModel {
                public_id,
                internal_id: model.model_hash,
                provider_name,
                display_name: model.display_name,
                context_window: model.context_window_tokens,
                // A manually configured model does not declare its modalities.
                images: true,
            });
        }
    }
    for model in group_provider_models(providers.configured_models().await) {
        let public_id = format!(
            "provider:{}:{}/{}",
            model.provider_id, model.channel_id, model.model_id
        );
        if ids.insert(public_id.clone()) {
            models.push(ListedModel {
                public_id,
                internal_id: model.id,
                provider_name: model.provider_name,
                display_name: model.display_name,
                context_window: model.context_window,
                images: model.images,
            });
        }
    }
    Ok(models)
}

pub(super) fn response(models: &[ListedModel]) -> Value {
    json!({"object":"list","data":models.iter().map(|model| json!({
        "id":model.public_id,
        "object":"model",
        "created":0,
        "owned_by":model.provider_name,
        "name":model.labeled_display_name(),
    })).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModelType, OPENAI_CHAT_ENDPOINT};

    fn sample_model(
        hash: &str,
        sort_order: i64,
        display_name: &str,
        group_name: Option<&str>,
        base_url: &str,
    ) -> ModelConfig {
        ModelConfig {
            model_hash: hash.into(),
            sort_order,
            display_name: display_name.into(),
            group_name: group_name.map(str::to_owned),
            model_type: ModelType::OpenAi,
            base_url: base_url.into(),
            use_full_url: false,
            api_key: "key".into(),
            tooltip_data: String::new(),
            model_id: hash.into(),
            reasoning_effort: None,
            openai_endpoint: OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: json!({}),
            custom_headers_enabled: false,
            custom_headers: json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: json!({}),
            context_window_tokens: None,
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
            created_at_ms: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn labeled_display_name_prefixes_provider_without_duplicating_existing_tag() {
        let model = ListedModel {
            public_id: "provider:codex:main/gpt-6.1".into(),
            internal_id: "provider:codex/main/gpt-6.1".into(),
            provider_name: "Codex".into(),
            display_name: "6.1".into(),
            context_window: None,
            images: true,
        };
        assert_eq!(model.labeled_display_name(), "[Codex] 6.1");

        let already_tagged = ListedModel {
            display_name: "[codex] 6.1".into(),
            ..model
        };
        assert_eq!(already_tagged.labeled_display_name(), "[codex] 6.1");
    }

    #[test]
    fn configured_models_keep_same_provider_contiguous_and_resolve_known_hosts() {
        let grouped = group_configured_models(vec![
            sample_model(
                "r1",
                0,
                "GLM 5.3 Abliterated",
                None,
                "https://api.refuseless.com",
            ),
            sample_model(
                "o1",
                1,
                "anthropic/claude-sonnet-5",
                None,
                "https://api.orcarouter.ai",
            ),
            sample_model(
                "r2",
                2,
                "deepseek-v4.1-flash-abliterated",
                None,
                "https://api.refuseless.com",
            ),
        ]);
        let labels = grouped
            .iter()
            .map(|(model, slug, provider)| {
                (model.model_hash.as_str(), slug.as_str(), provider.as_str())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            vec![
                ("r1", "api.refuseless.com", "Refuseless"),
                ("r2", "api.refuseless.com", "Refuseless"),
                ("o1", "api.orcarouter.ai", "OrcaRouter"),
            ]
        );
    }

    #[test]
    fn provider_groups_order_alphabetically_by_provider_name_and_preserve_catalog_order() {
        let make =
            |provider_id: &str, provider_name: &str, model_id: &str| ProviderModelDescriptor {
                id: format!("provider:{provider_id}/ch/{model_id}"),
                provider_id: provider_id.into(),
                provider_name: provider_name.into(),
                channel_id: "ch".into(),
                model_id: model_id.into(),
                display_name: model_id.into(),
                description: None,
                icon: String::new(),
                brand: provider_id.into(),
                max_output_tokens: None,
                context_window: None,
                images: true,
                options: Default::default(),
                enabled: true,
            };
        let ordered = group_provider_models(vec![
            make(
                "dev.cursorbyok.providers.antigravity-auth",
                "Google",
                "gemini-4",
            ),
            make("dev.cursorbyok.providers.claude", "Claude", "opus-5.5"),
            make("dev.cursorbyok.providers.claude", "Claude", "sonnet-5.5"),
            make("dev.cursorbyok.providers.codex-auth", "Codex", "gpt-5.3"),
        ]);
        let pairs = ordered
            .iter()
            .map(|model| (model.provider_name.as_str(), model.model_id.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            pairs,
            vec![
                ("Claude", "opus-5.5"),
                ("Claude", "sonnet-5.5"),
                ("Codex", "gpt-5.3"),
                ("Google", "gemini-4"),
            ]
        );
    }
}
