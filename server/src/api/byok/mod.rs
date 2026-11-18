//! External OpenAI and Anthropic compatible API.
mod direct;
mod models;
mod output;
mod protocol;
mod refusal;

use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    model::ModelInvocation, protocol::Protocol, provider::ProviderRegistry, store::Store, Error,
    Result,
};

use self::protocol::ApiProtocol;
pub use direct::NativeForwarder;
pub(crate) use models::{
    configured_provider_name, list as public_models, provider_tag, ListedModel as PublicModel,
};

#[derive(Clone)]
struct ApiState {
    store: Store,
    providers: ProviderRegistry,
    protocol: Arc<dyn Protocol>,
    native: Option<NativeForwarder>,
}

pub fn router(
    store: Store,
    providers: ProviderRegistry,
    protocol: Arc<dyn Protocol>,
    native: Option<NativeForwarder>,
) -> Router {
    Router::new()
        .route("/byok/v1/models", get(list_models))
        .route("/byok/v1/chat/completions", post(chat))
        .route("/byok/v1/responses", post(responses))
        .route("/byok/v1/messages", post(messages))
        // Million-token inputs can exceed Axum's default 2 MiB JSON limit.
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(ApiState {
            store,
            providers,
            protocol,
            native,
        })
}

fn api_error(status: StatusCode, message: impl std::fmt::Display) -> Response {
    (status, Json(json!({"error":{"message":message.to_string(),"type":if status.is_client_error() { "invalid_request_error" } else { "server_error" }}}))).into_response()
}

async fn authorized(
    state: &ApiState,
    headers: &HeaderMap,
) -> std::result::Result<(), Box<Response>> {
    let settings = state
        .store
        .external_api_settings()
        .await
        .map_err(|error| Box::new(api_error(StatusCode::INTERNAL_SERVER_ERROR, error)))?;
    if !settings.enabled {
        return Err(Box::new(api_error(
            StatusCode::FORBIDDEN,
            "external API is disabled",
        )));
    }
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            headers
                .get("x-api-key")
                .and_then(|value| value.to_str().ok())
        })
        .unwrap_or_default();
    if supplied.is_empty() || !constant_time_eq(supplied.as_bytes(), settings.api_key.as_bytes()) {
        return Err(Box::new(api_error(
            StatusCode::UNAUTHORIZED,
            "invalid API key",
        )));
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let difference = left
        .iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        });
    difference == 0
}

async fn list_models(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if let Err(error) = authorized(&state, &headers).await {
        return *error;
    }
    match models::list(&state.store, &state.providers).await {
        Ok(models) => Json(models::response(&models)).into_response(),
        Err(error) => api_error(StatusCode::CONFLICT, error),
    }
}

async fn chat(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    generate(state, headers, body, ApiProtocol::Chat).await
}

async fn responses(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    generate(state, headers, body, ApiProtocol::Responses).await
}

async fn messages(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    generate(state, headers, body, ApiProtocol::Messages).await
}

async fn generate(
    state: ApiState,
    headers: HeaderMap,
    body: Value,
    protocol: ApiProtocol,
) -> Response {
    if let Err(error) = authorized(&state, &headers).await {
        return *error;
    }
    let Some(public_model_id) = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return api_error(StatusCode::BAD_REQUEST, "model is required");
    };
    let models = match models::list(&state.store, &state.providers).await {
        Ok(models) => models,
        Err(error) => return api_error(StatusCode::CONFLICT, error),
    };
    let Some(model) = models
        .iter()
        .find(|model| model.public_id == public_model_id)
    else {
        return api_error(StatusCode::NOT_FOUND, "model not found");
    };
    let fallback = match state.store.refusal_fallback_map().await {
        Ok(fallbacks) => fallbacks.get(&model.internal_id).cloned(),
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    if let Some(native) = &state.native {
        match state.store.model(&model.internal_id).await {
            Ok(Some(config)) if protocol.protocol_type() == config.protocol_type() => {
                return match native
                    .forward(protocol, &headers, body.clone(), &config)
                    .await
                {
                    Ok(response) => match fallback {
                        Some(model_id) if response.status().is_success() => {
                            let retry = refusal::Fallback::new(state, protocol, body, model_id);
                            match retry.inspect_native(response).await {
                                Ok(response) => response,
                                Err(error) => api_error(StatusCode::BAD_GATEWAY, error),
                            }
                        }
                        _ => response,
                    },
                    Err(error) => api_error(StatusCode::BAD_GATEWAY, error),
                };
            }
            Ok(_) => {}
            Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, error),
        }
    }
    let mut parsed = match protocol::parse(protocol, &body) {
        Ok(parsed) => parsed,
        Err(error) => return api_error(StatusCode::BAD_REQUEST, error),
    };
    parsed.request.model.model_id = model.internal_id.clone();
    match respond(&state, parsed, protocol, fallback).await {
        Ok(response) => response,
        Err(Error::Protocol(message)) => api_error(StatusCode::BAD_REQUEST, message),
        Err(error) => api_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn respond(
    state: &ApiState,
    parsed: protocol::ParsedRequest,
    protocol: ApiProtocol,
    fallback: Option<String>,
) -> Result<Response> {
    let id = format!("external-api:{}", uuid::Uuid::new_v4());
    let invocation = ModelInvocation {
        call_id: id.clone(),
        run_id: id.clone(),
        conversation_id: id.clone(),
        provider_call_index: 0,
        request: parsed.request,
    };
    let cancellation = CancellationToken::new();
    let stream = refusal::stream(
        state.protocol.clone(),
        invocation,
        cancellation.clone(),
        fallback,
    );
    if parsed.stream {
        Ok(output::streamed(
            protocol,
            stream,
            cancellation,
            id,
            parsed.public_model_id,
            parsed.namespaced_tools,
        ))
    } else {
        output::complete(
            protocol,
            stream,
            &id,
            &parsed.public_model_id,
            parsed.namespaced_tools,
        )
        .await
        .map(IntoResponse::into_response)
    }
}
