//! Routes model requests to built-in configurations or stable provider model IDs.
use std::{sync::Arc, time::Duration};

use async_stream::try_stream;
use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;

use crate::{
    config::{ProtocolConfig, ProtocolKind},
    model::{ModelInvocation, ModelLatency, NewLlmCall, ProtocolType},
    provider::{ProviderRegistry, ADAPTER_ID_PREFIX},
    store::Store,
    Error, Result,
};

use super::{
    normalize::NormalizedProtocol, recorder::CancelOnDrop, AnthropicProtocol, CallRecorder,
    OpenAiChatProtocol, OpenAiResponsesProtocol, Protocol, ProtocolStream,
};

pub struct ProtocolRouter {
    store: Store,
    providers: ProviderRegistry,
    clients: crate::network::NetworkClients,
    headroom: crate::headroom::HeadroomRuntime,
    request_timeout: Duration,
    stream_idle_timeout: Duration,
}

impl ProtocolRouter {
    pub fn new(
        store: Store,
        providers: ProviderRegistry,
        clients: crate::network::NetworkClients,
        headroom: crate::headroom::HeadroomRuntime,
        request_timeout: Duration,
        stream_idle_timeout: Duration,
    ) -> Self {
        Self {
            store,
            providers,
            clients,
            headroom,
            request_timeout,
            stream_idle_timeout,
        }
    }
}

impl Protocol for ProtocolRouter {
    fn stream(
        &self,
        invocation: ModelInvocation,
        cancellation: CancellationToken,
    ) -> ProtocolStream {
        let store = self.store.clone();
        let providers = self.providers.clone();
        let clients = self.clients.clone();
        let headroom = self.headroom.clone();
        let request_timeout = self.request_timeout;
        let stream_idle_timeout = self.stream_idle_timeout;
        Box::pin(try_stream! {
            let selected = invocation.request.model.model_id.clone();
            // Both branches only assemble the Recorder and the Protocol stream;
            // event consumption (idle-timeout watchdog, recording, error normalization) is identical for both.
            let (recorder, _cancel_on_drop, mut stream): (CallRecorder, CancelOnDrop, ProtocolStream) =
                if selected.starts_with(ADAPTER_ID_PREFIX) {
                    // Provider models take exactly the same flow as built-in models: resource selection and future
                    // load balancing live inside the provider Protocol adapter.
                    let plan = providers.plan_model(&selected).await?;
                    let recorder = start_recorder(&store, &invocation, &selected, &plan.model.display_name, ProtocolType::Provider, &plan.request_url, &plan.model.model_id).await?;
                    let guard = recorder.cancel_on_drop();
                    let mut routed = invocation.clone();
                    routed.request.model.display_name = Some(plan.model.display_name.clone());
                    if let Some(tokens) = plan.model.max_output_tokens {
                        routed.request.model.max_output_tokens.get_or_insert(tokens);
                    }
                    let protocol: Arc<dyn Protocol> = Arc::new(NormalizedProtocol::new(Arc::new(ProviderModelProtocol {
                        registry: providers.clone(),
                        recorder: recorder.clone(),
                    })));
                    (recorder, guard, protocol.stream(routed, cancellation.clone()))
                } else {
                    let mut routed = invocation.clone();
                    let model = store.model(&selected).await?.ok_or_else(|| Error::Provider(format!("unknown model: {selected}")))?;
                    let protocol_type = model.protocol_type();
                    let request_url = model.request_url()?;
                    model.configure(&mut routed.request.model);
                    routed.request.model.extra_params =
                        super::request_template::render_json_strings(
                            model.extra_params(),
                            &invocation.conversation_id,
                        );
                    routed.request.model.model_id = model.model_id.clone();
                    let recorder = start_recorder(&store, &invocation, &model.model_hash, &model.display_name, protocol_type, &request_url, &model.model_id).await?;
                    let guard = recorder.cancel_on_drop();
                    let config = ProtocolConfig {
                        kind: protocol_kind(protocol_type),
                        request_url,
                        api_key: model.api_key.clone(),
                        custom_headers: if model.custom_headers_enabled {
                            custom_headers(
                                &model.custom_headers,
                                &invocation.conversation_id,
                            )?
                        } else {
                            reqwest::header::HeaderMap::new()
                        },
                        max_output_tokens: model.max_output_tokens(),
                        request_timeout,
                        allowed_body_fields: None,
                        headroom: headroom.route(&invocation.conversation_id).await,
                    };
                    let client = clients.protocol_client(request_timeout).await?;
                    let protocol = build_observed(&config, recorder.clone(), client)?;
                    (recorder, guard, protocol.stream(routed, cancellation.clone()))
                };

            let stream_started = std::time::Instant::now();
            tracing::debug!(
                model = %selected,
                request_timeout_ms = request_timeout.as_millis() as u64,
                stream_idle_timeout_ms = stream_idle_timeout.as_millis() as u64,
                "protocol stream created"
            );
            let mut last_event_time = std::time::Instant::now();
            let mut event_count: u64 = 0;
            loop {
                let event = match next_protocol_event(&mut stream, stream_idle_timeout).await {
                    Ok(Some(event)) => event,
                    Ok(None) => break,
                    Err(_) => {
                        let elapsed_ms = stream_started.elapsed().as_millis() as u64;
                        let error = stream_idle_timeout_error(stream_idle_timeout);
                        tracing::warn!(
                            error = %error,
                            elapsed_ms,
                            event_count,
                            idle_timeout_ms = stream_idle_timeout.as_millis() as u64,
                            "protocol stream idle timeout"
                        );
                        Err(error)
                    }
                };
                let now = std::time::Instant::now();
                let gap_ms = now.duration_since(last_event_time).as_millis() as u64;
                let elapsed_ms = now.duration_since(stream_started).as_millis() as u64;
                event_count += 1;
                match event {
                    Ok(event) => {
                        if gap_ms > 5000 {
                            tracing::debug!(
                                gap_ms,
                                elapsed_ms,
                                event = event_name(&event),
                                event_count,
                                "slow gap detected between provider events"
                            );
                        }
                        recorder.event(&event).await?;
                        last_event_time = now;
                        yield event;
                    }
                    Err(error) => {
                        let error = normalize_protocol_stream_error(error, request_timeout);
                        tracing::debug!(
                            error = %error,
                            elapsed_ms,
                            gap_ms,
                            event_count,
                            "protocol stream error"
                        );
                        recorder.failed(&error).await?;
                        Err(error)?;
                    }
                }
            }
            finish_stream(&recorder, &cancellation).await?;
        })
    }
}

