# Token Usage Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every recorded and displayed token count mean the same thing for every model source, and cut daily usage buckets at the user's local midnight.

**Architecture:** `Usage.input_tokens` becomes non-cached input everywhere and `Usage.context_input_tokens` becomes the full prompt size (input + cache read + cache write). Each writer converts at its own edge: the two OpenAI protocol adapters in Rust, the two OpenAI helpers in the plugin SDK, and the two built-in plugins that report in a different convention. The overview query then sums `input_tokens` directly, one forward migration normalises existing rows, and the overview endpoint takes a UTC offset for bucketing.

**Tech Stack:** Rust (axum, sqlx/SQLite, chrono), TypeScript plugin SDK run under Deno, React desktop frontend.

**Spec:** `docs/superpowers/specs/2026-11-09-ui-redesign-design.md`, section "Step 1: token accuracy".

**Not in this plan:** replacing the characters ÷ 4 estimate in `server/src/model/token_count.rs` with `tiktoken-rs`. Three integration test files (`server/tests/compaction.rs`, `interrupt.rs`, `tool_round.rs`) build fixtures such as `"x".repeat(400_000)` that rely on the current estimate, so that change needs its own plan.

## Global Constraints

- Never modify, rename, reorder, or delete an existing file in `server/migrations/`. Add `0011_...` only.
- No compatibility layers or fallback reads: after the migration, code reads the new meaning only.
- Do not add or remove code comments except the doc comments this plan specifies.
- Rust verification, run from the repo root: `cargo fmt --all -- --check`, `cargo clippy -p cursor-server --all-targets -- -D warnings`, `cargo test -p cursor-server --all-targets`. Prefix cargo commands with `CARGO_TARGET_DIR=target/devin-test` so they do not fight a running desktop dev build.
- Built-in plugin tests run from the plugin's own directory with the bundled Deno: `~/.cursor-byok-v3/plugins/runtime/deno/v2.9.6/x86_64-pc-windows-msvc/deno.exe test -A <file>_test.ts`. Below this is written as `$DENO`.
- Installed built-in plugins are only refreshed when `plugin.json` `version` changes. Any task that edits a built-in plugin's non-test source bumps that plugin's patch version.
- Frontend verification, run from `apps/desktop`: `npm run check`.
- Tasks 1 to 3 change writers and Task 4 changes the reader and migrates old rows. Do not ship a build between Task 1 and Task 4; the overview under-counts in between.

## Review Focus

1. A provider reports more cached tokens than prompt tokens. Expected: non-cached input clamps to 0, no underflow or panic. Test in Task 1.
2. A provider reports no cache fields at all. Expected: `input_tokens` equals the prompt size and `context_input_tokens` equals it too. Tests in Tasks 1 and 2.
3. A plugin sends a usage event with cache counts but a null `inputTokens`. Expected: `context_input_tokens` stays unknown instead of becoming a partial sum. Test in Task 2.
4. Existing rows with no usage (failed or still-running calls) and rows with `usage_json` NULL. Expected: the migration leaves them untouched and does not fail. Test in Task 4.
5. A half-hour time zone (UTC+5:30) or an out-of-range offset in the query string. Expected: buckets start on local midnight; an absurd offset is clamped to ±14 hours instead of producing empty or shifted data. Tests in Task 5.

Known limitation, accepted: the offset is a single number for the whole range, so in zones with daylight saving time, days on the other side of a clock change are cut one hour off local midnight.

---

### Task 1: OpenAI protocol adapters report non-cached input

**Files:**
- Modify: `server/src/model/observability.rs:9-18` (doc comments on `Usage`)
- Modify: `server/src/provider/openai_chat.rs:426-441`
- Modify: `server/src/provider/openai_responses.rs:529-544`
- Test: the `tests` modules at the bottom of the two adapter files

**Interfaces:**
- Consumes: nothing.
- Produces: `openai_usage(&Value) -> Usage` and `responses_usage(&Value) -> Usage` where `input_tokens` is non-cached input and `context_input_tokens` is the provider's full prompt count. `anthropic_usage` already has this meaning and is not changed.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `server/src/provider/openai_chat.rs`:

```rust
    #[test]
    fn cached_prompt_tokens_are_excluded_from_input_and_kept_in_context() {
        let usage = openai_usage(&serde_json::json!({
            "prompt_tokens": 100,
            "completion_tokens": 7,
            "total_tokens": 107,
            "prompt_tokens_details": {"cached_tokens": 40}
        }));

        assert_eq!(usage.input_tokens, Some(60));
        assert_eq!(usage.context_input_tokens, Some(100));
        assert_eq!(usage.cache_read_tokens, Some(40));
        assert_eq!(usage.output_tokens, Some(7));
        assert_eq!(usage.total_tokens, Some(107));
    }

    #[test]
    fn usage_without_cache_details_reports_the_whole_prompt_as_input() {
        let usage = openai_usage(&serde_json::json!({
            "prompt_tokens": 100,
            "completion_tokens": 7
        }));

        assert_eq!(usage.input_tokens, Some(100));
        assert_eq!(usage.context_input_tokens, Some(100));
        assert_eq!(usage.cache_read_tokens, None);
    }

    #[test]
    fn more_cached_than_prompt_tokens_clamps_input_to_zero() {
        let usage = openai_usage(&serde_json::json!({
            "prompt_tokens": 10,
            "prompt_tokens_details": {"cached_tokens": 25}
        }));

        assert_eq!(usage.input_tokens, Some(0));
        assert_eq!(usage.context_input_tokens, Some(10));
    }
```

Append inside `mod tests` in `server/src/provider/openai_responses.rs`:

