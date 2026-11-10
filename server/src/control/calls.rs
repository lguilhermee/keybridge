//! Implements provider call inspection endpoints.
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;

use crate::{store::LlmCallFilter, Result};

use super::{CallDetail, CallPage, ControlService};

/// `/api/llm-calls` query: filters, then `offset`/`limit` paging over the merged
/// provider-call and official-trace stream.
#[derive(Deserialize)]
pub struct CallQuery {
    /// `running`, `completed` (alias `success`), `error` (alias `failed`), `cancelled`.
    status: Option<String>,
    /// Stored `model_hash` or upstream `model_id`.
    model: Option<String>,
    /// Case-insensitive substring over model/display/conversation/call/endpoint/error fields.
    q: Option<String>,
    #[serde(default)]
    offset: i64,
    #[serde(default = "default_limit")]
    limit: i64,
}

pub async fn list(
    State(service): State<ControlService>,
    Query(query): Query<CallQuery>,
) -> Result<Json<CallPage>> {
    let filter = LlmCallFilter {
        status: query.status.map(|status| normalize_status(&status)),
        model: query.model.filter(|model| !model.trim().is_empty()),
        q: query
            .q
            .map(|q| q.trim().to_owned())
            .filter(|q| !q.is_empty()),
    };
    Ok(Json(
        service.calls(&filter, query.offset, query.limit).await?,
    ))
}

pub async fn detail(
    State(service): State<ControlService>,
    Path(call_id): Path<String>,
) -> Result<Json<CallDetail>> {
    Ok(Json(service.call(&call_id).await?))
}

/// Maps the UI's success/failed vocabulary onto the stored status values.
fn normalize_status(status: &str) -> String {
    match status.trim() {
        "success" => "completed".to_owned(),
        "failed" => "error".to_owned(),
        status => status.to_owned(),
    }
}

fn default_limit() -> i64 {
    100
}
