-- Blob cleanup checks whether another trace artifact still references a blob,
-- and SQLite enforces the same lookup on every blob delete. Without an index
-- both scan the whole artifact table.
CREATE INDEX cursor_run_trace_artifacts_blob ON cursor_run_trace_artifacts(blob_id);