```rust
    #[test]
    fn cached_input_tokens_are_excluded_from_input_and_kept_in_context() {
        let usage = responses_usage(&json!({
            "input_tokens": 100,
            "output_tokens": 7,
            "total_tokens": 107,
            "input_tokens_details": {"cached_tokens": 40},
            "output_tokens_details": {"reasoning_tokens": 3}
        }));

        assert_eq!(usage.input_tokens, Some(60));
        assert_eq!(usage.context_input_tokens, Some(100));
        assert_eq!(usage.cache_read_tokens, Some(40));
        assert_eq!(usage.reasoning_tokens, Some(3));
    }

    #[test]
    fn more_cached_than_input_tokens_clamps_input_to_zero() {
        let usage = responses_usage(&json!({
            "input_tokens": 10,
            "input_tokens_details": {"cached_tokens": 25}
        }));

        assert_eq!(usage.input_tokens, Some(0));
        assert_eq!(usage.context_input_tokens, Some(10));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib cached_`
Expected: FAIL. `cached_prompt_tokens_are_excluded_from_input_and_kept_in_context` and `cached_input_tokens_are_excluded_from_input_and_kept_in_context` report `left: Some(100)`, `right: Some(60)`.

- [ ] **Step 3: Implement**

In `server/src/provider/openai_chat.rs` replace the whole `openai_usage` function with:

```rust
pub(crate) fn openai_usage(value: &Value) -> Usage {
    let prompt_tokens = value.get("prompt_tokens").and_then(Value::as_u64);
    let cache_read_tokens = value
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(Value::as_u64);
    Usage {
        input_tokens: prompt_tokens
            .map(|prompt| prompt.saturating_sub(cache_read_tokens.unwrap_or_default())),
        context_input_tokens: prompt_tokens,
        output_tokens: value.get("completion_tokens").and_then(Value::as_u64),
        total_tokens: value.get("total_tokens").and_then(Value::as_u64),
        cache_read_tokens,
        cache_write_tokens: None,
        reasoning_tokens: value
            .pointer("/completion_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64),
    }
}
```

In `server/src/provider/openai_responses.rs` replace the whole `responses_usage` function with:

```rust
pub(crate) fn responses_usage(value: &Value) -> Usage {
    let prompt_tokens = value.get("input_tokens").and_then(Value::as_u64);
    let cache_read_tokens = value
        .pointer("/input_tokens_details/cached_tokens")
        .and_then(Value::as_u64);
    Usage {
        input_tokens: prompt_tokens
            .map(|prompt| prompt.saturating_sub(cache_read_tokens.unwrap_or_default())),
        context_input_tokens: prompt_tokens,
        output_tokens: value.get("output_tokens").and_then(Value::as_u64),
        total_tokens: value.get("total_tokens").and_then(Value::as_u64),
        cache_read_tokens,
        cache_write_tokens: None,
        reasoning_tokens: value
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64),
    }
}
```

In `server/src/model/observability.rs` add doc comments to two fields of `Usage`:

```rust
    pub struct Usage {
        /// Input tokens that were neither read from nor written to the prompt cache.
        pub input_tokens: Option<u64>,
        /// Full prompt size: `input_tokens` plus cache read plus cache write.
        pub context_input_tokens: Option<u64>,
        pub output_tokens: Option<u64>,
        pub total_tokens: Option<u64>,
        pub cache_read_tokens: Option<u64>,
        pub cache_write_tokens: Option<u64>,
        pub reasoning_tokens: Option<u64>,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib provider::`
Expected: PASS, including the five new tests.

- [ ] **Step 5: Run the whole server suite**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --all-targets`
Expected: PASS. `server/src/api/byok/output.rs` builds its OpenAI-shaped reply from `context_input_tokens`, so the external API's `prompt_tokens` is unchanged. If a test fails because it asserted an OpenAI `input_tokens` that included cached tokens, change that assertion to the non-cached value and say so in the commit body.

- [ ] **Step 6: Commit**

```bash
git add server/src/model/observability.rs server/src/provider/openai_chat.rs server/src/provider/openai_responses.rs
git commit -m "Report non-cached input from the OpenAI protocol adapters"
```

---

### Task 2: Plugin usage events carry the full prompt size

**Files:**
- Modify: `server/src/plugin/wire.rs:145-160`
- Test: `server/src/plugin/wire.rs`, `mod tests`, `parses_plugin_events_into_model_events`

**Interfaces:**
- Consumes: the SDK contract that Task 3 enforces: a plugin's `inputTokens` is non-cached input.
- Produces: `ModelEvent::Usage` from plugins with `context_input_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`.

- [ ] **Step 1: Write the failing test**

In `server/src/plugin/wire.rs`, in `parses_plugin_events_into_model_events`, change the expected `context_input_tokens` of the existing usage assertion from `Some(10)` to `Some(14)`:

```rust
        assert_eq!(
            usage,
            ModelEvent::Usage(Usage {
                input_tokens: Some(10),
                context_input_tokens: Some(14),
                output_tokens: Some(2),
                total_tokens: None,
                cache_read_tokens: Some(4),
                cache_write_tokens: None,
                reasoning_tokens: None,
            })
        );
