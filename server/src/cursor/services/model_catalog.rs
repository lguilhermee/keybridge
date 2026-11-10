//! Publishes the configured model catalog to Cursor.
use std::collections::HashMap;

use axum::{
    body::{Body, Bytes},
    extract::{Extension, State},
    http::{header, HeaderValue, Request, Response, StatusCode},
};
use bytes::{BufMut, BytesMut};
use prost::Message;

use crate::{
    api::{
        byok::{configured_provider_name, provider_tag},
        cursor::proxy::{self, CursorProxy},
    },
    cursor::{protocol::proto::agent::v1 as agent, transport::TransportRegistry},
    model::{format_token_count, parse_token_count, ComboConfig, ModelConfig},
    provider::{ModelOptions, ProviderModelDescriptor},
    Error, Result,
};

#[derive(Clone, PartialEq, Message)]
struct AvailableModelsAddition {
    #[prost(string, repeated, tag = "1")]
    model_names: Vec<String>,
    #[prost(message, repeated, tag = "2")]
    models: Vec<AvailableModel>,
}

#[derive(Clone, PartialEq, Message)]
struct AvailableModel {
    #[prost(string, tag = "1")]
    name: String,
    #[prost(bool, tag = "2")]
    default_on: bool,
    #[prost(bool, optional, tag = "5")]
    supports_agent: Option<bool>,
    #[prost(int32, optional, tag = "6")]
    degradation_status: Option<i32>,
    #[prost(message, optional, tag = "8")]
    tooltip_data: Option<TooltipData>,
    #[prost(bool, optional, tag = "9")]
    supports_thinking: Option<bool>,
    #[prost(bool, optional, tag = "10")]
    supports_images: Option<bool>,
    #[prost(bool, optional, tag = "14")]
    supports_max_mode: Option<bool>,
    #[prost(string, optional, tag = "17")]
    client_display_name: Option<String>,
    #[prost(string, optional, tag = "18")]
    server_model_name: Option<String>,
    #[prost(bool, optional, tag = "19")]
    supports_non_max_mode: Option<bool>,
    #[prost(message, optional, tag = "20")]
    tooltip_data_for_max_mode: Option<TooltipData>,
    #[prost(bool, optional, tag = "21")]
    is_recommended_for_background_composer: Option<bool>,
    #[prost(bool, optional, tag = "22")]
    supports_plan_mode: Option<bool>,
    #[prost(string, optional, tag = "24")]
    inputbox_short_model_name: Option<String>,
    #[prost(bool, optional, tag = "25")]
    supports_sandboxing: Option<bool>,
    #[prost(bool, optional, tag = "26")]
    supports_cmd_k: Option<bool>,
    #[prost(message, repeated, tag = "29")]
    parameter_definitions: Vec<ModelParameterDefinition>,
    #[prost(message, repeated, tag = "30")]
    variants: Vec<ModelVariant>,
    #[prost(string, repeated, tag = "36")]
    legacy_slugs: Vec<String>,
    #[prost(int32, optional, tag = "38")]
    named_model_section_index: Option<i32>,
    #[prost(string, optional, tag = "41")]
    vendor_name: Option<String>,
    #[prost(message, optional, tag = "42")]
    vendor: Option<AvailableModelVendor>,
    #[prost(message, repeated, tag = "48")]
    model_picker_badges: Vec<ModelPickerBadge>,
}

