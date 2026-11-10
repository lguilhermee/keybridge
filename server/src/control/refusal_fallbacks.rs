//! Implements refusal fallback configuration endpoints.
use axum::{extract::State, http::StatusCode, Json};

use crate::{
    model::{RefusalFallback, RefusalFallbackInput},
    Result,
};

use super::ControlService;

pub async fn list(State(service): State<ControlService>) -> Result<Json<Vec<RefusalFallback>>> {
    Ok(Json(service.refusal_fallbacks().await?))
}

pub async fn set(
    State(service): State<ControlService>,
    Json(input): Json<RefusalFallbackInput>,
) -> Result<StatusCode> {
    service.set_refusal_fallback(&input).await?;
    Ok(StatusCode::NO_CONTENT)
}