```

Then add a new test in the same module:

```rust
    #[test]
    fn plugin_usage_context_is_unknown_without_an_input_count() {
        let usage = model_event(&serde_json::json!({
            "type":"usage",
            "usage":{"inputTokens":null,"outputTokens":2,"cacheReadTokens":4,"cacheWriteTokens":6}
        }))
        .unwrap();
        assert_eq!(
            usage,
            ModelEvent::Usage(Usage {
                input_tokens: None,
                context_input_tokens: None,
                output_tokens: Some(2),
                total_tokens: None,
                cache_read_tokens: Some(4),
                cache_write_tokens: Some(6),
                reasoning_tokens: None,
            })
        );

        let full = model_event(&serde_json::json!({
            "type":"usage",
            "usage":{"inputTokens":10,"cacheReadTokens":20,"cacheWriteTokens":30}
        }))
        .unwrap();
        let ModelEvent::Usage(full) = full else {
            panic!("expected a usage event");
        };
        assert_eq!(full.context_input_tokens, Some(60));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib plugin::wire`
Expected: FAIL. `parses_plugin_events_into_model_events` shows `context_input_tokens: Some(10)` on the left and `Some(14)` on the right; the new test shows `Some(10)` against `Some(60)`.

- [ ] **Step 3: Implement**

In `server/src/plugin/wire.rs` replace the `"usage" => { ... }` arm with:

```rust
        "usage" => {
            let usage = value
                .get("usage")
                .ok_or_else(|| Error::Protocol("plugin usage event requires usage".into()))?;
            let tokens = |name: &str| usage.get(name).and_then(serde_json::Value::as_u64);
            let input_tokens = tokens("inputTokens");
            let cache_read_tokens = tokens("cacheReadTokens");
            let cache_write_tokens = tokens("cacheWriteTokens");
            ModelEvent::Usage(Usage {
                input_tokens,
                context_input_tokens: input_tokens.map(|input| {
                    input
                        .saturating_add(cache_read_tokens.unwrap_or_default())
                        .saturating_add(cache_write_tokens.unwrap_or_default())
                }),
                output_tokens: tokens("outputTokens"),
                total_tokens: tokens("totalTokens"),
                cache_read_tokens,
                cache_write_tokens,
                reasoning_tokens: tokens("reasoningTokens"),
            })
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib plugin::wire`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/plugin/wire.rs
git commit -m "Derive plugin context size from input plus cache tokens"
```

---

### Task 3: Plugin SDK and built-in plugins report non-cached input

Today's conventions, which this task makes uniform:

| Source | `inputTokens` today | Change |
|---|---|---|
| `claude-auth` | non-cached | none |
| SDK `protocol/openai_chat.ts` (used by `grok-auth`, `opencode-auth`) | includes cached | subtract cached |
| SDK `protocol/openai_responses.ts` (used by `codex-auth`, `opencode-auth`) | includes cached | subtract cached |
| `antigravity-auth` | includes cached | subtract cached |
| `devin-auth` | upstream is non-cached, plugin adds cache into it | stop adding |

**Files:**
- Modify: `server/src/plugin/sdk/provider.ts:66-73` (doc comment)
- Modify: `server/src/plugin/sdk/protocol/openai_chat.ts:164-177`
- Modify: `server/src/plugin/sdk/protocol/openai_responses.ts:205-218`
- Modify: `server/plugins/build-in/antigravity-auth/provider.ts:427-439`
- Modify: `server/plugins/build-in/antigravity-auth/plugin.json` (version `0.1.8` to `0.1.9`)
- Modify: `server/plugins/build-in/devin-auth/request.ts:570-587`
- Modify: `server/plugins/build-in/devin-auth/plugin.json` (version `0.1.8` to `0.1.9`)
- Test: `server/plugins/build-in/grok-auth/grok_test.ts:293-302`
- Test: `server/plugins/build-in/codex-auth/codex_test.ts:523-533`
- Test: `server/plugins/build-in/antigravity-auth/provider_test.ts:127-137`
- Test: `server/plugins/build-in/devin-auth/devin_test.ts:447`

**Interfaces:**
- Consumes: nothing.
- Produces: every plugin `usage` event has `inputTokens` = non-cached input. Task 2 relies on this.

- [ ] **Step 1: Update the tests to the new contract**

In `server/plugins/build-in/grok-auth/grok_test.ts`, in the test `invoke streams normalized events from the xAI Chat Completions API`, change the expected usage event (upstream sends `prompt_tokens: 10`, `cached_tokens: 4`):

```ts
    {
      type: "usage",
      usage: {
        inputTokens: 6,
        outputTokens: 2,
        totalTokens: null,
        cacheReadTokens: 4,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
```

In `server/plugins/build-in/codex-auth/codex_test.ts`, in the test `invoke streams normalized events from the Codex Responses API`, change the expected usage event (upstream sends `input_tokens: 10`, `cached_tokens: 4`):

```ts
    {
      type: "usage",
      usage: {
        inputTokens: 6,
        outputTokens: 2,
        totalTokens: null,
        cacheReadTokens: 4,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
```

In `server/plugins/build-in/antigravity-auth/provider_test.ts`, in the test `provider parses usage metadata including cachedContentTokenCount as cacheReadTokens`, change the expected usage event (upstream sends `promptTokenCount: 120`, `cachedContentTokenCount: 80`):

```ts
    {
      type: "usage",
      usage: {
        inputTokens: 40,
        outputTokens: 15,
        totalTokens: 135,
        cacheReadTokens: 80,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
```

In `server/plugins/build-in/devin-auth/devin_test.ts`, in the test `Response decoder preserves signed reasoning, tool deltas, aliases, and usage`, add this assertion directly before the line `equal(events.at(-1), { type: "done", reason: "tool-use" });` (the test pushes `inputTokens: "5"`, `outputTokens: "3"`, `cacheReadTokens: "7"`):

```ts
  equal(events.find((event) => event.type === "usage"), {
    type: "usage",
    usage: {
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 15,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
      reasoningTokens: null,
    },
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Set the runtime path once:

```bash
DENO=~/.cursor-byok-v3/plugins/runtime/deno/v2.9.6/x86_64-pc-windows-msvc/deno.exe
```

Run each from its plugin directory:

```bash
(cd server/plugins/build-in/grok-auth && $DENO test -A grok_test.ts)
(cd server/plugins/build-in/codex-auth && $DENO test -A codex_test.ts)
(cd server/plugins/build-in/antigravity-auth && $DENO test -A provider_test.ts)
(cd server/plugins/build-in/devin-auth && $DENO test -A devin_test.ts)
```

Expected: one failing test in each. grok and codex show `inputTokens: 10` where `6` is expected; antigravity shows `120` where `40` is expected; devin shows `inputTokens: 12` where `5` is expected.

- [ ] **Step 3: Implement**

In `server/src/plugin/sdk/protocol/openai_chat.ts` replace `usageEvent` with:

```ts
function usageEvent(value: unknown): ModelEvent {
  const usage = record(value) ?? {};
  const promptTokens = count(usage.prompt_tokens);
  const cachedTokens = count(record(usage.prompt_tokens_details)?.cached_tokens);
  return {
    type: "usage",
    usage: {
      inputTokens: promptTokens === null ? null : Math.max(0, promptTokens - (cachedTokens ?? 0)),
      outputTokens: count(usage.completion_tokens),
      totalTokens: count(usage.total_tokens),
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: null,
      reasoningTokens: count(record(usage.completion_tokens_details)?.reasoning_tokens),
    },
  };
}
```

In `server/src/plugin/sdk/protocol/openai_responses.ts` replace `usageEvent` with:

```ts
function usageEvent(value: unknown): ModelEvent {
  const usage = record(value) ?? {};
  const promptTokens = count(usage.input_tokens);
  const cachedTokens = count(record(usage.input_tokens_details)?.cached_tokens);
  return {
    type: "usage",
    usage: {
      inputTokens: promptTokens === null ? null : Math.max(0, promptTokens - (cachedTokens ?? 0)),
      outputTokens: count(usage.output_tokens),
      totalTokens: count(usage.total_tokens),
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: null,
      reasoningTokens: count(record(usage.output_tokens_details)?.reasoning_tokens),
    },
  };
}
```

In `server/plugins/build-in/antigravity-auth/provider.ts` replace the `if (usage) { ... }` block that assigns `finalUsage` with:

```ts
        if (usage) {
          const promptTokens = typeof usage.promptTokenCount === "number"
            ? usage.promptTokenCount
            : null;
          const cachedTokens = typeof usage.cachedContentTokenCount === "number"
            ? usage.cachedContentTokenCount
            : null;
          finalUsage = {
            inputTokens: promptTokens === null
              ? null
              : Math.max(0, promptTokens - (cachedTokens ?? 0)),
            outputTokens: typeof usage.candidatesTokenCount === "number"
              ? usage.candidatesTokenCount
              : null,
            totalTokens: typeof usage.totalTokenCount === "number" ? usage.totalTokenCount : null,
            cacheReadTokens: cachedTokens,
          };
        }
```

In `server/plugins/build-in/devin-auth/request.ts`, in `finish()`, replace the `inputTokens` entry of the emitted usage so the block reads:

```ts
    const usage = this.usage;
    if (Object.keys(usage).length) {
      this.emit({
        type: "usage",
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: Object.values(usage).reduce(
            (sum, value) => sum + value,
            0,
          ),
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          reasoningTokens: null,
        },
      });
    }
```

In `server/src/plugin/sdk/provider.ts` add a doc comment to `ModelUsage`:

```ts
/**
 * Token counts for one model call. `inputTokens` is the input that was neither read from nor
 * written to the prompt cache; the host adds `cacheReadTokens` and `cacheWriteTokens` to it to
 * get the full prompt size. Upstreams that report a prompt total including cached tokens must
 * subtract them before emitting.
 */
export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};
```

In `server/plugins/build-in/antigravity-auth/plugin.json` and `server/plugins/build-in/devin-auth/plugin.json` change `"version": "0.1.8"` to `"version": "0.1.9"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the four commands from Step 2 again, plus the two suites that use the SDK helpers without asserting cache numbers:

