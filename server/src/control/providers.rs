//! Exposes provider discovery, resource lifecycle, model sync, and runtime endpoints.
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    provider::{
        ImportResponse, OAuthBeginResponse, OAuthPollResponse, ProviderDescriptor,
        ProviderRuntimeStatus,
    },
    Result,
};

use super::ControlService;

pub async fn list(State(service): State<ControlService>) -> Result<Json<Vec<ProviderDescriptor>>> {
    Ok(Json(service.providers().await))
}

pub async fn remove(
    State(service): State<ControlService>,
    Path(provider_id): Path<String>,
) -> Result<StatusCode> {
    service.remove_provider_configuration(&provider_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn oauth_begin(
    State(service): State<ControlService>,
    Path((provider_id, resource_type, method_id)): Path<(String, String, String)>,
) -> Result<Json<OAuthBeginResponse>> {
    Ok(Json(
        service
            .provider_oauth_begin(&provider_id, &resource_type, &method_id)
            .await?,
    ))
}

pub async fn oauth_poll(
    State(service): State<ControlService>,
    Path(session_id): Path<String>,
) -> Result<Json<OAuthPollResponse>> {
    Ok(Json(service.provider_oauth_poll(&session_id).await?))
}

pub async fn import(
    State(service): State<ControlService>,
    Path((provider_id, resource_type)): Path<(String, String)>,
    Json(files): Json<serde_json::Value>,
) -> Result<Json<ImportResponse>> {
    Ok(Json(
        service
            .provider_import(&provider_id, &resource_type, files)
            .await?,
    ))
}

/// Returns the account resource export as an attachment so browsers download it directly.
pub async fn export_resources(
    State(service): State<ControlService>,
    Path((provider_id, resource_type)): Path<(String, String)>,
) -> Result<axum::response::Response> {
    let value = service
        .provider_export_resources(&provider_id, &resource_type)
        .await?;
    let body = serde_json::to_vec_pretty(&value)?;
    let response = axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{provider_id}-{resource_type}.json\""),
        )
        .body(axum::body::Body::from(body))
        .expect("static export response");
    Ok(response)
}

pub async fn refresh_resource(
    State(service): State<ControlService>,
    Path((provider_id, resource_type, resource_id)): Path<(String, String, String)>,
) -> Result<StatusCode> {
    service
        .provider_refresh_resource(&provider_id, &resource_type, &resource_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn action(
    State(service): State<ControlService>,
    Path((provider_id, resource_type, resource_id, action_id)): Path<(
        String,
        String,
        String,
        String,
    )>,
    Json(input): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    Ok(Json(
        service
            .provider_resource_action(
                &provider_id,
                &resource_type,
                &resource_id,
                &action_id,
                input,
            )
            .await?,
    ))
}

pub async fn delete_resource(
    State(service): State<ControlService>,
    Path((provider_id, resource_type, resource_id)): Path<(String, String, String)>,
) -> Result<StatusCode> {
    service
        .provider_delete_resource(&provider_id, &resource_type, &resource_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn sync_models(
    State(service): State<ControlService>,
    Path((provider_id, channel_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    let count = service
        .provider_sync_models(&provider_id, &channel_id)
        .await?;
    Ok(Json(serde_json::json!({ "models": count })))
}

pub async fn set_model_enabled(
    State(service): State<ControlService>,
    Path((provider_id, channel_id)): Path<(String, String)>,
    Json(input): Json<serde_json::Value>,
) -> Result<StatusCode> {
    let model_id = input
        .get("modelId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| crate::Error::Config("modelId must be a string".into()))?;
    let enabled = input
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| crate::Error::Config("enabled must be a boolean".into()))?;
    service
        .provider_set_model_enabled(&provider_id, &channel_id, model_id, enabled)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn runtime_status(
    State(service): State<ControlService>,
) -> Result<Json<ProviderRuntimeStatus>> {
    Ok(Json(service.provider_runtime_status()))
}

pub async fn initialize_runtime(
    State(service): State<ControlService>,
) -> Result<Json<ProviderRuntimeStatus>> {
    Ok(Json(service.initialize_provider_runtime()))
}

pub async fn cancel_runtime_initialization(
    State(service): State<ControlService>,
) -> Result<Json<ProviderRuntimeStatus>> {
    Ok(Json(service.cancel_provider_runtime_initialization()))
}