#[derive(Clone, PartialEq, Message)]
struct TooltipData {
    #[prost(string, optional, tag = "7")]
    markdown_content: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
struct ModelParameterDefinition {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    name: String,
    #[prost(string, optional, tag = "3")]
    markdown_tooltip: Option<String>,
    #[prost(message, optional, tag = "4")]
    parameter_type: Option<ModelParameterType>,
    #[prost(bool, optional, tag = "5")]
    is_cycleable_by_hotkey: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
struct ModelParameterType {
    #[prost(message, optional, tag = "1")]
    boolean_parameter: Option<BooleanParameter>,
    #[prost(message, optional, tag = "2")]
    enum_parameter: Option<EnumParameter>,
}

#[derive(Clone, PartialEq, Message)]
struct BooleanParameter {
    #[prost(message, repeated, tag = "1")]
    values: Vec<BooleanParameterValue>,
}

#[derive(Clone, PartialEq, Message)]
struct BooleanParameterValue {
    #[prost(string, tag = "1")]
    value: String,
    #[prost(string, optional, tag = "2")]
    display_name: Option<String>,
    #[prost(bool, optional, tag = "3")]
    increases_model_cost: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
struct EnumParameter {
    #[prost(message, repeated, tag = "1")]
    values: Vec<EnumParameterValue>,
}

#[derive(Clone, PartialEq, Message)]
struct EnumParameterValue {
    #[prost(string, tag = "1")]
    value: String,
    #[prost(string, optional, tag = "2")]
    display_name: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
struct ModelVariant {
    #[prost(message, repeated, tag = "1")]
    parameter_values: Vec<ModelParameterValue>,
    #[prost(string, tag = "2")]
    display_name: String,
    #[prost(bool, tag = "3")]
    is_max_mode: bool,
    #[prost(bool, optional, tag = "4")]
    is_default_max_config: Option<bool>,
    #[prost(bool, optional, tag = "5")]
    is_default_non_max_config: Option<bool>,
    #[prost(message, optional, tag = "6")]
    tooltip_data: Option<TooltipData>,
    #[prost(string, optional, tag = "8")]
    display_name_outside_picker: Option<String>,
    #[prost(string, optional, tag = "9")]
    variant_string_representation: Option<String>,
    #[prost(string, optional, tag = "11")]
    legacy_slug: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
struct ModelParameterValue {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    value: String,
}

#[derive(Clone, PartialEq, Message)]
struct ModelPickerBadge {
    #[prost(string, tag = "1")]
    label: String,
    #[prost(int32, tag = "2")]
    variant: i32,
    #[prost(bool, tag = "3")]
    dismiss_on_selection: bool,
}

#[derive(Clone, PartialEq, Message)]
struct AvailableModelVendor {
    #[prost(int32, tag = "1")]
    id: i32,
    #[prost(string, tag = "2")]
    display_name: String,
}

#[derive(Clone, PartialEq, Message)]
struct UsableModelsAddition {
    #[prost(message, repeated, tag = "1")]
    models: Vec<agent::ModelDetails>,
}

#[derive(Clone, PartialEq, Message)]
struct DefaultModelResponse {
    #[prost(string, tag = "1")]
    model: String,
    #[prost(string, tag = "2")]
    thinking_model: String,
    #[prost(bool, tag = "3")]
    max_mode: bool,
    #[prost(string, tag = "4")]
    next_default_set_date: String,
}

#[derive(Clone, PartialEq, Message)]
struct DefaultModelNudgeDataResponse {
    #[prost(string, tag = "1")]
    nudge_date: String,
    #[prost(bool, tag = "2")]
    should_default_switch_on_new_chat: bool,
    #[prost(string, repeated, tag = "3")]
    models_with_no_default_switch: Vec<String>,
    #[prost(string, tag = "4")]
    conversion_model_override: String,
}

const CLI_LOCAL_MODEL_API_KEY: &str = "cursor-byok-local";

const CONTEXTS: [(&str, &str); 5] = [
    ("200k", "200K"),
    ("356k", "356K"),
    ("500k", "500K"),
    ("800k", "800K"),
    ("1m", "1M"),
];
/// Settings one picker entry offers: Effort levels (ascending), preselected effort, and Fast.
struct PickerOptions {
    efforts: Vec<String>,
    default_effort: Option<String>,
    fast: bool,
}

impl PickerOptions {
    fn standard() -> Self {
        Self::provider(&ModelOptions::manual())
    }