```bash
(cd server/plugins/build-in/opencode-auth && $DENO test -A opencode_test.ts)
(cd server/plugins/build-in/claude-auth && $DENO test -A claude_test.ts)
```

Expected: all six PASS.

- [ ] **Step 5: Run the server suite (the plugin sources are embedded with `include_str!`)**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --all-targets`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/plugin/sdk server/plugins/build-in
git commit -m "Make plugin inputTokens mean non-cached input for every built-in provider"
```

---

### Task 4: Overview sums input directly and existing rows are normalised

**Files:**
- Create: `server/migrations/0011_normalize_llm_call_input_tokens.sql`
- Modify: `server/src/store/overview.rs:50-61`, `:90-104`, `:204-211`
- Modify: `server/src/store/migrations.rs:500` (expected version list in an existing test)
- Test: `server/src/store/overview.rs` (new `mod tests`)
- Test: `server/src/store/migrations.rs` (`mod tests`)

**Interfaces:**
- Consumes: writers from Tasks 1 to 3 store non-cached `input_tokens`.
- Produces: `Store::overview(start_ms, end_ms, model_hashes, bucket_ms)` (signature unchanged in this task) whose `input_tokens` is a plain sum of the column. Test helpers `store()` and `record(&Store, &str, ProviderType, Usage)` in `overview.rs` `mod tests`, reused by Task 5.

- [ ] **Step 1: Write the failing overview test**

