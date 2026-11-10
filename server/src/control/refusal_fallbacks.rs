//! Implements refusal fallback configuration endpoints.
use axum::{extract::State, Json};

use crate::{
    model::{RefusalFallback, RefusalFallbacksInput},
    Result,
};

use super::ControlService;

pub async fn list(State(service): State<ControlService>) -> Result<Json<Vec<RefusalFallback>>> {
    Ok(Json(service.refusal_fallbacks().await?))
}

pub async fn set(
    State(service): State<ControlService>,
    Json(input): Json<RefusalFallbacksInput>,
) -> Result<Json<Vec<RefusalFallback>>> {
    Ok(Json(service.set_refusal_fallbacks(&input.fallbacks).await?))
}