    /// Provider models offer exactly settings declare.
    fn provider(options: &ModelOptions) -> Self {
        Self {
            efforts: options.efforts.clone(),
            default_effort: options.preselected_effort().map(str::to_owned),
            fast: options.fast,
        }
    }
}

fn effort_display_name(effort: &str) -> String {
    match effort {
        "xhigh" => "Extra High".into(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect())
                .unwrap_or_default()
        }
    }
}

/// Context choices; the first one is preselected.
fn context_options(context_window_tokens: Option<u64>) -> Vec<(String, String)> {
    let mut contexts = CONTEXTS
        .into_iter()
        .map(|(value, display_name)| (value.to_owned(), display_name.to_owned()))
        .collect::<Vec<_>>();
    if let Some(tokens) = context_window_tokens {
        push_custom_context(&mut contexts, tokens);
    }
    contexts
}

/// Provider models know their window, so they only offer contexts that fit in it.
fn provider_context_options(context_window: Option<u64>) -> Vec<(String, String)> {
    let Some(window) = context_window else {
        return context_options(None);
    };
    let mut contexts = CONTEXTS
        .into_iter()
        .filter(|(value, _)| parse_token_count(value).is_some_and(|tokens| tokens <= window))
        .map(|(value, display_name)| (value.to_owned(), display_name.to_owned()))
        .collect::<Vec<_>>();
    push_custom_context(&mut contexts, window);
    contexts
}

fn push_custom_context(contexts: &mut Vec<(String, String)>, tokens: u64) {
    let duplicate = contexts
        .iter()
        .any(|(existing, _)| parse_token_count(existing) == Some(tokens));
    if !duplicate {
        contexts.push((
            tokens.to_string(),
            format!("{} (Custom)", format_token_count(tokens)),
        ));
    }
}

pub async fn available_models(
    State(registry): State<TransportRegistry>,
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let combos = registry.store().combos().await?;
    let provider_models = match registry.providers() {
        Some(providers) => providers.configured_models().await,
        None => Vec::new(),
    };
    tracing::info!(
        model_count = models.len(),
        combo_count = combos.len(),
        provider_model_count = provider_models.len(),
        "appending BYOK models to Cursor AvailableModels"
    );
    let member_names = models
        .iter()
        .map(|model| (model.model_hash.as_str(), model.display_name.as_str()))
        .chain(
            provider_models
                .iter()
                .map(|model| (model.id.as_str(), model.display_name.as_str())),
        )
        .collect::<HashMap<_, _>>();
    let mut available_models = combos
        .iter()
        .map(|combo| available_combo(combo, &member_names))
        .collect::<Vec<_>>();
    available_models.extend(models.iter().map(available_model));
    available_models.extend(provider_models.iter().map(available_provider_model));
    let local = AvailableModelsAddition {
        model_names: combos
            .iter()
            .map(|combo| combo.combo_id.clone())
            .chain(models.iter().map(|model| model.model_hash.clone()))
            .chain(provider_models.iter().map(|model| model.id.clone()))
            .collect(),
        models: available_models,
    }
    .encode_to_vec();
    match proxy::forward_buffered(&proxy, request).await {
        Ok(upstream) => merge_response(upstream, local),
        Err(error) => {
            tracing::warn!(%error, "Cursor AvailableModels upstream unavailable; using local catalog");
            Ok(local_response(local))
        }
    }
}

pub async fn usable_models(
    State(registry): State<TransportRegistry>,
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let combos = registry.store().combos().await?;
    let provider_models = match registry.providers() {
        Some(providers) => providers.configured_models().await,
        None => Vec::new(),
    };
    tracing::info!(
        model_count = models.len(),
        combo_count = combos.len(),
        provider_model_count = provider_models.len(),
        "appending BYOK models to Cursor GetUsableModels"
    );
    let local = UsableModelsAddition {
        models: combos
            .iter()
            .map(usable_combo)
            .chain(models.iter().map(usable_model))
            .chain(provider_models.iter().map(usable_provider_model))
            .collect(),
    }
    .encode_to_vec();
    match proxy::forward_buffered(&proxy, request).await {
        Ok(upstream) => merge_response(upstream, local),
        Err(error) => {
            tracing::warn!(%error, "Cursor GetUsableModels upstream unavailable; using local catalog");
            Ok(local_response(local))
        }
    }
}

pub async fn default_model_for_cli(
    State(registry): State<TransportRegistry>,
) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let provider_models = configured_provider_models(&registry).await;
    Ok(local_response(
        agent::GetDefaultModelForCliResponse {
            model: default_model_details(&models, &provider_models),
        }
        .encode_to_vec(),
    ))
}

pub async fn default_model(State(registry): State<TransportRegistry>) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let provider_models = configured_provider_models(&registry).await;
    Ok(local_response(
        default_model_response(&models, &provider_models).encode_to_vec(),
    ))
}

pub async fn default_model_nudge(
    State(registry): State<TransportRegistry>,
) -> Result<Response<Body>> {
    let models = registry.store().models().await?;
    let provider_models = configured_provider_models(&registry).await;
    Ok(local_response(
        default_model_nudge_response(&models, &provider_models).encode_to_vec(),
    ))
}

async fn configured_provider_models(registry: &TransportRegistry) -> Vec<ProviderModelDescriptor> {
    match registry.providers() {
        Some(providers) => providers.configured_models().await,
        None => Vec::new(),
    }
}

fn default_model_details(
    models: &[ModelConfig],
    provider_models: &[ProviderModelDescriptor],
) -> Option<agent::ModelDetails> {
    models
        .first()
        .map(usable_model)
        .or_else(|| provider_models.first().map(usable_provider_model))
}

fn default_model_id<'a>(
    models: &'a [ModelConfig],
    provider_models: &'a [ProviderModelDescriptor],
) -> &'a str {
    models
        .first()
        .map(|model| model.model_hash.as_str())
        .or_else(|| provider_models.first().map(|model| model.id.as_str()))
        .unwrap_or_default()
}

