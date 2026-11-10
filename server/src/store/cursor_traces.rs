//! Persists Cursor request traces and artifacts.
use sqlx::{Row, Sqlite, Transaction};

use crate::{
    model::{CursorRunTraceArtifact, CursorRunTraceSummary},
    Result,
};

use super::{
    llm_calls::{like_pattern, LlmCallFilter},
    now_ms, BlobId, Store,
};

#[derive(Clone, Debug)]
pub(crate) struct BufferedCursorTraceChunk {
    pub(crate) source: String,
    pub(crate) data: Vec<u8>,
}

impl BufferedCursorTraceChunk {
    pub(crate) fn new(source: &str, data: &[u8]) -> Self {
        Self {
            source: source.into(),
            data: data.to_vec(),
        }
    }
}

impl Store {
    pub async fn start_cursor_trace_if_detailed(
        &self,
        request_id: &str,
        conversation_id: Option<&str>,
        route: &str,
        model_id: Option<&str>,
    ) -> Result<bool> {
        if self.cursor_trace_exists(request_id).await? {
            return Ok(true);
        }
        if !self.detailed_logging().await? {
            return Ok(false);
        }
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT OR IGNORE INTO cursor_run_traces(
                request_id, conversation_id, route, model_id, status, received_at_ms
             ) VALUES (?, ?, ?, ?, 'running', ?)",
        )
        .bind(request_id)
        .bind(conversation_id)
        .bind(route)
        .bind(model_id)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(true)
    }

    pub async fn cursor_trace_exists(&self, request_id: &str) -> Result<bool> {
        Ok(sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM cursor_run_traces WHERE request_id = ?)",
        )
        .bind(request_id)
        .fetch_one(&self.pool)
        .await?)
    }

    pub async fn append_cursor_trace_request(
        &self,
        request_id: &str,
        artifact_type: &str,
        source: &str,
        data: &[u8],
        metadata: &serde_json::Value,
    ) -> Result<()> {
        let metadata_json = serde_json::to_string(metadata)?;
        let blob_id = BlobId::digest(data);
        let _write = self.writes.lock().await;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        Self::put_blob_tx(&mut tx, &blob_id, data, &[]).await?;
        Self::link_cursor_trace_artifact_tx(
            &mut tx,
            request_id,
            artifact_type,
            source,
            &blob_id,
            &metadata_json,
        )
        .await?;
        sqlx::query(
            "UPDATE cursor_run_traces
             SET request_bytes = request_bytes + ? WHERE request_id = ?",
        )
        .bind(as_i64(data.len()))
        .bind(request_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn append_cursor_trace_artifact(
        &self,
        request_id: &str,
        artifact_type: &str,
        source: &str,
        data: &[u8],
        metadata: &serde_json::Value,
    ) -> Result<()> {
        let metadata_json = serde_json::to_string(metadata)?;
        let blob_id = BlobId::digest(data);
        let _write = self.writes.lock().await;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        Self::put_blob_tx(&mut tx, &blob_id, data, &[]).await?;
        Self::link_cursor_trace_artifact_tx(
            &mut tx,
            request_id,
            artifact_type,
            source,
            &blob_id,
            &metadata_json,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn link_cursor_trace_artifact(
        &self,
        request_id: &str,
        artifact_type: &str,
        source: &str,
        blob_id: &BlobId,
        metadata: &serde_json::Value,
    ) -> Result<()> {
        let metadata_json = serde_json::to_string(metadata)?;
        let _write = self.writes.lock().await;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        Self::link_cursor_trace_artifact_tx(
            &mut tx,
            request_id,
            artifact_type,
            source,
            blob_id,
            &metadata_json,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn link_cursor_trace_artifact_tx(
        tx: &mut Transaction<'_, Sqlite>,
        request_id: &str,
        artifact_type: &str,
        source: &str,
        blob_id: &BlobId,
        metadata_json: &str,
    ) -> Result<()> {
        let next: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), -1) + 1
             FROM cursor_run_trace_artifacts WHERE request_id = ?",
        )
        .bind(request_id)
        .fetch_one(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT INTO cursor_run_trace_artifacts(
                request_id, seq, artifact_type, source, blob_id, metadata_json, created_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(request_id)
        .bind(next)
        .bind(artifact_type)
        .bind(source)
        .bind(blob_id.as_bytes().as_slice())
        .bind(metadata_json)
        .bind(now_ms())
        .execute(&mut **tx)
        .await?;
        Ok(())
    }

    pub async fn start_cursor_trace_response(&self, request_id: &str, status: u16) -> Result<()> {
        let now = now_ms();
        let _write = self.writes.lock().await;
        sqlx::query(
            "UPDATE cursor_run_traces
             SET status = 'running', http_status = ?,
                 first_response_at_ms = COALESCE(first_response_at_ms, ?),
                 finished_at_ms = NULL, error_message = NULL
             WHERE request_id = ?",
        )
        .bind(status as i64)
        .bind(now)
        .bind(request_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn add_cursor_trace_response_chunk(
        &self,
        request_id: &str,
        source: &str,
        data: &[u8],
    ) -> Result<()> {
        self.add_cursor_trace_response_chunks(
            request_id,
            &[BufferedCursorTraceChunk::new(source, data)],
        )
        .await
    }

    pub(crate) async fn add_cursor_trace_response_chunks(
        &self,
        request_id: &str,
        chunks: &[BufferedCursorTraceChunk],
    ) -> Result<()> {
        if chunks.is_empty() {
            return Ok(());
        }
        let response_bytes = chunks.iter().map(|chunk| chunk.data.len()).sum::<usize>();
        let _write = self.writes.lock().await;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        for chunk in chunks {
            let metadata_json =
                serde_json::to_string(&serde_json::json!({"byte_count": chunk.data.len()}))?;
            let blob_id = BlobId::digest(&chunk.data);
            Self::put_blob_tx(&mut tx, &blob_id, &chunk.data, &[]).await?;
            Self::link_cursor_trace_artifact_tx(
                &mut tx,
                request_id,
                "run_sse_chunk",
                &chunk.source,
                &blob_id,
                &metadata_json,
            )
            .await?;
        }
        sqlx::query(
            "UPDATE cursor_run_traces
             SET response_bytes = response_bytes + ?,
                 response_event_count = response_event_count + ?,
                 first_response_at_ms = COALESCE(first_response_at_ms, ?)
             WHERE request_id = ?",
        )
        .bind(as_i64(response_bytes))
        .bind(chunks.len() as i64)
        .bind(now_ms())
        .bind(request_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn finish_cursor_trace(&self, request_id: &str, error: Option<&str>) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query(
            "UPDATE cursor_run_traces
             SET status = ?, finished_at_ms = ?, error_message = ?
             WHERE request_id = ?",
        )
        .bind(if error.is_some() {
            "error"
        } else {
            "completed"
        })
        .bind(now_ms())
        .bind(error)
        .bind(request_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn cursor_trace(&self, request_id: &str) -> Result<Option<CursorRunTraceSummary>> {
        sqlx::query("SELECT * FROM cursor_run_traces WHERE request_id = ?")
            .bind(request_id)
            .fetch_optional(&self.pool)
            .await?
            .map(trace_from_row)
            .transpose()
    }

    /// Filtered official-trace rows plus the total matching the call-history
    /// filters; `model` only matches `model_id` (traces have no model hash).
    pub async fn official_cursor_traces_page(
        &self,
        filter: &LlmCallFilter,
        offset: i64,
        limit: i64,
    ) -> Result<(Vec<CursorRunTraceSummary>, i64)> {
        let like = filter.q.as_deref().map(like_pattern);
        let rows = sqlx::query(
            "SELECT * FROM cursor_run_traces
             WHERE route = 'cursor_official'
               AND (? IS NULL OR status = ?)
               AND (? IS NULL OR model_id = ?)
               AND (? IS NULL OR request_id LIKE ? ESCAPE '\\'
                    OR conversation_id LIKE ? ESCAPE '\\'
                    OR model_id LIKE ? ESCAPE '\\'
                    OR error_message LIKE ? ESCAPE '\\')
             ORDER BY received_at_ms DESC LIMIT ? OFFSET ?",
        )
        .bind(&filter.status)
        .bind(&filter.status)
        .bind(&filter.model)
        .bind(&filter.model)
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
            "SELECT COUNT(*) FROM cursor_run_traces
             WHERE route = 'cursor_official'
               AND (? IS NULL OR status = ?)
               AND (? IS NULL OR model_id = ?)
               AND (? IS NULL OR request_id LIKE ? ESCAPE '\\'
                    OR conversation_id LIKE ? ESCAPE '\\'
                    OR model_id LIKE ? ESCAPE '\\'
                    OR error_message LIKE ? ESCAPE '\\')",
        )
        .bind(&filter.status)
        .bind(&filter.status)
        .bind(&filter.model)
        .bind(&filter.model)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .bind(&like)
        .fetch_one(&self.pool)
        .await?;
        Ok((
            rows.into_iter()
                .map(trace_from_row)
                .collect::<Result<_>>()?,
            total,
        ))
    }

    pub async fn cursor_trace_artifacts(
        &self,
        request_id: &str,
    ) -> Result<Vec<CursorRunTraceArtifact>> {
        let rows = sqlx::query(
            "SELECT a.seq, a.artifact_type, a.source, a.metadata_json,
                    a.created_at_ms, b.data
             FROM cursor_run_trace_artifacts a
             JOIN blobs b ON b.blob_id = a.blob_id
             WHERE a.request_id = ? ORDER BY a.seq",
        )
        .bind(request_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(CursorRunTraceArtifact {
                    seq: row.try_get("seq")?,
                    artifact_type: row.try_get("artifact_type")?,
                    source: row.try_get("source")?,
                    metadata: serde_json::from_str(row.try_get("metadata_json")?)?,
                    created_at_ms: row.try_get("created_at_ms")?,
                    data: row.try_get("data")?,
                })
            })
            .collect()
    }
}

fn trace_from_row(row: sqlx::sqlite::SqliteRow) -> Result<CursorRunTraceSummary> {
    Ok(CursorRunTraceSummary {
        request_id: row.try_get("request_id")?,
        conversation_id: row.try_get("conversation_id")?,
        route: row.try_get("route")?,
        model_id: row.try_get("model_id")?,
        status: row.try_get("status")?,
        request_bytes: row.try_get("request_bytes")?,
        response_bytes: row.try_get("response_bytes")?,
        response_event_count: row.try_get("response_event_count")?,
        http_status: row.try_get("http_status")?,
        received_at_ms: row.try_get("received_at_ms")?,
        first_response_at_ms: row.try_get("first_response_at_ms")?,
        finished_at_ms: row.try_get("finished_at_ms")?,
        error_message: row.try_get("error_message")?,
    })
}

fn as_i64(value: usize) -> i64 {
    value.min(i64::MAX as usize) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

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

    async fn seed_trace(
        store: &Store,
        request_id: &str,
        route: &str,
        model_id: Option<&str>,
        status: &str,
        received_at_ms: i64,
    ) {
        sqlx::query(
            "INSERT INTO cursor_run_traces(request_id, conversation_id, route, model_id, status, received_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(request_id)
        .bind(format!("conv-{request_id}"))
        .bind(route)
        .bind(model_id)
        .bind(status)
        .bind(received_at_ms)
        .execute(&store.pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn official_traces_page_filters_and_reports_total() {
        let (_directory, store) = test_store().await;
        seed_trace(
            &store,
            "t-auto",
            "cursor_official",
            Some("auto"),
            "completed",
            3,
        )
        .await;
        seed_trace(
            &store,
            "t-gpt",
            "cursor_official",
            Some("gpt-5"),
            "error",
            2,
        )
        .await;
        seed_trace(
            &store,
            "t-live",
            "cursor_official",
            Some("auto"),
            "running",
            1,
        )
        .await;

        let filter = |status: &str| LlmCallFilter {
            status: Some(status.into()),
            ..Default::default()
        };
        let (traces, total) = store
            .official_cursor_traces_page(&filter("completed"), 0, 50)
            .await
            .unwrap();
        assert_eq!(traces.len(), 1);
        assert_eq!(traces[0].request_id, "t-auto");
        assert_eq!(total, 1);

        // The model filter matches the trace's model_id.
        let (traces, total) = store
            .official_cursor_traces_page(
                &LlmCallFilter {
                    model: Some("auto".into()),
                    ..Default::default()
                },
                0,
                50,
            )
            .await
            .unwrap();
        assert_eq!(traces.len(), 2);
        assert_eq!(total, 2);

        // Text search covers request/conversation/model fields.
        let (traces, _) = store
            .official_cursor_traces_page(
                &LlmCallFilter {
                    q: Some("conv-t-gpt".into()),
                    ..Default::default()
                },
                0,
                50,
            )
            .await
            .unwrap();
        assert_eq!(traces.len(), 1);
        assert_eq!(traces[0].request_id, "t-gpt");

        // Paging keeps the merged stream order (received_at_ms desc).
        let (traces, total) = store
            .official_cursor_traces_page(&LlmCallFilter::default(), 1, 1)
            .await
            .unwrap();
        assert_eq!(traces[0].request_id, "t-gpt");
        assert_eq!(total, 3);
    }

    #[tokio::test]
    async fn official_traces_page_excludes_local_byok_rows() {
        let (_directory, store) = test_store().await;
        seed_trace(
            &store,
            "t-local",
            "local_byok",
            Some("auto"),
            "completed",
            2,
        )
        .await;
        seed_trace(
            &store,
            "t-official",
            "cursor_official",
            Some("auto"),
            "completed",
            1,
        )
        .await;

        // local_byok rows never enter the calls list even though they share the table.
        let (traces, total) = store
            .official_cursor_traces_page(&LlmCallFilter::default(), 0, 50)
            .await
            .unwrap();
        assert_eq!(traces.len(), 1);
        assert_eq!(total, 1);
    }
}
