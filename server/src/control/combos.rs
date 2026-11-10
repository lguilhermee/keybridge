//! Implements combo configuration endpoints.
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    model::{ComboConfig, ComboInput},
    Result,
};

use super::ControlService;

pub async fn list(State(service): State<ControlService>) -> Result<Json<Vec<ComboConfig>>> {
    Ok(Json(service.combos().await?))
}

pub async fn create(
    State(service): State<ControlService>,
    Json(input): Json<ComboInput>,
) -> Result<(StatusCode, Json<ComboConfig>)> {
    Ok((
        StatusCode::CREATED,
        Json(service.create_combo(&input).await?),
    ))
}

pub async fn update(
    State(service): State<ControlService>,
    Path(combo_id): Path<String>,
    Json(input): Json<ComboInput>,
) -> Result<Json<ComboConfig>> {
    Ok(Json(service.update_combo(&combo_id, &input).await?))
}

pub async fn remove(
    State(service): State<ControlService>,
    Path(combo_id): Path<String>,
) -> Result<StatusCode> {
    service.delete_combo(&combo_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