fn default_model_response(
    models: &[ModelConfig],
    provider_models: &[ProviderModelDescriptor],
) -> DefaultModelResponse {
    let model = default_model_id(models, provider_models).to_owned();
    DefaultModelResponse {
        thinking_model: model.clone(),
        model,
        max_mode: false,
        next_default_set_date: String::new(),
    }
}

fn default_model_nudge_response(
    models: &[ModelConfig],
    provider_models: &[ProviderModelDescriptor],
) -> DefaultModelNudgeDataResponse {
    DefaultModelNudgeDataResponse {
        nudge_date: "0".into(),
        should_default_switch_on_new_chat: false,
        models_with_no_default_switch: models
            .iter()
            .map(|model| model.model_hash.clone())
            .chain(provider_models.iter().map(|model| model.id.clone()))
            .collect(),
        conversion_model_override: String::new(),
    }
}

fn merge_response(upstream: proxy::BufferedResponse, extra: Vec<u8>) -> Result<Response<Body>> {
    if !upstream.status.is_success() {
        tracing::warn!(status = %upstream.status, "Cursor model catalog upstream rejected request; using local catalog");
        return Ok(local_response(extra));
    }
    let (framed, payload) = unary_payload(&upstream.body)?;
    let body = if framed {
        let mut merged = BytesMut::with_capacity(5 + payload.len() + extra.len());
        merged.put_u8(0);
        merged.put_u32((payload.len() + extra.len()) as u32);
        merged.extend_from_slice(payload);
        merged.extend_from_slice(&extra);
        merged.freeze()
    } else {
        let mut merged = BytesMut::with_capacity(payload.len() + extra.len());
        merged.extend_from_slice(payload);
        merged.extend_from_slice(&extra);
        merged.freeze()
    };
    Ok(upstream.with_body(body))
}

fn local_response(body: Vec<u8>) -> Response<Body> {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/proto"),
    );
    response
}

fn unary_payload(body: &Bytes) -> Result<(bool, &[u8])> {
    if body.len() < 5 {
        return Ok((false, body));
    }
    let flags = body[0];
    let length = u32::from_be_bytes([body[1], body[2], body[3], body[4]]) as usize;
    if length != body.len() - 5 {
        return Ok((false, body));
    }
    if flags != 0 {
        return Err(Error::Protocol(format!(
            "cannot merge compressed or terminal model catalog frame: flags={flags}"
        )));
    }
    Ok((true, &body[5..]))
}

fn available_model(model: &ModelConfig) -> AvailableModel {
    let contexts = context_options(model.context_window_tokens);
    let options = PickerOptions::standard();
    let tooltip = model_tooltip(model);
    let variants = model_variants(
        &model.model_hash,
        &model.display_name,
        &tooltip,
        &contexts,
        &options,
    );
    let legacy_slugs = variants
        .iter()
        .filter_map(|variant| variant.legacy_slug.clone())
        .collect();
    AvailableModel {
        name: model.model_hash.clone(),
        default_on: true,
        supports_agent: Some(true),
        degradation_status: Some(0),
        tooltip_data: Some(tooltip.clone()),
        supports_thinking: Some(true),
        supports_images: Some(true),
        supports_max_mode: Some(true),
        client_display_name: Some(model.display_name.clone()),
        server_model_name: Some(model.model_hash.clone()),
        supports_non_max_mode: Some(true),
        tooltip_data_for_max_mode: Some(tooltip),
        is_recommended_for_background_composer: Some(false),
        supports_plan_mode: Some(true),
        inputbox_short_model_name: Some(model.display_name.clone()),
        supports_sandboxing: Some(true),
        supports_cmd_k: Some(false),
        parameter_definitions: model_parameters(&contexts, &options),
        variants,
        legacy_slugs,
        named_model_section_index: Some(1),
        vendor_name: Some("cursor".into()),
        vendor: Some(AvailableModelVendor {
            id: 6,
            display_name: "Cursor".into(),
        }),
        model_picker_badges: vec![ModelPickerBadge {
            label: badge_label(model),
            variant: BADGE_ACCENT,
            dismiss_on_selection: false,
        }],
    }
}