fn event_name(event: &super::ModelEvent) -> &'static str {
    match event {
        super::ModelEvent::Start { .. } => "Start",
        super::ModelEvent::TextStart => "TextStart",
        super::ModelEvent::TextDelta(_) => "TextDelta",
        super::ModelEvent::TextEnd => "TextEnd",
        super::ModelEvent::ThinkingStart => "ThinkingStart",
        super::ModelEvent::ThinkingDelta(_) => "ThinkingDelta",
        super::ModelEvent::ThinkingEnd => "ThinkingEnd",
        super::ModelEvent::ToolCallStart { .. } => "ToolCallStart",
        super::ModelEvent::ToolCallArgumentsDelta { .. } => "ToolCallArgsDelta",
        super::ModelEvent::ToolCallEnd { .. } => "ToolCallEnd",
        super::ModelEvent::ProtocolReplayState(_) => "ReplayState",
        super::ModelEvent::Usage(_) => "Usage",
        super::ModelEvent::Done(_) => "Done",
    }
}

async fn start_recorder(
    store: &Store,
    invocation: &ModelInvocation,
    model_hash: &str,
    display_name: &str,
    protocol_type: ProtocolType,
    request_url: &str,
    model_id: &str,
) -> Result<CallRecorder> {
    CallRecorder::start(
        store.clone(),
        NewLlmCall {
            call_id: invocation.call_id.clone(),
            run_id: invocation.run_id.clone(),
            conversation_id: invocation.conversation_id.clone(),
            provider_call_index: invocation.provider_call_index.min(i64::MAX as u64) as i64,
            model_hash: model_hash.into(),
            protocol_type,
            endpoint_url: request_url.into(),
            model_id: model_id.into(),
            display_name: display_name.into(),
            reasoning_effort: invocation.request.model.reasoning.effort.clone(),
            fast: invocation.request.model.latency == ModelLatency::Fast,
            message_count: invocation.request.history.len(),
            tool_count: invocation.request.prompt.tools.len(),
            detailed: false,
        },
    )
    .await
}

async fn finish_stream(recorder: &CallRecorder, cancellation: &CancellationToken) -> Result<()> {
    if recorder.is_finished() {
        return Ok(());
    }
    if cancellation.is_cancelled() {
        recorder.cancelled().await
    } else {
        let error = Error::Provider("protocol stream ended without Done".into());
        recorder.failed(&error).await?;
        Err(error)
    }
}

/// Protocol implementation for provider models; indistinguishable from a built-in Protocol at the routing and normalization layer.
struct ProviderModelProtocol {
    registry: ProviderRegistry,
    recorder: CallRecorder,
}

impl Protocol for ProviderModelProtocol {
    fn stream(
        &self,
        invocation: ModelInvocation,
        cancellation: CancellationToken,
    ) -> ProtocolStream {
        self.registry
            .stream_model(invocation, cancellation, self.recorder.clone())
    }
}

fn protocol_kind(protocol_type: ProtocolType) -> ProtocolKind {
    match protocol_type {
        ProtocolType::OpenAiChat => ProtocolKind::OpenAiChat,
        ProtocolType::OpenAiResponses => ProtocolKind::OpenAiResponses,
        ProtocolType::Anthropic => ProtocolKind::Anthropic,
        // A built-in model's protocol_type only comes from ModelType and can never be a provider.
        ProtocolType::Provider => {
            unreachable!("provider models never use built-in protocol configs")
        }
    }
}

