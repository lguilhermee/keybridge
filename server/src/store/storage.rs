//! Row accounting and cleanup for disposable observability data.

use serde::{Deserialize, Serialize};

use crate::Result;

use super::Store;

/// Rows removed per transaction. Statistics can hold millions of rows and tens
/// of gigabytes, so cleanup commits in small batches and releases the write
/// lock in between instead of blocking every other writer for the whole run.
const CLEAR_BATCH_ROWS: i64 = 2_000;

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct StatisticsStorage {
    pub call_count: i64,
    pub trace_count: i64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StatisticsStorageScope {
    #[default]
    Details,
    All,
}

impl Store {
    pub async fn statistics_storage(&self) -> Result<StatisticsStorage> {
        let (call_count, trace_count) = sqlx::query_as::<_, (i64, i64)>(
            "SELECT (SELECT COUNT(*) FROM llm_calls), (SELECT COUNT(*) FROM cursor_run_traces)",
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(StatisticsStorage {
            call_count,
            trace_count,
        })
    }

    pub async fn clear_statistics_storage(&self) -> Result<StatisticsStorage> {
        self.clear_detail_storage().await?;
        self.statistics_storage().await
    }

    pub async fn clear_all_statistics_storage(&self) -> Result<StatisticsStorage> {
        self.clear_detail_storage().await?;
        // Details are gone, so removing calls and traces cascades over no rows.
        self.delete_all_in_batches("llm_calls").await?;
        self.delete_all_in_batches("cursor_run_traces").await?;
        self.statistics_storage().await
    }

    async fn clear_detail_storage(&self) -> Result<()> {
        self.delete_all_in_batches("llm_call_response_chunks")
            .await?;
        self.delete_all_in_batches("llm_call_requests").await?;
        self.clear_trace_artifacts().await
    }

    /// `table` is always a compile-time table name from this module.
    async fn delete_all_in_batches(&self, table: &'static str) -> Result<()> {
        let sql = format!(
            "DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} LIMIT {CLEAR_BATCH_ROWS})"
        );
        loop {
            let deleted = {
                let _write = self.writes.lock().await;
                sqlx::query(&sql).execute(&self.pool).await?.rows_affected()
            };
            if deleted == 0 {
                return Ok(());
            }
        }
    }

    /// Deletes every trace artifact and the blobs only they referenced.
    async fn clear_trace_artifacts(&self) -> Result<()> {
        loop {
            let _write = self.writes.lock().await;
            let mut transaction = self.pool.begin().await?;
            let blob_ids = sqlx::query_scalar::<_, Vec<u8>>(
                "DELETE FROM cursor_run_trace_artifacts
                 WHERE rowid IN (SELECT rowid FROM cursor_run_trace_artifacts LIMIT ?)
                 RETURNING blob_id",
            )
            .bind(CLEAR_BATCH_ROWS)
            .fetch_all(&mut *transaction)
            .await?;
            if blob_ids.is_empty() {
                return Ok(());
            }
            for blob_id in blob_ids {
                sqlx::query(
                    "DELETE FROM blobs
                     WHERE blob_id = ?
                       AND NOT EXISTS (
                           SELECT 1 FROM cursor_run_trace_artifacts a WHERE a.blob_id = blobs.blob_id
                       )
                       AND NOT EXISTS (
                           SELECT 1 FROM blob_edges e WHERE e.parent_blob_id = blobs.blob_id
                       )
                       AND NOT EXISTS (
                           SELECT 1 FROM blob_edges e WHERE e.child_blob_id = blobs.blob_id
                       )",
                )
                .bind(blob_id)
                .execute(&mut *transaction)
                .await?;
            }
            transaction.commit().await?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn count(store: &Store, table: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&store.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn clearing_statistics_removes_traces_and_orphaned_blobs_only() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        let blob = |byte: u8| vec![byte; 32];
        for byte in 1..=4u8 {
            sqlx::query("INSERT INTO blobs(blob_id, data, created_at_ms) VALUES (?, x'00', 0)")
                .bind(blob(byte))
                .execute(&store.pool)
                .await
                .unwrap();
        }
        // Blob 4 is also a conversation blob and must survive.
        sqlx::query(
            "INSERT INTO blob_edges(parent_blob_id, child_blob_id, field_name) VALUES (?, ?, 'x')",
        )
        .bind(blob(4))
        .bind(blob(3))
        .execute(&store.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO cursor_run_traces(request_id, conversation_id, route, status, received_at_ms)
             VALUES ('r', 'c', 'cursor_official', 'completed', 0)",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        // Blob 1 is shared by two artifacts; the batch loop must not trip over it.
        for (seq, byte) in [(0, 1u8), (1, 1), (2, 2), (3, 4)] {
            sqlx::query(
                "INSERT INTO cursor_run_trace_artifacts(request_id, seq, artifact_type, source, blob_id, created_at_ms)
                 VALUES ('r', ?, 'request', 'cursor_client', ?, 0)",
            )
            .bind(seq)
            .bind(blob(byte))
            .execute(&store.pool)
            .await
            .unwrap();
        }

        let storage = store.clear_all_statistics_storage().await.unwrap();

        assert_eq!(storage.trace_count, 0);
        assert_eq!(count(&store, "cursor_run_trace_artifacts").await, 0);
        // Blobs 1 and 2 are gone; 3 and 4 are still linked by a blob edge.
        assert_eq!(count(&store, "blobs").await, 2);
    }
}
