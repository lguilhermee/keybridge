//! Persists provider call payloads, timing, and usage.
use sqlx::Row;

use crate::{
    model::{LlmCallRequest, LlmCallResponseChunk, LlmCallSummary, NewLlmCall, Usage},
    Result,
};

use super::{now_ms, Store};

/// Server-side filters for the call history list. All fields are optional;
/// absent filters match every row.
#[derive(Clone, Debug, Default)]
pub struct LlmCallFilter {
    /// Exact status match (`running`, `completed`, `error`, `cancelled`).
    pub(crate) status: Option<String>,
    /// Matches either the stored `model_hash` or the upstream `model_id`.
    pub(crate) model: Option<String>,
    /// Case-insensitive substring over the identity/display columns and the error text.
    pub(crate) q: Option<String>,
}

/// Escapes LIKE metacharacters and wraps the needle for a contains-match.
pub(crate) fn like_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ContextUsageAnchor {
    pub(crate) context_input_tokens: u64,
    pub(crate) message_count: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct BufferedLlmChunk {
    pub(crate) seq: i64,
    pub(crate) elapsed_ms: i64,
    pub(crate) data: Option<Vec<u8>>,
    pub(crate) byte_count: usize,
}

impl BufferedLlmChunk {
    pub(crate) fn new(seq: i64, elapsed_ms: i64, data: &[u8]) -> Self {
        Self {
            seq,
            elapsed_ms,
            data: Some(data.to_vec()),
            byte_count: data.len(),
        }
    }

    pub(crate) fn metrics(seq: i64, elapsed_ms: i64, byte_count: usize) -> Self {
        Self {
            seq,
            elapsed_ms,
            data: None,
            byte_count,
        }
    }
}

impl Store {
    pub async fn detailed_logging(&self) -> Result<bool> {
        let value: String = sqlx::query_scalar(
            "SELECT value_json FROM service_settings WHERE setting_key = 'llm_detailed_logging'",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(serde_json::from_str(&value)?)
    }

    pub async fn set_detailed_logging(&self, enabled: bool) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES ('llm_detailed_logging', ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(serde_json::to_string(&enabled)?)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn start_llm_call(&self, call: &NewLlmCall) -> Result<()> {
        let _write = self.writes.lock().await;
        let now = now_ms();
        sqlx::query(
            r#"INSERT INTO llm_calls(
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                protocol_type, endpoint_url, model_id, display_name,
                reasoning_effort, fast, status,
                created_at_ms, request_started_at_ms, queue_ms, message_count, tool_count, detailed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, 0, ?, ?, ?)"#,
        )
        .bind(&call.call_id)
        .bind(&call.run_id)
        .bind(&call.conversation_id)
        .bind(call.provider_call_index)
        .bind(&call.model_hash)
        .bind(call.protocol_type.as_str())
        .bind(&call.endpoint_url)
        .bind(&call.model_id)
        .bind(&call.display_name)
        .bind(&call.reasoning_effort)
        .bind(call.fast)
        .bind(now)
        .bind(now)
        .bind(call.message_count as i64)
        .bind(call.tool_count as i64)
        .bind(call.detailed)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_llm_request(
        &self,
        call_id: &str,
        headers: &serde_json::Value,
        body: &serde_json::Value,
        detailed: bool,
    ) -> Result<()> {
        let body_json = serde_json::to_string(body)?;
        let headers_json = detailed
            .then(|| serde_json::to_string(headers))
            .transpose()?;
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if detailed {
            sqlx::query("INSERT INTO llm_call_requests(call_id, headers_json, body_json, byte_count) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM llm_calls WHERE call_id = ?)")
                .bind(call_id)
                .bind(headers_json)
                .bind(&body_json)
                .bind(body_json.len() as i64)
                .bind(call_id)
                .execute(&mut *transaction)
                .await?;
        }
        sqlx::query("UPDATE llm_calls SET request_bytes = ? WHERE call_id = ?")
            .bind(body_json.len() as i64)
            .bind(call_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn record_llm_response_headers(
        &self,
        call_id: &str,
        elapsed_ms: i64,
        http_status: u16,
    ) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("UPDATE llm_calls SET response_headers_at_ms = ?, ttfb_ms = ?, http_status = ? WHERE call_id = ?")
            .bind(now_ms())
            .bind(elapsed_ms)
            .bind(http_status as i64)
            .bind(call_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn record_llm_chunk(
        &self,
        call_id: &str,
        seq: i64,
        elapsed_ms: i64,
        data: &[u8],
        detailed: bool,
    ) -> Result<()> {
        let chunk = if detailed {
            BufferedLlmChunk::new(seq, elapsed_ms, data)
        } else {
            BufferedLlmChunk::metrics(seq, elapsed_ms, data.len())
        };
        self.record_llm_chunks(call_id, &[chunk], detailed, None)
            .await
    }

    /// Records a batch of response chunks and, when given, the running estimate
    /// of generated output tokens (recomputed from streamed deltas, so callers
    /// pass the absolute value rather than an increment).
    pub(crate) async fn record_llm_chunks(
        &self,
        call_id: &str,
        chunks: &[BufferedLlmChunk],
        detailed: bool,
        estimated_output_tokens: Option<i64>,
    ) -> Result<()> {
        if chunks.is_empty() && estimated_output_tokens.is_none() {
            return Ok(());
        }
        let byte_count = chunks
            .iter()
            .map(|chunk| chunk.byte_count as i64)
            .sum::<i64>();
        let event_count = chunks.len() as i64;
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if detailed {
            for chunk in chunks {
                let data = chunk.data.as_deref().ok_or_else(|| {
                    crate::Error::Store("detailed LLM chunk is missing payload data".into())
                })?;
                sqlx::query("INSERT INTO llm_call_response_chunks(call_id, seq, received_offset_ms, data, byte_count) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM llm_calls WHERE call_id = ?)")
                    .bind(call_id)
                    .bind(chunk.seq)
                    .bind(chunk.elapsed_ms)
                    .bind(data)
                    .bind(chunk.byte_count as i64)
                    .bind(call_id)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
        if chunks.is_empty() {
            sqlx::query("UPDATE llm_calls SET estimated_output_tokens = ? WHERE call_id = ?")
                .bind(estimated_output_tokens)
                .bind(call_id)
                .execute(&mut *transaction)
                .await?;
        } else {
            sqlx::query("UPDATE llm_calls SET first_event_at_ms = COALESCE(first_event_at_ms, ?), response_bytes = response_bytes + ?, stream_event_count = stream_event_count + ?, estimated_output_tokens = COALESCE(?, estimated_output_tokens) WHERE call_id = ?")
                .bind(now_ms())
                .bind(byte_count)
                .bind(event_count)
                .bind(estimated_output_tokens)
                .bind(call_id)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn record_llm_first_valid_response(
        &self,
        call_id: &str,
        elapsed_ms: i64,
    ) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("UPDATE llm_calls SET first_valid_response_at_ms = COALESCE(first_valid_response_at_ms, ?), ttfr_ms = COALESCE(ttfr_ms, ?) WHERE call_id = ?")
            .bind(now_ms())
            .bind(elapsed_ms)
            .bind(call_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn record_llm_first_text(&self, call_id: &str, elapsed_ms: i64) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("UPDATE llm_calls SET first_text_at_ms = COALESCE(first_text_at_ms, ?), ttft_ms = COALESCE(ttft_ms, ?) WHERE call_id = ?")
            .bind(now_ms())
            .bind(elapsed_ms)
            .bind(call_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn record_llm_usage(&self, call_id: &str, usage: Usage) -> Result<()> {
        let usage_json = serde_json::to_string(&usage)?;
        let _write = self.writes.lock().await;
        sqlx::query("UPDATE llm_calls SET input_tokens = ?, output_tokens = ?, total_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?, usage_json = ? WHERE call_id = ?")
            .bind(as_i64(usage.input_tokens))
            .bind(as_i64(usage.output_tokens))
            .bind(as_i64(usage.total_tokens))
            .bind(as_i64(usage.cache_read_tokens))
            .bind(as_i64(usage.cache_write_tokens))
            .bind(as_i64(usage.reasoning_tokens))
            .bind(usage_json)
            .bind(call_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn finish_llm_call(
        &self,
        call_id: &str,
        status: &str,
        finish_reason: Option<&str>,
        elapsed_ms: i64,
        error_kind: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("UPDATE llm_calls SET status = ?, finish_reason = ?, finished_at_ms = ?, duration_ms = ?, error_kind = ?, error_message = ? WHERE call_id = ? AND status = 'running'")
            .bind(status)
            .bind(finish_reason)
            .bind(now_ms())
            .bind(elapsed_ms)
            .bind(error_kind)
            .bind(error_message)
            .bind(call_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub(crate) async fn latest_context_usage(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ContextUsageAnchor>> {
        let row = sqlx::query(
            "SELECT usage_json, message_count FROM llm_calls
             WHERE conversation_id = ?
               AND json_extract(usage_json, '$.context_input_tokens') IS NOT NULL
             ORDER BY created_at_ms DESC, rowid DESC
             LIMIT 1",
        )
        .bind(conversation_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let usage: Usage = serde_json::from_str(row.try_get("usage_json")?)?;
        let Some(context_input_tokens) = usage.context_input_tokens else {
            return Ok(None);
        };
        let message_count = row.try_get::<i64, _>("message_count")?;
        let Ok(message_count) = usize::try_from(message_count) else {
            return Ok(None);
        };
        Ok(Some(ContextUsageAnchor {
            context_input_tokens,
            message_count,
        }))
    }

    /// Filtered, paginated call history plus the total number of matching rows.
    pub async fn llm_calls_page(
        &self,
        filter: &LlmCallFilter,
        offset: i64,
        limit: i64,
    ) -> Result<(Vec<LlmCallSummary>, i64)> {
        let like = filter.q.as_deref().map(like_pattern);
        let rows = sqlx::query(
            "SELECT * FROM llm_calls
             WHERE (? IS NULL OR status = ?)
               AND (? IS NULL OR model_hash = ? OR model_id = ?)
               AND (? IS NULL OR model_id LIKE ? ESCAPE '\\'
                    OR display_name LIKE ? ESCAPE '\\'
                    OR conversation_id LIKE ? ESCAPE '\\'
                    OR call_id LIKE ? ESCAPE '\\'
                    OR endpoint_url LIKE ? ESCAPE '\\'
                    OR error_message LIKE ? ESCAPE '\\')
             ORDER BY created_at_ms DESC
             LIMIT ? OFFSET ?",
        )
        .bind(&filter.status)
        .bind(&filter.status)
        .bind(&filter.model)
        .bind(&filter.model)
        .bind(&filter.model)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(limit.max(1))
        .bind(offset.max(0))
        .fetch_all(&self.pool)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM llm_calls
             WHERE (? IS NULL OR status = ?)
               AND (? IS NULL OR model_hash = ? OR model_id = ?)
               AND (? IS NULL OR model_id LIKE ? ESCAPE '\\'
                    OR display_name LIKE ? ESCAPE '\\'
                    OR conversation_id LIKE ? ESCAPE '\\'
                    OR call_id LIKE ? ESCAPE '\\'
                    OR endpoint_url LIKE ? ESCAPE '\\'
                    OR error_message LIKE ? ESCAPE '\\')",
        )
        .bind(&filter.status)
        .bind(&filter.status)
        .bind(&filter.model)
        .bind(&filter.model)
        .bind(&filter.model)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .fetch_one(&self.pool)
        .await?;
        Ok((
            rows.into_iter()
                .map(summary_from_row)
                .collect::<Result<Vec<_>>>()?,
            total,
        ))
    }

    pub async fn llm_call(&self, call_id: &str) -> Result<Option<LlmCallSummary>> {
        sqlx::query("SELECT * FROM llm_calls WHERE call_id = ?")
            .bind(call_id)
            .fetch_optional(&self.pool)
            .await?
            .map(summary_from_row)
            .transpose()
    }

    pub async fn llm_call_request(&self, call_id: &str) -> Result<Option<LlmCallRequest>> {
        let row = sqlx::query(
            "SELECT headers_json, body_json, byte_count FROM llm_call_requests WHERE call_id = ?",
        )
        .bind(call_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(LlmCallRequest {
                headers: serde_json::from_str(row.try_get("headers_json")?)?,
                body: serde_json::from_str(row.try_get("body_json")?)?,
                byte_count: row.try_get("byte_count")?,
            })
        })
        .transpose()
    }

    pub async fn llm_call_chunks(&self, call_id: &str) -> Result<Vec<LlmCallResponseChunk>> {
        let rows = sqlx::query("SELECT seq, received_offset_ms, data, byte_count FROM llm_call_response_chunks WHERE call_id = ? ORDER BY seq")
            .bind(call_id)
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| {
                Ok(LlmCallResponseChunk {
                    seq: row.try_get("seq")?,
                    received_offset_ms: row.try_get("received_offset_ms")?,
                    data: String::from_utf8_lossy(&row.try_get::<Vec<u8>, _>("data")?).into_owned(),
                    byte_count: row.try_get("byte_count")?,
                })
            })
            .collect()
    }
}

fn as_i64(value: Option<u64>) -> Option<i64> {
    value.map(|value| value.min(i64::MAX as u64) as i64)
}

fn summary_from_row(row: sqlx::sqlite::SqliteRow) -> Result<LlmCallSummary> {
    let usage = row.try_get::<Option<String>, _>("usage_json")?;
    Ok(LlmCallSummary {
        call_id: row.try_get("call_id")?,
        run_id: row.try_get("run_id")?,
        conversation_id: row.try_get("conversation_id")?,
        provider_call_index: row.try_get("provider_call_index")?,
        model_hash: row.try_get("model_hash")?,
        protocol_type: row.try_get("protocol_type")?,
        endpoint_url: row.try_get("endpoint_url")?,
        model_id: row.try_get("model_id")?,
        display_name: row.try_get("display_name")?,
        reasoning_effort: row.try_get("reasoning_effort")?,
        fast: Some(row.try_get("fast")?),
        status: row.try_get("status")?,
        finish_reason: row.try_get("finish_reason")?,
        created_at_ms: row.try_get("created_at_ms")?,
        request_started_at_ms: row.try_get("request_started_at_ms")?,
        response_headers_at_ms: row.try_get("response_headers_at_ms")?,
        first_event_at_ms: row.try_get("first_event_at_ms")?,
        first_text_at_ms: row.try_get("first_text_at_ms")?,
        first_valid_response_at_ms: row.try_get("first_valid_response_at_ms")?,
        finished_at_ms: row.try_get("finished_at_ms")?,
        queue_ms: row.try_get("queue_ms")?,
        ttfb_ms: row.try_get("ttfb_ms")?,
        ttft_ms: row.try_get("ttft_ms")?,
        ttfr_ms: row.try_get("ttfr_ms")?,
        duration_ms: row.try_get("duration_ms")?,
        input_tokens: row.try_get("input_tokens")?,
        output_tokens: row.try_get("output_tokens")?,
        total_tokens: row.try_get("total_tokens")?,
        cache_read_tokens: row.try_get("cache_read_tokens")?,
        cache_write_tokens: row.try_get("cache_write_tokens")?,
        reasoning_tokens: row.try_get("reasoning_tokens")?,
        estimated_output_tokens: row.try_get("estimated_output_tokens")?,
        usage: usage
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        message_count: row.try_get("message_count")?,
        tool_count: row.try_get("tool_count")?,
        request_bytes: row.try_get("request_bytes")?,
        response_bytes: row.try_get("response_bytes")?,
        stream_event_count: row.try_get("stream_event_count")?,
        http_status: row.try_get("http_status")?,
        error_kind: row.try_get("error_kind")?,
        error_message: row.try_get("error_message")?,
        detailed: row.try_get("detailed")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProtocolType;

    /// Provider models are not in model_configs; call records must still be written and filterable by their stable ID.
    #[tokio::test]
    async fn provider_calls_record_without_a_model_config_row() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let provider_model = "provider:dev.example/codex/gpt-test";
        store
            .start_llm_call(&NewLlmCall {
                call_id: "provider-call".into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: provider_model.into(),
                protocol_type: ProtocolType::Provider,
                endpoint_url: "provider://dev.example/codex".into(),
                model_id: "gpt-test".into(),
                display_name: "GPT Test".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            })
            .await
            .unwrap();
        store
            .finish_llm_call("provider-call", "completed", None, 10, None, None)
            .await
            .unwrap();
        let overview = store
            .overview(
                None,
                None,
                Some(&format!("[\"{provider_model}\"]")),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(overview.metrics.llm_calls, 1);
        assert_eq!(overview.metrics.successful_calls, 1);
    }

    #[tokio::test]
    async fn latest_context_usage_follows_conversation_chronology() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        for (call_id, model_id, context_input_tokens, message_count) in [
            ("call-a-1", "model-a", 100_u64, 3_usize),
            ("call-b", "model-b", 200_u64, 5_usize),
            ("call-a-2", "model-a", 300_u64, 7_usize),
        ] {
            store
                .start_llm_call(&NewLlmCall {
                    call_id: call_id.into(),
                    run_id: format!("run-{call_id}"),
                    conversation_id: "conversation".into(),
                    provider_call_index: 0,
                    model_hash: model_id.into(),
                    protocol_type: ProtocolType::Provider,
                    endpoint_url: "provider://test".into(),
                    model_id: model_id.into(),
                    display_name: model_id.into(),
                    reasoning_effort: None,
                    fast: false,
                    message_count,
                    tool_count: 0,
                    detailed: false,
                })
                .await
                .unwrap();
            store
                .record_llm_usage(
                    call_id,
                    Usage {
                        input_tokens: Some(context_input_tokens),
                        context_input_tokens: Some(context_input_tokens),
                        output_tokens: Some(10),
                        total_tokens: Some(context_input_tokens + 10),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }

        assert_eq!(
            store.latest_context_usage("conversation").await.unwrap(),
            Some(ContextUsageAnchor {
                context_input_tokens: 300,
                message_count: 7,
            })
        );
        assert_eq!(store.latest_context_usage("other").await.unwrap(), None);
    }

    async fn test_store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        (directory, store)
    }

    async fn seed_call(
        store: &Store,
        call_id: &str,
        model_hash: &str,
        model_id: &str,
        display_name: &str,
        status: &str,
        created_at_ms: i64,
    ) {
        store
            .start_llm_call(&NewLlmCall {
                call_id: call_id.into(),
                run_id: format!("run-{call_id}"),
                conversation_id: format!("conv-{call_id}"),
                provider_call_index: 0,
                model_hash: model_hash.into(),
                protocol_type: ProtocolType::Provider,
                endpoint_url: "provider://test/channel".into(),
                model_id: model_id.into(),
                display_name: display_name.into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            })
            .await
            .unwrap();
        sqlx::query("UPDATE llm_calls SET created_at_ms = ? WHERE call_id = ?")
            .bind(created_at_ms)
            .bind(call_id)
            .execute(&store.pool)
            .await
            .unwrap();
        if status != "running" {
            store
                .finish_llm_call(call_id, status, None, 10, None, None)
                .await
                .unwrap();
        }
    }

    fn ids(calls: &[LlmCallSummary]) -> Vec<&str> {
        calls.iter().map(|call| call.call_id.as_str()).collect()
    }

    #[tokio::test]
    async fn llm_calls_page_filters_by_status() {
        let (_directory, store) = test_store().await;
        seed_call(
            &store,
            "done",
            "hash-a",
            "model-a",
            "Model A",
            "completed",
            3,
        )
        .await;
        seed_call(&store, "broken", "hash-b", "model-b", "Model B", "error", 2).await;
        seed_call(&store, "live", "hash-c", "model-c", "Model C", "running", 1).await;

        let filter = |status: &str| LlmCallFilter {
            status: Some(status.into()),
            ..Default::default()
        };
        let (calls, total) = store
            .llm_calls_page(&filter("completed"), 0, 50)
            .await
            .unwrap();
        assert_eq!(ids(&calls), ["done"]);
        assert_eq!(total, 1);
        let (calls, total) = store
            .llm_calls_page(&filter("running"), 0, 50)
            .await
            .unwrap();
        assert_eq!(ids(&calls), ["live"]);
        assert_eq!(total, 1);
        let (calls, _) = store
            .llm_calls_page(&filter("cancelled"), 0, 50)
            .await
            .unwrap();
        assert!(calls.is_empty());
        let (_, total) = store
            .llm_calls_page(&LlmCallFilter::default(), 0, 50)
            .await
            .unwrap();
        assert_eq!(total, 3);
    }

    #[tokio::test]
    async fn llm_calls_page_matches_model_by_hash_or_upstream_id() {
        let (_directory, store) = test_store().await;
        seed_call(&store, "first", "hash-gpt", "gpt-4o", "GPT", "completed", 2).await;
        seed_call(
            &store,
            "second",
            "hash-claude",
            "claude-sonnet",
            "Claude",
            "completed",
            1,
        )
        .await;

        let filter = |model: &str| LlmCallFilter {
            model: Some(model.into()),
            ..Default::default()
        };
        let (calls, total) = store
            .llm_calls_page(&filter("hash-gpt"), 0, 50)
            .await
            .unwrap();
        assert_eq!(ids(&calls), ["first"]);
        assert_eq!(total, 1);
        let (calls, _) = store
            .llm_calls_page(&filter("claude-sonnet"), 0, 50)
            .await
            .unwrap();
        assert_eq!(ids(&calls), ["second"]);
        let (calls, _) = store.llm_calls_page(&filter("other"), 0, 50).await.unwrap();
        assert!(calls.is_empty());
    }

    #[tokio::test]
    async fn llm_calls_page_searches_text_and_escapes_like_wildcards() {
        let (_directory, store) = test_store().await;
        seed_call(
            &store,
            "a",
            "hash-a",
            "100x-model",
            "Claude Sonnet",
            "completed",
            2,
        )
        .await;
        seed_call(&store, "b", "hash-b", "gpt-4o", "GPT", "completed", 1).await;

        let filter = |q: &str| LlmCallFilter {
            q: Some(q.into()),
            ..Default::default()
        };
        // display_name, model_id, conversation_id, and call_id are all searched.
        for needle in ["sonnet", "gpt-4o", "conv-a", "b"] {
            let (calls, _) = store.llm_calls_page(&filter(needle), 0, 50).await.unwrap();
            assert_eq!(calls.len(), 1, "needle {needle}");
        }
        let (calls, _) = store
            .llm_calls_page(&filter("conv-b"), 0, 50)
            .await
            .unwrap();
        assert_eq!(ids(&calls), ["b"]);
        // A literal % must not act as a wildcard: "100%" does not match "100x-model".
        let (calls, total) = store.llm_calls_page(&filter("100%"), 0, 50).await.unwrap();
        assert!(calls.is_empty());
        assert_eq!(total, 0);
        let (calls, _) = store.llm_calls_page(&filter("100x"), 0, 50).await.unwrap();
        assert_eq!(ids(&calls), ["a"]);
    }

    #[tokio::test]
    async fn llm_calls_page_paginates_and_reports_the_filtered_total() {
        let (_directory, store) = test_store().await;
        for index in 0..5 {
            seed_call(
                &store,
                &format!("call-{index}"),
                "hash",
                "model",
                "Model",
                "completed",
                index,
            )
            .await;
        }

        let (calls, total) = store
            .llm_calls_page(&LlmCallFilter::default(), 0, 2)
            .await
            .unwrap();
        assert_eq!(ids(&calls), ["call-4", "call-3"]);
        assert_eq!(total, 5);
        let (calls, total) = store
            .llm_calls_page(&LlmCallFilter::default(), 4, 2)
            .await
            .unwrap();
        assert_eq!(ids(&calls), ["call-0"]);
        assert_eq!(total, 5);
        let (calls, total) = store
            .llm_calls_page(
                &LlmCallFilter {
                    status: Some("running".into()),
                    ..Default::default()
                },
                0,
                2,
            )
            .await
            .unwrap();
        assert!(calls.is_empty());
        assert_eq!(total, 0);
    }

    #[tokio::test]
    async fn a_running_call_keeps_the_streamed_output_estimate() {
        let (_directory, store) = test_store().await;
        seed_call(&store, "live", "hash", "model", "Model", "running", 1).await;
        store
            .record_llm_chunks("live", &[], false, Some(64))
            .await
            .unwrap();

        let summary = store.llm_call("live").await.unwrap().unwrap();
        assert_eq!(summary.estimated_output_tokens, Some(64));
        assert_eq!(summary.output_tokens, None);
    }
}