/// Cursor's `ModelPickerBadge.Variant.VARIANT_ACCENT` (blue).
const BADGE_ACCENT: i32 = 1;

/// Short provider tag so badge never crowds out model name.
fn badge_label(model: &ModelConfig) -> String {
    provider_tag(&configured_provider_name(model))
}

fn model_parameters(
    contexts: &[(String, String)],
    options: &PickerOptions,
) -> Vec<ModelParameterDefinition> {
    let mut parameters = vec![ModelParameterDefinition {
        id: "context".into(),
        name: "Context".into(),
        markdown_tooltip: Some("Context size used to trigger conversation compaction.".into()),
        parameter_type: Some(ModelParameterType {
            boolean_parameter: None,
            enum_parameter: Some(EnumParameter {
                values: contexts
                    .iter()
                    .map(|(value, display_name)| EnumParameterValue {
                        value: value.clone(),
                        display_name: Some(display_name.clone()),
                    })
                    .collect(),
            }),
        }),
        is_cycleable_by_hotkey: Some(false),
    }];
    if !options.efforts.is_empty() {
        parameters.push(ModelParameterDefinition {
            id: "reasoning".into(),
            name: "Effort".into(),
            markdown_tooltip: Some("Effort the model uses to generate a response.".into()),
            parameter_type: Some(ModelParameterType {
                boolean_parameter: None,
                enum_parameter: Some(EnumParameter {
                    values: options
                        .efforts
                        .iter()
                        .map(|effort| EnumParameterValue {
                            value: effort.clone(),
                            display_name: Some(effort_display_name(effort)),
                        })
                        .collect(),
                }),
            }),
            is_cycleable_by_hotkey: Some(true),
        });
    }
    if options.fast {
        parameters.push(ModelParameterDefinition {
            id: "fast".into(),
            name: "Fast".into(),
            markdown_tooltip: Some("Significantly faster but consumes more usage".into()),
            parameter_type: Some(ModelParameterType {
                boolean_parameter: Some(BooleanParameter {
                    values: vec![
                        BooleanParameterValue {
                            value: "false".into(),
                            display_name: None,
                            increases_model_cost: None,
                        },
                        BooleanParameterValue {
                            value: "true".into(),
                            display_name: Some("Fast".into()),
                            increases_model_cost: Some(true),
                        },
                    ],
                }),
                enum_parameter: None,
            }),
            is_cycleable_by_hotkey: Some(false),
        });
    }
    parameters
}

/// One variant per Context x Effort x Fast combination the entry offers.
fn model_variants(
    name: &str,
    display_name: &str,
    tooltip: &TooltipData,
    contexts: &[(String, String)],
    options: &PickerOptions,
) -> Vec<ModelVariant> {
    let efforts = if options.efforts.is_empty() {
        vec![None]
    } else {
        options
            .efforts
            .iter()
            .map(|effort| Some(effort.as_str()))
            .collect()
    };
    let fasts: &[bool] = if options.fast {
        &[false, true]
    } else {
        &[false]
    };
    let mut variants = Vec::with_capacity(contexts.len() * efforts.len() * fasts.len());
    for (index, (context, context_name)) in contexts.iter().enumerate() {
        for effort in &efforts {
            for &fast in fasts {
                variants.push(model_variant(
                    VariantEntry {
                        name,
                        display_name,
                        tooltip,
                    },
                    (context, context_name, index == 0),
                    *effort,
                    fast,
                    options,
                ));
            }
        }
    }
    variants
}

struct VariantEntry<'a> {
    name: &'a str,
    display_name: &'a str,
    tooltip: &'a TooltipData,
}

