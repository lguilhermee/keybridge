-- input_tokens now means non-cached input for every source, and
-- usage_json.context_input_tokens means the full prompt size.
-- OpenAI-protocol rows and every plugin except Claude stored a prompt total
-- that included cached tokens; the Claude plugin stored non-cached input but
-- copied it into context_input_tokens.
UPDATE llm_calls
SET usage_json = CASE
        WHEN usage_json IS NULL THEN NULL
        ELSE json_set(
            usage_json,
            '$.input_tokens',
            MAX(0, input_tokens - COALESCE(cache_read_tokens, 0) - COALESCE(cache_write_tokens, 0))
        )
    END,
    input_tokens = MAX(0, input_tokens - COALESCE(cache_read_tokens, 0) - COALESCE(cache_write_tokens, 0))
WHERE input_tokens IS NOT NULL
  AND (
    request_type IN ('openai-chat', 'openai-responses')
    OR (
        request_type = 'plugin'
        AND request_url NOT LIKE 'plugin://dev.cursorbyok.providers.claude/%'
    )
  );

UPDATE llm_calls
SET usage_json = json_set(
        usage_json,
        '$.context_input_tokens',
        input_tokens + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)
    )
WHERE request_type = 'plugin'
  AND request_url LIKE 'plugin://dev.cursorbyok.providers.claude/%'
  AND usage_json IS NOT NULL
  AND input_tokens IS NOT NULL;