Append to `server/src/store/overview.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NewLlmCall, ProviderType, Usage};

    async fn store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        (directory, store)
    }

    async fn record(store: &Store, call_id: &str, request_type: ProviderType, usage: Usage) {
        store
            .start_llm_call(&NewLlmCall {
                call_id: call_id.into(),
                run_id: format!("run-{call_id}"),
                conversation_id: "conversation".into(),
                provider_call_index: 0,
                model_hash: "model".into(),
                provider_type: request_type,
                provider_url: "https://example.test".into(),
                request_type,
                request_url: "https://example.test".into(),
                model_id: "model".into(),
                display_name: "Model".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            })
            .await
            .unwrap();
        store.record_llm_usage(call_id, usage).await.unwrap();
        store
            .finish_llm_call(call_id, "completed", None, 10, None, None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn overview_sums_non_cached_input_for_every_source() {
        let (_directory, store) = store().await;
        record(
            &store,
            "plugin",
            ProviderType::Plugin,
            Usage {
                input_tokens: Some(10),
                context_input_tokens: Some(60),
                output_tokens: Some(5),
                total_tokens: Some(65),
                cache_read_tokens: Some(20),
                cache_write_tokens: Some(30),
                reasoning_tokens: None,
            },
        )
        .await;
        record(
            &store,
            "openai",
            ProviderType::OpenAiChat,
            Usage {
                input_tokens: Some(60),
                context_input_tokens: Some(100),
                output_tokens: Some(7),
                total_tokens: Some(107),
                cache_read_tokens: Some(40),
                cache_write_tokens: None,
                reasoning_tokens: None,
            },
        )
        .await;

        let overview = store.overview(None, None, None, None).await.unwrap();

        assert_eq!(overview.metrics.input_tokens, 70);
        assert_eq!(overview.metrics.cache_read_tokens, 60);
        assert_eq!(overview.metrics.cache_write_tokens, 30);
        assert_eq!(overview.metrics.output_tokens, 12);
        assert_eq!(overview.metrics.prompt_tokens, 160);
        assert_eq!(overview.metrics.token_usage, 172);
        let series_input: i64 = overview
            .token_usage_series
            .iter()
            .map(|bucket| bucket.input_tokens)
            .sum();
        assert_eq!(series_input, 70);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib store::overview`
Expected: FAIL with `left: 20`, `right: 70` on `input_tokens` (the plugin row clamps to 0 and the OpenAI row is reduced to 20).

- [ ] **Step 3: Make the overview sum the column**

In `server/src/store/overview.rs`:

1. Delete the whole `fn fresh_input_sql()` function.
2. Replace the totals query (the `let token_row = sqlx::query(&format!(...))` statement up to and including `.await?;`) with:

```rust
        let token_row = sqlx::query(
            "SELECT
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens
             FROM llm_calls
             WHERE (? IS NULL OR created_at_ms >= ?)
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))",
        )
        .bind(start_ms)
        .bind(start_ms)
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_one(&self.pool)
        .await?;
```

3. Replace the series query (the `let rows = sqlx::query(&format!(...))` statement up to and including `.await?;`) with:

```rust
        let rows = sqlx::query(&format!(
            "SELECT
                (created_at_ms / {bucket_ms}) * {bucket_ms} AS bucket_start_ms,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cache_write_tokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens
             FROM llm_calls
             WHERE created_at_ms >= ?
               AND (? IS NULL OR created_at_ms < ?)
               AND (? IS NULL OR model_hash IN (SELECT value FROM json_each(?)))
             GROUP BY bucket_start_ms
             ORDER BY bucket_start_ms",
        ))
        .bind(start_ms.unwrap_or(series_start_ms).max(series_start_ms))
        .bind(end_ms)
        .bind(end_ms)
        .bind(model_hashes)
        .bind(model_hashes)
        .fetch_all(&self.pool)
        .await?;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib store::overview`
Expected: PASS.

- [ ] **Step 5: Write the failing migration test**

In `server/src/store/migrations.rs`, in `mod tests`, change the existing assertion in `lf_and_crlf_migration_histories_upgrade_without_rewriting_checksums` to expect the new version:

```rust
            assert_eq!(versions, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
```

Then add this test to the same module:

```rust
    #[tokio::test]
    async fn input_token_normalisation_rewrites_only_rows_that_included_cache() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let historical = migrator_with_line_endings(MigrationLineEndings::Lf);
        let previous = Migrator {
            migrations: Cow::Owned(historical.iter().take(10).cloned().collect()),
            ..Migrator::DEFAULT
        };
        previous.run(&pool).await.unwrap();

        let claude = "plugin://dev.cursorbyok.providers.claude/claude";
        let codex = "plugin://dev.cursorbyok.examples.codex-auth/codex";
        let rows: [(&str, &str, &str, Option<i64>, Option<i64>, Option<i64>, Option<&str>); 6] = [
            ("openai", "openai-chat", "https://api.example.test", Some(100), Some(40), None,
                Some(r#"{"input_tokens":100,"context_input_tokens":100,"cache_read_tokens":40}"#)),
            ("anthropic", "anthropic", "https://api.example.test", Some(10), Some(20), Some(30),
                Some(r#"{"input_tokens":10,"context_input_tokens":60,"cache_read_tokens":20,"cache_write_tokens":30}"#)),
            ("claude", "plugin", claude, Some(10), Some(20), Some(30),
                Some(r#"{"input_tokens":10,"context_input_tokens":10,"cache_read_tokens":20,"cache_write_tokens":30}"#)),
            ("codex", "plugin", codex, Some(100), Some(40), None,
                Some(r#"{"input_tokens":100,"context_input_tokens":100,"cache_read_tokens":40}"#)),
            ("over-cached", "openai-responses", "https://api.example.test", Some(10), Some(25), None,
                Some(r#"{"input_tokens":10,"context_input_tokens":10,"cache_read_tokens":25}"#)),
            ("no-usage", "openai-chat", "https://api.example.test", None, None, None, None),
        ];
        for (call_id, request_type, url, input, cache_read, cache_write, usage_json) in rows {
            sqlx::query(
                "INSERT INTO llm_calls(
                    call_id, run_id, conversation_id, provider_call_index, provider_type,
                    provider_url, request_type, request_url, model_id, display_name, status,
                    created_at_ms, input_tokens, cache_read_tokens, cache_write_tokens,
                    usage_json, message_count, tool_count, detailed
                 ) VALUES (?, 'run', 'conversation', 0, ?, ?, ?, ?, 'model', 'Model', 'completed',
                    1, ?, ?, ?, ?, 1, 0, 0)",
            )
            .bind(call_id)
            .bind(request_type)
            .bind(url)
            .bind(request_type)
            .bind(url)
            .bind(input)
            .bind(cache_read)
            .bind(cache_write)
            .bind(usage_json)
            .execute(&pool)
            .await
            .unwrap();
        }

        run(&pool, Path::new("input-token-normalisation.db"))
            .await
            .unwrap();

        let normalised: Vec<(String, Option<i64>, Option<i64>, Option<i64>)> = sqlx::query_as(
            "SELECT call_id, input_tokens,
                    json_extract(usage_json, '$.input_tokens'),
                    json_extract(usage_json, '$.context_input_tokens')
             FROM llm_calls ORDER BY call_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            normalised,
            vec![
                ("anthropic".into(), Some(10), Some(10), Some(60)),
                ("claude".into(), Some(10), Some(10), Some(60)),
                ("codex".into(), Some(60), Some(60), Some(100)),
                ("no-usage".into(), None, None, None),
                ("openai".into(), Some(60), Some(60), Some(100)),
                ("over-cached".into(), Some(0), Some(0), Some(10)),
            ]
        );
    }
```