async fn next_protocol_event(
    stream: &mut ProtocolStream,
    idle_timeout: Duration,
) -> std::result::Result<Option<Result<super::ModelEvent>>, tokio::time::error::Elapsed> {
    tokio::time::timeout(idle_timeout, stream.next()).await
}

fn stream_idle_timeout_error(idle_timeout: Duration) -> Error {
    Error::Provider(format!(
        "protocol stream idle timeout: no events received for {} seconds ({} minutes)",
        idle_timeout.as_secs(),
        idle_timeout.as_secs() / 60
    ))
}

fn request_timeout_error(request_timeout: Duration) -> Error {
    Error::Provider(format!(
        "protocol request timed out after {} seconds ({} minutes)",
        request_timeout.as_secs(),
        request_timeout.as_secs() / 60
    ))
}

fn normalize_protocol_stream_error(error: Error, request_timeout: Duration) -> Error {
    match error {
        Error::Http(source) if source.is_timeout() => request_timeout_error(request_timeout),
        Error::Http(source) if source.is_body() => Error::Provider(format!(
            "protocol stream transport failed while reading the response body: {}",
            root_error_message(&source)
        )),
        error => error,
    }
}

fn root_error_message(error: &(dyn std::error::Error + 'static)) -> String {
    let mut current = error;
    while let Some(source) = current.source() {
        current = source;
    }
    current.to_string()
}

pub(crate) fn custom_headers(
    value: &serde_json::Value,
    conversation_id: &str,
) -> Result<reqwest::header::HeaderMap> {
    let rendered = super::request_template::render_json_strings(value, conversation_id);
    let object = rendered
        .as_object()
        .ok_or_else(|| Error::Config("custom headers must be an object".into()))?;
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in object {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| Error::Config(format!("invalid custom header name: {error}")))?;
        let value = value
            .as_str()
            .ok_or_else(|| Error::Config("custom header values must be strings".into()))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|error| Error::Config(format!("invalid custom header value: {error}")))?;
        headers.insert(name, value);
    }
    Ok(headers)
}

pub fn build(config: &ProtocolConfig) -> Result<Arc<dyn Protocol>> {
    build_inner(config, None, None)
}

fn build_observed(
    config: &ProtocolConfig,
    recorder: CallRecorder,
    client: reqwest::Client,
) -> Result<Arc<dyn Protocol>> {
    build_inner(config, Some(recorder), Some(client))
}

fn build_inner(
    config: &ProtocolConfig,
    recorder: Option<CallRecorder>,
    client: Option<reqwest::Client>,
) -> Result<Arc<dyn Protocol>> {
    let client = match client {
        Some(client) => client,
        None => reqwest::Client::builder()
            .timeout(config.request_timeout)
            .build()?,
    };
    let protocol: Arc<dyn Protocol> = match config.kind {
        ProtocolKind::OpenAiChat => {
            Arc::new(OpenAiChatProtocol::new(client, config.clone()).with_recorder(recorder))
        }
        ProtocolKind::OpenAiResponses => {
            Arc::new(OpenAiResponsesProtocol::new(client, config.clone()).with_recorder(recorder))
        }
        ProtocolKind::Anthropic => {
            Arc::new(AnthropicProtocol::new(client, config.clone()).with_recorder(recorder))
        }
    };
    Ok(Arc::new(NormalizedProtocol::new(protocol)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_cursor_conversation_id_in_custom_header_values() {
        let template = serde_json::json!({
            "x-opencode-session-id": "{{SessionId}}",
            "x-label": "cursor/{{SessionId}}"
        });

        let headers = custom_headers(&template, "cursor-conversation-id").unwrap();

        assert_eq!(
            headers.get("x-opencode-session-id").unwrap(),
            "cursor-conversation-id"
        );
        assert_eq!(
            headers.get("x-label").unwrap(),
            "cursor/cursor-conversation-id"
        );
        assert_eq!(template["x-opencode-session-id"], "{{SessionId}}");
    }

    #[tokio::test]
    async fn pending_protocol_event_hits_the_idle_timeout() {
        let mut stream: ProtocolStream = Box::pin(futures_util::stream::pending());

        let result = next_protocol_event(&mut stream, Duration::from_millis(1)).await;

        assert!(result.is_err());
    }

    #[test]
    fn timeout_errors_state_the_boundary_and_duration() {
        let Error::Provider(idle) = stream_idle_timeout_error(Duration::from_secs(30 * 60)) else {
            panic!("idle timeout must be a provider error");
        };
        assert_eq!(
            idle,
            "protocol stream idle timeout: no events received for 1800 seconds (30 minutes)"
        );

        let Error::Provider(request) = request_timeout_error(Duration::from_secs(60 * 60)) else {
            panic!("request timeout must be a provider error");
        };
        assert_eq!(
            request,
            "protocol request timed out after 3600 seconds (60 minutes)"
        );
    }
}
