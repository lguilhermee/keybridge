-- Live output estimate: the recorder accumulates a token estimate from streamed
-- deltas so the calls list can show an estimated output count while a call runs.
ALTER TABLE llm_calls ADD COLUMN estimated_output_tokens INTEGER;
