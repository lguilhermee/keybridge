-- When `model_id` refuses a call, that call and the rest of its run go to
-- `fallback_model_id`; the next run starts with `model_id` again.
-- Both columns hold an API-key model hash or a provider model id ("provider:..."),
-- so neither can reference model_configs; the store rewrites or removes rows
-- when an API-key model changes identity or is deleted.
CREATE TABLE model_refusal_fallbacks (
    model_id TEXT PRIMARY KEY NOT NULL,
    fallback_model_id TEXT NOT NULL CHECK (fallback_model_id != model_id)
);