fn model_variant(
    entry: VariantEntry<'_>,
    (context, context_name, default_context): (&str, &str, bool),
    effort: Option<&str>,
    fast: bool,
    options: &PickerOptions,
) -> ModelVariant {
    let mut suffix = Vec::with_capacity(3);
    if !default_context {
        suffix.push(context_name.to_owned());
    }
    if let Some(effort) = effort {
        suffix.push(effort_display_name(effort));
    }
    if fast {
        suffix.push("Fast".into());
    }
    let suffix = suffix.join(" ");
    let display_name = if suffix.is_empty() {
        entry.display_name.to_owned()
    } else {
        format!(
            "{} <span style=\"color: var(--cursor-text-tertiary);\">{suffix}</span>",
            entry.display_name
        )
    };
    let is_default = default_context && !fast && effort == options.default_effort.as_deref();
    let mut parameter_values = vec![ModelParameterValue {
        id: "context".into(),
        value: context.into(),
    }];
    if let Some(effort) = effort {
        parameter_values.push(ModelParameterValue {
            id: "reasoning".into(),
            value: effort.into(),
        });
    }
    if options.fast {
        parameter_values.push(ModelParameterValue {
            id: "fast".into(),
            value: fast.to_string(),
        });
    }
    let representation = parameter_values
        .iter()
        .map(|parameter| format!("{}={}", parameter.id, parameter.value))
        .collect::<Vec<_>>()
        .join(",");
    ModelVariant {
        variant_string_representation: Some(format!("{}[{representation}]", entry.name)),
        legacy_slug: Some(format!(
            "{}-{context}{}{}",
            entry.name,
            effort
                .map(|effort| format!("-{effort}"))
                .unwrap_or_default(),
            if fast { "-fast" } else { "" }
        )),
        parameter_values,
        display_name: display_name.clone(),
        is_max_mode: false,
        is_default_max_config: is_default.then_some(true),
        is_default_non_max_config: is_default.then_some(true),
        tooltip_data: Some(entry.tooltip.clone()),
        display_name_outside_picker: Some(display_name),
    }
}

fn model_tooltip(model: &ModelConfig) -> TooltipData {
    TooltipData {
        markdown_content: Some(model.tooltip_data.clone()),
    }
}

fn available_provider_model(model: &ProviderModelDescriptor) -> AvailableModel {
    let tooltip = TooltipData {
        markdown_content: model.description.clone(),
    };
    let contexts = provider_context_options(model.context_window);
    let options = PickerOptions::provider(&model.options);
    let variants = model_variants(
        &model.id,
        &model.display_name,
        &tooltip,
        &contexts,
        &options,
    );
    let legacy_slugs = variants
        .iter()
        .filter_map(|variant| variant.legacy_slug.clone())
        .collect();
    AvailableModel {
        name: model.id.clone(),
        default_on: true,
        supports_agent: Some(true),
        degradation_status: Some(0),
        tooltip_data: Some(tooltip.clone()),
        supports_thinking: Some(true),
        supports_images: Some(model.images),
        supports_max_mode: Some(false),
        client_display_name: Some(model.display_name.clone()),
        server_model_name: Some(model.id.clone()),
        supports_non_max_mode: Some(true),
        tooltip_data_for_max_mode: Some(tooltip.clone()),
        is_recommended_for_background_composer: Some(false),
        supports_plan_mode: Some(true),
        inputbox_short_model_name: Some(model.display_name.clone()),
        supports_sandboxing: Some(true),
        supports_cmd_k: Some(false),
        parameter_definitions: model_parameters(&contexts, &options),
        variants,
        legacy_slugs,
        named_model_section_index: Some(1),
        vendor_name: Some(model.brand.clone()),
        vendor: Some(AvailableModelVendor {
            id: 6,
            display_name: model.brand.clone(),
        }),
        model_picker_badges: vec![ModelPickerBadge {
            label: model.provider_name.clone(),
            variant: BADGE_ACCENT,
            dismiss_on_selection: false,
        }],
    }
}

