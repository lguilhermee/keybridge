ALTER TABLE conversations ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));

-- Preserve an existing explicit cancellation when installing pause ownership.
UPDATE conversations SET paused = 1
WHERE (
    SELECT status FROM runs
    WHERE runs.conversation_id = conversations.conversation_id AND run_kind = 'root'
    ORDER BY created_at_ms DESC, rowid DESC LIMIT 1
) = 'cancelled';
