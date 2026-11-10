//! Implements local application control endpoints.
use axum::{extract::State, Json};

use crate::{
    local_app::{CodexHarnessStatus, CursorHarnessStatus, SetEnabled},
    Result,
};

use super::ControlService;

pub async fn codex_status(
    State(service): State<ControlService>,
) -> Result<Json<CodexHarnessStatus>> {
    Ok(Json(service.codex_harness().status().await?))
}

pub async fn set_codex_enabled(
    State(service): State<ControlService>,
    Json(input): Json<SetEnabled>,
) -> Result<Json<CodexHarnessStatus>> {
    Ok(Json(
        service.codex_harness().set_enabled(input.enabled).await?,
    ))
}

pub async fn status(State(service): State<ControlService>) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.cursor_harness().status().await?))
}

pub async fn initialize_ca(
    State(service): State<ControlService>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(service.cursor_harness().initialize_ca().await?))
}

pub async fn set_enabled(
    State(service): State<ControlService>,
    Json(input): Json<SetEnabled>,
) -> Result<Json<CursorHarnessStatus>> {
    Ok(Json(
        service.cursor_harness().set_enabled(input.enabled).await?,
    ))
}