/// One picker entry for a combo. Context and effort apply to whichever member answers.
fn available_combo(combo: &ComboConfig, member_names: &HashMap<&str, &str>) -> AvailableModel {
    let members = combo
        .members
        .iter()
        .map(|member| member_names.get(member.as_str()).copied().unwrap_or(member))
        .collect::<Vec<_>>()
        .join(" → ");
    let tooltip = TooltipData {
        markdown_content: Some(format!("Combo ({}): {members}", combo.strategy.as_str())),
    };
    let contexts = context_options(None);
    let options = PickerOptions::standard();
    let variants = model_variants(
        &combo.combo_id,
        &combo.display_name,
        &tooltip,
        &contexts,
        &options,
    );
    let legacy_slugs = variants
        .iter()
        .filter_map(|variant| variant.legacy_slug.clone())
        .collect();
    AvailableModel {
        name: combo.combo_id.clone(),
        default_on: true,
        supports_agent: Some(true),
        degradation_status: Some(0),
        tooltip_data: Some(tooltip.clone()),
        supports_thinking: Some(true),
        supports_images: Some(true),
        supports_max_mode: Some(false),
        client_display_name: Some(combo.display_name.clone()),
        server_model_name: Some(combo.combo_id.clone()),
        supports_non_max_mode: Some(true),
        tooltip_data_for_max_mode: Some(tooltip),
        is_recommended_for_background_composer: Some(false),
        supports_plan_mode: Some(true),
        inputbox_short_model_name: Some(combo.display_name.clone()),
        supports_sandboxing: Some(true),
        supports_cmd_k: Some(false),
        parameter_definitions: model_parameters(&contexts, &options),
        variants,
        legacy_slugs,
        named_model_section_index: Some(1),
        vendor_name: Some("cursor".into()),
        vendor: Some(AvailableModelVendor {
            id: 6,
            display_name: "Cursor".into(),
        }),
        model_picker_badges: vec![ModelPickerBadge {
            label: "Combo".into(),
            variant: BADGE_ACCENT,
            dismiss_on_selection: false,
        }],
    }
}

fn usable_combo(combo: &ComboConfig) -> agent::ModelDetails {
    agent::ModelDetails {
        model_id: combo.combo_id.clone(),
        display_model_id: combo.combo_id.clone(),
        display_name: combo.display_name.clone(),
        display_name_short: combo.display_name.clone(),
        thinking_details: Some(agent::ThinkingDetails::default()),
        credentials: Some(cli_local_model_credentials()),
        ..Default::default()
    }
}

fn cli_local_model_credentials() -> agent::model_details::Credentials {
    agent::model_details::Credentials::ApiKeyCredentials(agent::ApiKeyCredentials {
        api_key: CLI_LOCAL_MODEL_API_KEY.into(),
        base_url: None,
    })
}

fn usable_provider_model(model: &ProviderModelDescriptor) -> agent::ModelDetails {
    agent::ModelDetails {
        model_id: model.id.clone(),
        display_model_id: model.id.clone(),
        display_name: model.display_name.clone(),
        display_name_short: model.display_name.clone(),
        thinking_details: Some(agent::ThinkingDetails::default()),
        credentials: Some(cli_local_model_credentials()),
        ..Default::default()
    }
}