- [ ] **Step 6: Run it to verify it fails**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib store::migrations`
Expected: FAIL. `input_token_normalisation_rewrites_only_rows_that_included_cache` shows the `claude` row with context `Some(10)` and the `openai` row with input `Some(100)`; `lf_and_crlf_migration_histories_upgrade_without_rewriting_checksums` shows versions ending at `10`.

If the INSERT itself fails with a NOT NULL or foreign-key error, the `llm_calls` table at migration 10 has a column this plan did not account for. Read `server/migrations/0007_drop_llm_calls_model_hash_fk.sql` through `0010_*.sql`, add the missing column with a literal value to the INSERT, and continue.

- [ ] **Step 7: Add the migration**

Create `server/migrations/0011_normalize_llm_call_input_tokens.sql`:

```sql
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
```

- [ ] **Step 8: Run the store tests to verify they pass**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib store::`
Expected: PASS, including `normalized_checksums_match_the_published_lf_and_windows_crlf_migrations` (it only checks migration 1).

- [ ] **Step 9: Run the whole server suite, fmt, and clippy**

```bash
cargo fmt --all -- --check
CARGO_TARGET_DIR=target/devin-test cargo clippy -p cursor-server --all-targets -- -D warnings
CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --all-targets
```

Expected: all three succeed. If `cargo fmt` reports the long tuple rows in the migration test, run `cargo fmt --all` and keep its formatting.

- [ ] **Step 10: Commit**

```bash
git add server/migrations/0011_normalize_llm_call_input_tokens.sql server/src/store/overview.rs server/src/store/migrations.rs
git commit -m "Sum stored input tokens in the overview and normalise existing call rows"
```

---

### Task 5: Overview buckets follow the caller's UTC offset

**Files:**
- Modify: `server/src/store/overview.rs` (`Store::overview`, `token_usage_buckets`, series query, tests)
- Modify: `server/src/control/overview.rs:14-36`
- Modify: `server/src/control/service.rs:300-310`
- Modify: `server/src/store/llm_calls.rs:455` (existing test call site)
- Test: `server/src/store/overview.rs` `mod tests`

**Interfaces:**
- Consumes: `store()` and `record(...)` test helpers from Task 4.
- Produces:
  - `Store::overview(start_ms: Option<i64>, end_ms: Option<i64>, model_hashes: Option<&str>, bucket_ms: Option<i64>, utc_offset_minutes: Option<i32>) -> Result<Overview>`
  - `ControlService::overview` with the same five parameters.
  - `GET /__byok-api__/api/overview?utc_offset_minutes=<int>`: minutes east of UTC (UTC-3 is `-180`). Missing means `0`. Values outside ±840 are clamped.
  - `bucket_start_ms` in the response is the UTC instant at which the local bucket begins.

- [ ] **Step 1: Write the failing tests**

In `server/src/store/overview.rs` `mod tests`, first change the existing call in `overview_sums_non_cached_input_for_every_source` to pass the new argument:

```rust
        let overview = store.overview(None, None, None, None, None).await.unwrap();
```

Then add:

```rust
    fn ms(timestamp: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(timestamp)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn one_local_day_is_one_bucket_starting_at_local_midnight() {
        let start = ms("2026-01-10T03:00:00Z");
        let end = ms("2026-01-11T03:00:00Z");

        let (granularity, bucket_ms, series_start_ms, bucket_count) =
            token_usage_buckets(Some(start), Some(end), Some(DAY_MS), -180 * MINUTE_MS);

        assert_eq!(granularity, TokenUsageGranularity::Day);
        assert_eq!(bucket_ms, DAY_MS);
        assert_eq!(series_start_ms, start);
        assert_eq!(bucket_count, 1);
    }

    #[test]
    fn half_hour_offsets_start_buckets_on_the_local_boundary() {
        let start = ms("2026-01-09T18:30:00Z");
        let end = ms("2026-01-10T18:30:00Z");

        let (_, _, series_start_ms, bucket_count) =
            token_usage_buckets(Some(start), Some(end), Some(DAY_MS), 330 * MINUTE_MS);

        assert_eq!(series_start_ms, start);
        assert_eq!(bucket_count, 1);
    }

    #[test]
    fn utc_offsets_outside_fourteen_hours_are_clamped() {
        assert_eq!(utc_offset_ms(None), 0);
        assert_eq!(utc_offset_ms(Some(-180)), -180 * MINUTE_MS);
        assert_eq!(utc_offset_ms(Some(100_000)), 840 * MINUTE_MS);
        assert_eq!(utc_offset_ms(Some(-100_000)), -840 * MINUTE_MS);
    }

    #[tokio::test]
    async fn calls_either_side_of_local_midnight_land_in_different_days() {
        let (_directory, store) = store().await;
        let usage = |input| Usage {
            input_tokens: Some(input),
            ..Default::default()
        };
        record(&store, "late-evening", ProviderType::Anthropic, usage(1)).await;
        record(&store, "after-midnight", ProviderType::Anthropic, usage(2)).await;
        for (call_id, created_at) in [
            ("late-evening", ms("2026-01-11T02:30:00Z")),
            ("after-midnight", ms("2026-01-11T03:30:00Z")),
        ] {
            sqlx::query("UPDATE llm_calls SET created_at_ms = ? WHERE call_id = ?")
                .bind(created_at)
                .bind(call_id)
                .execute(&store.pool)
                .await
                .unwrap();
        }

        let overview = store
            .overview(
                Some(ms("2026-01-10T03:00:00Z")),
                Some(ms("2026-01-12T03:00:00Z")),
                None,
                Some(DAY_MS),
                Some(-180),
            )
            .await
            .unwrap();

        let buckets: Vec<(i64, i64)> = overview
            .token_usage_series
            .iter()
            .map(|bucket| (bucket.bucket_start_ms, bucket.input_tokens))
            .collect();
        assert_eq!(
            buckets,
            vec![
                (ms("2026-01-10T03:00:00Z"), 1),
                (ms("2026-01-11T03:00:00Z"), 2),
            ]
        );
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib store::overview`
Expected: compile errors: `token_usage_buckets` takes 3 arguments but 4 were supplied, `utc_offset_ms` not found, and `overview` takes 4 arguments but 5 were supplied.

