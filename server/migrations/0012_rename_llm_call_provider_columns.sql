-- plugin → provider rename: collapse the duplicate request_* pair into
-- protocol_type/endpoint_url and rewrite stored plugin identifiers.
ALTER TABLE llm_calls DROP COLUMN request_type;
ALTER TABLE llm_calls DROP COLUMN request_url;
ALTER TABLE llm_calls RENAME COLUMN provider_type TO protocol_type;
ALTER TABLE llm_calls RENAME COLUMN provider_url TO endpoint_url;

UPDATE llm_calls SET protocol_type = 'provider' WHERE protocol_type = 'plugin';
UPDATE llm_calls SET endpoint_url = replace(endpoint_url, 'plugin://', 'provider://')
WHERE endpoint_url LIKE 'plugin://%';
UPDATE llm_calls SET model_id = replace(model_id, 'plugin:', 'provider:')
WHERE model_id LIKE 'plugin:%';

-- The three provider IDs that changed namespace.
UPDATE llm_calls SET
    endpoint_url = replace(endpoint_url, 'dev.cursorbyok.plugins.antigravity-auth', 'dev.cursorbyok.providers.antigravity-auth'),
    model_id = replace(model_id, 'dev.cursorbyok.plugins.antigravity-auth', 'dev.cursorbyok.providers.antigravity-auth')
WHERE endpoint_url LIKE '%dev.cursorbyok.plugins.antigravity-auth%' OR model_id LIKE '%dev.cursorbyok.plugins.antigravity-auth%';
UPDATE llm_calls SET
    endpoint_url = replace(endpoint_url, 'dev.cursorbyok.examples.codex-auth', 'dev.cursorbyok.providers.codex-auth'),
    model_id = replace(model_id, 'dev.cursorbyok.examples.codex-auth', 'dev.cursorbyok.providers.codex-auth')
WHERE endpoint_url LIKE '%dev.cursorbyok.examples.codex-auth%' OR model_id LIKE '%dev.cursorbyok.examples.codex-auth%';
UPDATE llm_calls SET
    endpoint_url = replace(endpoint_url, 'dev.cursorbyok.examples.grok-auth', 'dev.cursorbyok.providers.grok-auth'),
    model_id = replace(model_id, 'dev.cursorbyok.examples.grok-auth', 'dev.cursorbyok.providers.grok-auth')
WHERE endpoint_url LIKE '%dev.cursorbyok.examples.grok-auth%' OR model_id LIKE '%dev.cursorbyok.examples.grok-auth%';

-- Commit-message model setting (service_settings.value_json -> $.model_id).
-- The prefix rewrite does not cover the three renamed IDs inside the stored
-- `plugin:<id>/<channel>/<model>` strings, so the replacements chain.
UPDATE service_settings
SET value_json = json_replace(
    value_json,
    '$.model_id',
    replace(
        replace(
            replace(
                replace(json_extract(value_json, '$.model_id'), 'plugin:', 'provider:'),
                'dev.cursorbyok.plugins.antigravity-auth',
                'dev.cursorbyok.providers.antigravity-auth'
            ),
            'dev.cursorbyok.examples.codex-auth',
            'dev.cursorbyok.providers.codex-auth'
        ),
        'dev.cursorbyok.examples.grok-auth',
        'dev.cursorbyok.providers.grok-auth'
    )
)
WHERE setting_key = 'commit_settings'
  AND json_extract(value_json, '$.model_id') LIKE 'plugin:%';