fn usable_model(model: &ModelConfig) -> agent::ModelDetails {
    agent::ModelDetails {
        model_id: model.model_hash.clone(),
        display_model_id: model.model_hash.clone(),
        display_name: model.display_name.clone(),
        display_name_short: model.display_name.clone(),
        thinking_details: Some(agent::ThinkingDetails::default()),
        credentials: Some(cli_local_model_credentials()),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModelType, OPENAI_CHAT_ENDPOINT};

    fn model() -> ModelConfig {
        ModelConfig {
            model_hash: "local-model-hash".into(),
            sort_order: 0,
            display_name: "Local Model".into(),
            group_name: None,
            model_type: ModelType::OpenAi,
            base_url: "https://provider.example/v1/chat/completions".into(),
            use_full_url: true,
            api_key: "provider-secret".into(),
            tooltip_data: "Local Model".into(),
            model_id: "upstream-model".into(),
            reasoning_effort: None,
            openai_endpoint: OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
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
    fn cli_model_details_use_local_routing_credentials() {
        let details = usable_model(&model());
        assert_eq!(details.model_id, "local-model-hash");
        assert_eq!(details.display_name, "Local Model");
        let agent::model_details::Credentials::ApiKeyCredentials(credentials) =
            details.credentials.expect("API credentials")
        else {
            panic!("expected API key credentials");
        };
        assert_eq!(credentials.api_key, CLI_LOCAL_MODEL_API_KEY);
        assert_eq!(credentials.base_url, None);
        assert_ne!(credentials.api_key, "provider-secret");
    }

    #[test]
    fn cli_provider_model_details_use_local_routing_credentials() {
        let details = usable_provider_model(&ProviderModelDescriptor {
            id: "provider:test/channel/model".into(),
            provider_id: "test".into(),
            provider_name: "Test Provider".into(),
            channel_id: "channel".into(),
            model_id: "model".into(),
            display_name: "Provider Model".into(),
            description: None,
            icon: String::new(),
            brand: "test".into(),
            max_output_tokens: None,
            context_window: None,
            images: false,
            options: Default::default(),
            enabled: true,
        });
        assert_eq!(details.model_id, "provider:test/channel/model");
        let agent::model_details::Credentials::ApiKeyCredentials(credentials) =
            details.credentials.expect("API credentials")
        else {
            panic!("expected API key credentials");
        };
        assert_eq!(credentials.api_key, CLI_LOCAL_MODEL_API_KEY);
        assert_eq!(credentials.base_url, None);
    }

    #[test]
    fn cli_default_responses_use_the_local_model_hash() {
        let models = vec![model()];
        let details = default_model_details(&models, &[]).expect("default model");
        assert_eq!(details.model_id, "local-model-hash");

        let response = default_model_response(&models, &[]);
        assert_eq!(response.model, "local-model-hash");
        assert_eq!(response.thinking_model, "local-model-hash");

        let nudge = default_model_nudge_response(&models, &[]);
        assert_eq!(
            nudge.models_with_no_default_switch,
            vec!["local-model-hash"]
        );
    }

    fn provider_model(
        options: ModelOptions,
        context_window: Option<u64>,
    ) -> ProviderModelDescriptor {
        ProviderModelDescriptor {
            id: "provider:test/channel/family".into(),
            provider_id: "test".into(),
            provider_name: "Test Provider".into(),
            channel_id: "channel".into(),
            model_id: "family".into(),
            display_name: "Family".into(),
            description: None,
            icon: String::new(),
            brand: "test".into(),
            max_output_tokens: None,
            context_window,
            images: false,
            options,
            enabled: true,
        }
    }

    #[test]
    fn provider_picker_offers_only_declared_settings() {
        let model = available_provider_model(&provider_model(
            ModelOptions {
                efforts: vec!["none".into(), "low".into(), "xhigh".into()],
                default_effort: None,
                fast: false,
            },
            Some(500_000),
        ));

        let parameters = model
            .parameter_definitions
            .iter()
            .map(|parameter| parameter.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(parameters, ["context", "reasoning"]);
        let efforts = model.parameter_definitions[1]
            .parameter_type
            .as_ref()
            .and_then(|kind| kind.enum_parameter.as_ref())
            .unwrap()
            .values
            .iter()
            .map(|value| (value.value.as_str(), value.display_name.as_deref().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(
            efforts,
            [("none", "None"), ("low", "Low"), ("xhigh", "Extra High")]
        );

        // Contexts stop at the model window: 200K, 356K, 500K.
        assert_eq!(model.variants.len(), 3 * 3);
        // Without a declared default the highest level is preselected.
        let defaults = model
            .variants
            .iter()
            .filter(|variant| variant.is_default_non_max_config == Some(true))
            .map(|variant| variant.variant_string_representation.as_deref().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            defaults,
            ["provider:test/channel/family[context=200k,reasoning=xhigh]"]
        );
    }

    #[test]
    fn provider_picker_without_options_is_a_single_context_choice() {
        let model = available_provider_model(&provider_model(ModelOptions::default(), None));
        assert_eq!(model.parameter_definitions.len(), 1);
        assert_eq!(model.variants.len(), CONTEXTS.len());
        assert_eq!(
            model.variants[0].variant_string_representation.as_deref(),
            Some("provider:test/channel/family[context=200k]")
        );
        assert_eq!(model.variants[0].is_default_non_max_config, Some(true));
    }

    #[test]
    fn provider_picker_fast_toggle_doubles_variants() {
        let model = available_provider_model(&provider_model(
            ModelOptions {
                efforts: vec!["low".into(), "high".into()],
                default_effort: Some("low".into()),
                fast: true,
            },
            Some(200_000),
        ));
        assert_eq!(model.variants.len(), 2 * 2);
        let default = model
            .variants
            .iter()
            .find(|variant| variant.is_default_non_max_config == Some(true))
            .unwrap();
        assert_eq!(
            default.variant_string_representation.as_deref(),
            Some("provider:test/channel/family[context=200k,reasoning=low,fast=false]")
        );
    }

    #[test]
    fn badges_use_short_provider_tags() {
        let mut tagged = model();
        tagged.base_url = "https://api.refuseless.com/v1".into();
        assert_eq!(badge_label(&tagged), "Refuseless");
        tagged.base_url = "https://api.unknown-host.dev/v1".into();
        assert_eq!(badge_label(&tagged), "unknown-host");
        tagged.group_name = Some("Work".into());
        assert_eq!(badge_label(&tagged), "Work");
    }
}