- [ ] **Step 3: Implement in the store**

In `server/src/store/overview.rs`:

1. Add next to the other constants:

```rust
const MAX_UTC_OFFSET_MINUTES: i32 = 14 * 60;
```

2. Change the signature of `Store::overview` and compute the offset at the top of the body:

```rust
    pub async fn overview(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        model_hashes: Option<&str>,
        bucket_ms: Option<i64>,
        utc_offset_minutes: Option<i32>,
    ) -> Result<Overview> {
        let offset_ms = utc_offset_ms(utc_offset_minutes);
```

3. Replace the `token_usage_buckets` call:

```rust
        let (token_usage_granularity, bucket_ms, series_start_ms, bucket_count) =
            token_usage_buckets(start_ms, end_ms, bucket_ms, offset_ms);
```

4. In the series query, replace the first selected expression so the bucket is cut in local time and reported as a UTC instant:

```rust
                ((created_at_ms + {offset_ms}) / {bucket_ms}) * {bucket_ms} - {offset_ms} AS bucket_start_ms,
```

5. Replace the whole `token_usage_buckets` function with the following, and add the two helpers after it:

```rust
fn token_usage_buckets(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    requested_bucket_ms: Option<i64>,
    offset_ms: i64,
) -> (TokenUsageGranularity, i64, i64, i64) {
    if let (Some(start_ms), Some(end_ms)) = (start_ms, end_ms) {
        let duration_ms = end_ms.saturating_sub(start_ms).max(1);
        let explicit_bucket_ms = requested_bucket_ms.filter(|bucket_ms| *bucket_ms >= MINUTE_MS);
        let bucket_ms = explicit_bucket_ms.unwrap_or({
            if duration_ms <= HOUR_MS {
                MINUTE_MS
            } else if duration_ms <= MAX_RANGE_BUCKETS * HOUR_MS {
                HOUR_MS
            } else {
                DAY_MS
            }
        });
        let granularity = if bucket_ms < HOUR_MS {
            TokenUsageGranularity::Minute
        } else if bucket_ms < DAY_MS {
            TokenUsageGranularity::Hour
        } else {
            TokenUsageGranularity::Day
        };
        let max_buckets = if explicit_bucket_ms.is_some() {
            MAX_EXPLICIT_BUCKETS
        } else {
            MAX_RANGE_BUCKETS
        };
        let last_bucket_ms = bucket_floor(end_ms.saturating_sub(1), bucket_ms, offset_ms);
        let first_bucket_ms = bucket_floor(start_ms, bucket_ms, offset_ms);
        let bucket_count =
            ((last_bucket_ms - first_bucket_ms).div_euclid(bucket_ms) + 1).clamp(1, max_buckets);
        let series_start_ms =
            last_bucket_ms.saturating_sub((bucket_count - 1).saturating_mul(bucket_ms));
        return (granularity, bucket_ms, series_start_ms, bucket_count);
    }

    let today_start_ms = bucket_floor(Utc::now().timestamp_millis(), DAY_MS, offset_ms);
    let series_start_ms = today_start_ms.saturating_sub(
        i64::try_from(OVERVIEW_DAYS - 1)
            .unwrap_or(0)
            .saturating_mul(DAY_MS),
    );
    (
        TokenUsageGranularity::Day,
        DAY_MS,
        series_start_ms,
        i64::try_from(OVERVIEW_DAYS).unwrap_or(0),
    )
}

fn utc_offset_ms(utc_offset_minutes: Option<i32>) -> i64 {
    i64::from(
        utc_offset_minutes
            .unwrap_or(0)
            .clamp(-MAX_UTC_OFFSET_MINUTES, MAX_UTC_OFFSET_MINUTES),
    ) * MINUTE_MS
}

fn bucket_floor(timestamp_ms: i64, bucket_ms: i64, offset_ms: i64) -> i64 {
    timestamp_ms
        .saturating_add(offset_ms)
        .div_euclid(bucket_ms)
        .saturating_mul(bucket_ms)
        .saturating_sub(offset_ms)
}
```

- [ ] **Step 4: Update the three callers**

`server/src/store/llm_calls.rs`, in `plugin_calls_record_without_a_model_config_row`:

```rust
        let overview = store
            .overview(None, None, Some(&format!("[\"{plugin_model}\"]")), None, None)
            .await
            .unwrap();
```

`server/src/control/service.rs`, replace `ControlService::overview`:

```rust
    pub async fn overview(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        model_hashes: Option<&str>,
        bucket_ms: Option<i64>,
        utc_offset_minutes: Option<i32>,
    ) -> Result<Overview> {
        self.store
            .overview(start_ms, end_ms, model_hashes, bucket_ms, utc_offset_minutes)
            .await
    }
```

`server/src/control/overview.rs`, replace `OverviewRange` and `get`:

```rust
#[derive(Debug, Default, Deserialize)]
pub struct OverviewRange {
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    model_hashes: Option<String>,
    bucket_ms: Option<i64>,
    utc_offset_minutes: Option<i32>,
}

pub async fn get(
    State(service): State<ControlService>,
    Query(range): Query<OverviewRange>,
) -> Result<Json<Overview>> {
    Ok(Json(
        service
            .overview(
                range.start_ms,
                range.end_ms,
                range.model_hashes.as_deref(),
                range.bucket_ms,
                range.utc_offset_minutes,
            )
            .await?,
    ))
}
```

- [ ] **Step 5: Find any caller this plan missed**

Run: `CARGO_TARGET_DIR=target/devin-test cargo check -p cursor-server --all-targets`
Expected: success. If it reports another `overview(` call with four arguments, add a trailing `None`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib store::`
Expected: PASS.

- [ ] **Step 7: Run fmt, clippy, and the whole suite**

```bash
cargo fmt --all -- --check
CARGO_TARGET_DIR=target/devin-test cargo clippy -p cursor-server --all-targets -- -D warnings
CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --all-targets
```

Expected: all three succeed.

- [ ] **Step 8: Commit**

```bash
git add server/src/store/overview.rs server/src/store/llm_calls.rs server/src/control/overview.rs server/src/control/service.rs
git commit -m "Cut overview token buckets at the caller's local boundaries"
```

---

### Task 6: Desktop sends its offset and reads day buckets in local time

The desktop app has no unit-test runner; `npm run check` (type-check plus build) is the automated gate, followed by a manual check.

**Files:**
- Modify: `apps/desktop/src/shared/api.ts:502-512`
- Modify: `apps/desktop/src/features/home/HomePage.tsx:21-35`
- Modify: `apps/desktop/src/features/home/charts/DailyTokenUsageChart.tsx:40-56`

**Interfaces:**
- Consumes: `GET /overview?utc_offset_minutes=<int>` from Task 5; `bucket_start_ms` is the UTC instant of a local bucket start.
- Produces: nothing used by later tasks.

- [ ] **Step 1: Send the offset on every overview request**

In `apps/desktop/src/shared/api.ts` replace the `overview` entry of `api` with:

```ts
  overview: (filter?: { startMs: number; endMs: number; modelHashes?: string[]; bucketMs?: number }) => {
    const params = new URLSearchParams({ utc_offset_minutes: String(-new Date().getTimezoneOffset()) });
    if (filter) {
      params.set("start_ms", String(filter.startMs));
      params.set("end_ms", String(filter.endMs));
      if (filter.modelHashes?.length) params.set("model_hashes", JSON.stringify(filter.modelHashes));
      if (filter.bucketMs) params.set("bucket_ms", String(filter.bucketMs));
    }
    return request<Overview>(`/overview?${params.toString()}`);
  },
```

- [ ] **Step 2: Key the activity calendar by local date**

In `apps/desktop/src/features/home/HomePage.tsx` replace the `contributionCalendarData` function with the following. `DAY_MS` is no longer used by this function; delete the `const DAY_MS = ...` line if `npm run check` reports it unused, otherwise leave it.

```ts
function localDateKey(value: Date) {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

function contributionCalendarData(overview: Overview, endMs: number) {
  const tokensByDate = new Map<string, number>();
  for (const bucket of overview.token_usage_series) {
    const date = localDateKey(new Date(bucket.bucket_start_ms));
    const tokens = bucket.input_tokens + bucket.cache_read_tokens + bucket.cache_write_tokens + bucket.output_tokens;
    tokensByDate.set(date, (tokensByDate.get(date) ?? 0) + tokens);
  }
  const lastDay = new Date(Math.max(0, endMs - 1));
  lastDay.setHours(0, 0, 0, 0);
  return Array.from({ length: CALENDAR_DAYS }, (_, offset) => {
    const day = new Date(lastDay);
    day.setDate(lastDay.getDate() - (CALENDAR_DAYS - 1) + offset);
    const date = localDateKey(day);
    return { date, tokens: tokensByDate.get(date) ?? 0 };
  });
}
```

`ContributionCalendarChart.tsx` parses these `YYYY-MM-DD` strings as UTC only to lay out the grid, which stays self-consistent; do not change it.

- [ ] **Step 3: Label day buckets in local time**

In `apps/desktop/src/features/home/charts/DailyTokenUsageChart.tsx` replace `formatDay` and `formatAxisLabel` with:

```ts
function formatDay(value: Date) {
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatAxisLabel(bucketStartMs: number, granularity: TokenUsageGranularity) {
  const value = new Date(bucketStartMs);
  if (granularity === "minute") return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  if (granularity === "hour") return `${pad(value.getHours())}:00`;
  const day = value.getDay();
  if (day === 6) return t("Saturday");
  if (day === 0) return t("Sunday");
  return formatDay(value);
}
```

(`pad` already exists between the two functions; the block above shows all three so the replacement is unambiguous. Do not duplicate `pad`.)

- [ ] **Step 4: Type-check and build**

Run from `apps/desktop`: `npm run check`
Expected: success, with no i18n catalog changes (no `t()` strings were added or changed).

- [ ] **Step 5: Manual check in the running app**

Start the desktop dev build (`npm run tauri:dev` from `apps/desktop`), open Overview, choose "Today", and confirm:
- the last bar of the chart is labelled with today's local date and contains calls made since local midnight;
- the rightmost cell of the activity calendar is today's local date;
- a call made between local midnight and the UTC day change appears under the correct local day.

Record what was observed in the commit body. If the dev build cannot be started in this environment, say so in the commit body instead of claiming the check passed.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/api.ts apps/desktop/src/features/home/HomePage.tsx apps/desktop/src/features/home/charts/DailyTokenUsageChart.tsx
git commit -m "Send the local UTC offset to the overview and read day buckets in local time"
```
