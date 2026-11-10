# Real Tokenizer for Context Estimates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the characters divided-by-4 context estimate with a real BPE count, so compaction decisions and the Cursor context breakdown are accurate for code and non-Latin text.

**Architecture:** One tokenizer, `bpe_openai::o200k_base`, used by both estimators in the server: `model::token_count` (compaction) and `cursor::services::usage` (the checkpoint breakdown Cursor displays). `compaction::trim_to_context` stops re-tokenizing the whole remaining history at every turn boundary and keeps a running suffix sum instead. Test fixtures that build oversized text with a repeated single character switch to a repeated two-character unit that tokenizes densely, so they keep exercising the same paths at similar margins.

**Tech Stack:** Rust, `bpe-openai` 0.3.2.

**Spec:** `docs/superpowers/specs/2026-11-09-ui-redesign-design.md`, "Step 1: token accuracy". The spec names `tiktoken-rs`; this plan uses `bpe-openai` 0.3.2 (MIT, GitHub rust-gems, published 2026-10-08). Measured rationale in debug builds: an unbroken 4 MiB string costs tiktoken-rs ~6.9 s versus ~0.7 s. The tiktoken merge step is super-linear on whitespace-free text, exactly what pasted minified files and base64 blobs look like. Counts are identical on every fixture tried (prose, code, CJK, repeated single characters, 4 MiB base64, and special-token-looking text).

**Baseline:** branch `token-usage-accuracy` at `0a5e949`. Tasks build on that state; the plan for token-usage accuracy (Tasks 1–6 of `2026-11-09-token-usage-accuracy.md`) is already merged into this branch.

## Global Constraints

- Same verification as the previous plan: `cargo fmt --all -- --check` (only the two pre-existing drifted files may be flagged), `cargo clippy -p cursor-server --all-targets -- -D warnings`, `cargo test -p cursor-server --all-targets` with `CARGO_TARGET_DIR=target/devin-test`. Gate: no new failures versus the four known pre-existing ones.
- No new code comments except where this plan specifies.
- Do not change `CONTEXT_RESERVE_DIVISOR`, `OUTPUT_TOKENS`, message/tool/image overheads, or the public estimator signatures. Only the text-counting primitive changes.
- `bpe_openai::o200k_base()` returns a lazily loaded static; call it per use, do not add our own caching or `OnceLock`.
- Keep test fixtures deterministic: exact token counts are pinned only in the new unit tests, never in integration tests.

## Review Focus

1. `Measure::add` previously tracked `characters` (UTF-16 units) plus a heuristic token weight. The `character_count` protobuf field must still report UTF-16 length after the change. Test in Task 3.
2. The `conversation` category's token estimate is always overwritten by the remainder formula (`estimates[CONVERSATION] = total - sum(specials)`), so its text must NOT be tokenized — that would cost ~0.7 s per 4 MiB tool result per checkpoint for a value that is discarded. Verify in Task 3 that conversation text goes through a characters-only path.
3. `trim_to_context` walks `history.iter().enumerate().rev()` and re-estimates `&history[index..]` at each turn boundary — quadratic tokenization. The running-sum rewrite must produce identical keep/cut decisions. Task 2.
4. Fixtures sized to the old estimate: `"x".repeat(400_000)` is ~100k units under chars÷4 but ~50k under BPE. Every site that must stay over a budget is listed in Task 4 with its exact threshold arithmetic.
5. `estimate_text_tokens` currently trims, adds the newline count, and `.max(1)`s. BPE counts whitespace and newlines natively, so all three go away; empty input must still return 0.

---

### Task 1: Swap the text estimator to `o200k_base`

**Files:**
- Modify: `server/Cargo.toml` (add `bpe-openai = "0.3.2"` after `base64`)
- Modify: `server/src/model/token_count.rs` (`estimate_text_tokens`, plus tests)

**Interfaces:** `estimate_text_tokens(&str) -> u64` stays private. `estimate_context_tokens` and `estimate_projected_messages_tokens` signatures unchanged.

- [ ] **Step 1: Add the dependency**

Run `cargo add bpe-openai@0.3.2 -p cursor-server`. Verify `server/Cargo.toml` gained `bpe-openai = "0.3.2"` in the `[dependencies]` block and `Cargo.lock` gained `bpe-openai`, `bpe`, `either`, `regex-automata`, `rmp-serde`, `unicode-normalization` (some may already exist).

- [ ] **Step 2: Write the failing tests**

Append to `mod tests` in `server/src/model/token_count.rs`:

```rust
    #[test]
    fn text_estimate_uses_real_bpe_counts() {
        // o200k_base counts, pinned for regression.
        assert_eq!(estimate_text_tokens(""), 0);
        assert_eq!(estimate_text_tokens("hello world"), 2);
        assert_eq!(estimate_text_tokens("你好，世界"), 3);
        // Repeated "x " is one token per pair plus a trailing-space token.
        assert_eq!(estimate_text_tokens(&"x ".repeat(200_000)), 200_001);
    }

    #[test]
    fn code_and_cjk_are_not_underestimated() {
        let code = "fn main() { println!(\"héllo 世界\"); }\n".repeat(10_000);
        let cjk = "你好，世界。这是一个用于测试分词器的中文句子。".repeat(10_000);
        // The old estimate returned ~chars/4; the real count is far higher for these.
        assert!(estimate_text_tokens(&code) > code.chars().count() as u64 / 3);
        assert!(estimate_text_tokens(&cjk) > cjk.chars().count() as u64 / 2);
    }
```

- [ ] **Step 3: Verify they fail**

`CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib model::token_count` — the new tests fail (e.g. `left: 3`, `right: 2` or the thresholds fail); the three existing estimator tests still pass (they only assert inequalities).

- [ ] **Step 4: Implement**

Replace the whole `estimate_text_tokens` function:

```rust
fn estimate_text_tokens(text: &str) -> u64 {
    bpe_openai::o200k_base().count(text) as u64
}
```

If `count` returns a different integer type or the accessor signature differs from `o200k_base() -> &'static impl`, adapt to the crate's actual API; the contract is one call per text, no global state.

- [ ] **Step 5: Verify**

Same command; all tests pass. Then `cargo test -p cursor-server --lib` — the whole lib suite except the pre-existing failures must pass (the compaction unit tests that use `"x".repeat(...)` may regress; if any do, report it — Task 2/4 fixes them, do not adjust them here).

- [ ] **Step 6: Commit**

```bash
git add server/Cargo.toml Cargo.lock server/src/model/token_count.rs
git commit -m "Count context tokens with o200k instead of characters divided by four"
```

---

### Task 2: `trim_to_context` keeps a running suffix sum

**Files:**
- Modify: `server/src/run/compaction.rs` (`trim_to_context`, the unit fixture at the "newest turn alone exceeds the budget" test)

**Interfaces:** unchanged signatures.

- [ ] **Step 1: Write the failing-equivalence test**

First update the oversized fixture in `compaction_history_keeps_the_newest_turn_even_when_it_is_over_budget`: change `user("u2", &"x".repeat(400_000))` to `user("u2", &"x ".repeat(50_000))`. Budget math: `context_budget(50_000) = 45_000`, minus `OUTPUT_TOKENS` 4_096 = 40_904; the single turn now estimates ~50k > 40.9k, so the path still exercises "newest turn kept anyway". Run it: passes (it may already pass at ~50k under chars÷4 too; that is fine, the fixture is made explicit rather than margin-dependent).

Add a new test asserting the running-sum rewrite matches a brute-force slice sum:

```rust
    #[test]
    fn trim_keeps_whole_turns_matching_a_brute_force_suffix_sum() {
        let history = vec![
            user("u1", &"x ".repeat(30_000)),
            assistant("a1", "answer"),
            user("u2", "small"),
            assistant("a2", "answer"),
            user("u3", &"x ".repeat(20_000)),
        ];
        // context_budget(50_000) - OUTPUT_TOKENS = 40_904
        let prepared = compaction_history(history.clone(), Some(50_000));
        // Find by brute force the smallest index set the old loop would keep:
        // walk turn boundaries newest-first, stop when suffix estimate > budget.
        let budget = context_budget(50_000) - OUTPUT_TOKENS;
        let mut expected_start = history.len();
        let mut newest_turn = history.len() - 1;
        for (index, message) in history.iter().enumerate().rev() {
            if !is_turn_boundary(message) {
                continue;
            }
            newest_turn = index;
            if estimate_projected_messages_tokens(&history[index..]) > budget {
                break;
            }
            expected_start = index;
        }
        if expected_start == history.len() {
            expected_start = newest_turn;
        }
        let expected: Vec<_> = history[history.len() - expected_start..].to_vec();
        // compaction_history appends the instruction user message; compare the kept history head.
        assert_eq!(&prepared[..expected.len()], &expected[..]);
        assert_eq!(prepared.last().unwrap().role, Role::User);
    }
```

Wait — check the actual semantics before writing: the old code sets `kept = history.len() - index` AFTER the over-budget check passes? Re-read the loop: `if estimate(&history[index..]) > budget { break; } kept = history.len() - index;` — so a boundary whose suffix already exceeds the budget is NOT kept; the loop stops and `kept` retains the previous boundary. If the very newest boundary is over budget, `kept == 0` → keep newest turn anyway. Mirror that exactly in the test: compute `expected_start` as the last boundary index whose suffix fit; if none fit, newest turn. Simpler: just call the production function twice? No — write the test as a fixed assertion instead (deterministic and clearer):

```rust
    #[test]
    fn trim_keeps_whole_turns_by_running_suffix_sum() {
        // u1+rest ≈ 30k+overhead over, u2.. ≈ 20k+under. Newest fitting suffix keeps u2 onward.
        let history = vec![
            user("u1", &"x ".repeat(30_000)),
            assistant("a1", "answer"),
            user("u2", "small"),
            assistant("a2", "answer"),
            user("u3", &"x ".repeat(20_000)),
        ];
        let prepared = compaction_history(history, Some(50_000));
        assert_eq!(prepared.first().unwrap().message_id, "u2");
        assert_eq!(prepared.last().unwrap().role, Role::User);
    }
```

(If the `user`/`assistant` test helpers have a different shape than `CanonicalMessage::text`, copy the exact helper usage already present in the module — line ~380 shows `user("u1", "old")` and `assistant("a1", "old answer")` exist.) Run the whole `compaction::` test filter: this new test must pass under the CURRENT quadratic implementation too — it is a characterization test, not a fail-first test. That is intended: the change is a refactor with identical semantics.

- [ ] **Step 2: Implement the running sum**

Replace the loop body of `trim_to_context` (from `let mut kept = 0;` through `history.split_off(history.len() - kept)`):

```rust
    // Walk back from the newest turn, keeping whole user-delimited turns. The
    // per-message estimate is additive, so a running suffix sum decides the same
    // boundaries as re-estimating history[index..] each time.
    let mut kept = 0;
    let mut newest_turn = None;
    let mut suffix_tokens = 0_u64;
    for (index, message) in history.iter().enumerate().rev() {
        suffix_tokens = suffix_tokens.saturating_add(estimate_message_tokens_shim(message));
        if !is_turn_boundary(message) {
            continue;
        }
        newest_turn.get_or_insert(index);
        if suffix_tokens > budget {
            break;
        }
        kept = history.len() - index;
    }
```

`estimate_message_tokens` is private to `token_count.rs`; do NOT widen its visibility for one call site. Instead expose it cleanly: in `token_count.rs` change `fn estimate_message_tokens` to `pub(crate) fn estimate_message_tokens` (it is already re-exported via `model::mod` glob `pub(crate) use token_count::*`). Then the shim line becomes `estimate_message_tokens(message)` imported alongside the other estimators. Exact same behavior, single tokenization pass.

- [ ] **Step 3: Verify**

`CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib run::compaction` — all pass, including the pre-existing threshold tests that were updated in Step 1.

- [ ] **Step 4: Commit**

```bash
git add server/src/run/compaction.rs server/src/model/token_count.rs
git commit -m "Tokenize the compaction history once when trimming to the context budget"
```

---

### Task 3: Breakdown categories use real tokens; conversation text stays characters-only

**Files:**
- Modify: `server/src/cursor/services/usage.rs`

**Interfaces:** `breakdown(...)` signature unchanged. `Measure` gains a characters-only path.

- [ ] **Step 1: Write the failing test**

Append `mod tests` to `usage.rs` (the file currently has none):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn special_categories_use_real_token_counts() {
        let snapshot = breakdown(
            1_000,
            200_000,
            None,
            "hello world",
            &[],
            &HashSet::new(),
            &[CanonicalMessage::text(
                "m1",
                crate::model::Role::User,
                Origin::Runtime,
                "x ".repeat(500),
            )],
        )
        .unwrap();
        let by_id = |id: &str| {
            snapshot
                .categories
                .iter()
                .find(|category| category.id == id)
                .unwrap()
        };
        // "hello world" = 2 o200k tokens (chars/4 would give 2 as well; pick a case where they differ).
        assert_eq!(by_id("system_prompt").estimated_tokens, 2);
        // Conversation is the remainder, not a measured value.
        assert_eq!(by_id("conversation").estimated_tokens, 998);
        // Character counts still report UTF-16 length.
        assert_eq!(by_id("system_prompt").character_count, Some(11));
        assert_eq!(by_id("conversation").character_count, Some(1_000));
    }
}
```

Adjust `CanonicalMessage::text`'s argument order/Origin variant to the real signature (used as `CanonicalMessage::text("old", Role::User, Origin::Runtime, "x".repeat(400_000))` in compaction tests — mirror that). Run it: FAILS — `system_prompt` shows the old ~0.273×chars weight ≈ 3 and `conversation` ≈ 274 instead of exact counts.

- [ ] **Step 2: Implement**

In `Measure`:

```rust
impl Measure {
    /// Text whose token estimate feeds a special (fitted) category.
    fn add(&mut self, text: &str) {
        self.add_characters(text);
        self.token_units += bpe_openai::o200k_base().count(text) as u64;
    }

    /// Text whose tokens are discarded by the remainder formula — characters only.
    fn add_characters(&mut self, text: &str) {
        self.characters += text.encode_utf16().count() as u64;
    }
}
```

Rename `token_units` semantics: it is now a real token count, so `estimated_tokens()` becomes `self.token_units` (no ÷1000). Update `estimated_tokens` accordingly and remove the per-character weight loop.

Route EVERY `measures[CONVERSATION].add(...)` call site through `add_characters` (all of them in `measure_message` — the non-runtime text part, assistant text, thinking, tool-call JSON, and tool-result JSON — and both in `measure_runtime`). Every other category (`SYSTEM`, `TOOLS`, `RULES`, `SKILLS`, `MCP`, `SUBAGENTS`, `SUMMARY`) keeps `add` — now tokenized.

- [ ] **Step 3: Verify**

`CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --lib cursor::services::usage` passes. Then the full lib suite.

- [ ] **Step 4: Commit**

```bash
git add server/src/cursor/services/usage.rs
git commit -m "Show real token counts in the context breakdown Cursor displays"
```

---

### Task 4: Resize oversized fixtures to the real counts

**Files:**
- Modify: `server/tests/compaction.rs` (two sites: ~line 230 seed answer, ~line 465 overflow request)
- Modify: `server/tests/interrupt.rs` (~line 1384 `seed_answer`)

**Interfaces:** none.

- [ ] **Step 1: Update each fixture with its arithmetic**

| Site | Old size (est.) | Requirement | New |
|---|---|---|---|
| `compaction.rs` ~230 `text_response(&"x".repeat(400_000), 150_000, 1_000)` | ~100k > 90k budget (window 100k) | The seed answer is later summarized away; its size only needs to be plausibly large, but keep it honestly oversized | `"x ".repeat(200_000)` → ~200k tokens |
| `compaction.rs` ~465 `&"x".repeat(400_000)` in `irreducibly_oversized_current_input_fails_before_provider_dispatch` | ~100k > 90k budget | Must stay over `context_budget(100_000) = 90_000` after the swap | `"x ".repeat(200_000)` → ~200k |
| `interrupt.rs` ~1384 `"x".repeat(400_000)` | ~100k > 90k budget | Same | `"x ".repeat(200_000)` |

Leave `compaction.rs` ~392 (`anchor` test, window 200k) unchanged: the estimate must stay under `context_budget(200_000) = 180_000` and ~50k qualifies either way. Leave `tool_round.rs` ~891 (the 4 MiB read result) unchanged: it is a tool-result path, not an estimate gate, and bpe handles it in ~0.7 s debug.

- [ ] **Step 2: Run the integration suites**

`CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --test compaction --test interrupt --test tool_round` — all pass. If a test times out or an assertion now fails because a number crossed a threshold (e.g. `used_tokens` checks, `token_delta` events), investigate before editing: the fix is in the fixture, not the production code.

- [ ] **Step 3: Full gate**

```bash
cargo fmt --all -- --check
CARGO_TARGET_DIR=target/devin-test cargo clippy -p cursor-server --all-targets -- -D warnings
CARGO_TARGET_DIR=target/devin-test cargo test -p cursor-server --all-targets
```

No new failures beyond the four pre-existing ones.

- [ ] **Step 4: Commit**

```bash
git add server/tests/compaction.rs server/tests/interrupt.rs
git commit -m "Resize oversized test fixtures for real token counts"
```

---

## Done Criteria

- `estimate_text_tokens`, `Measure::add`, and `trim_to_context` all run through `bpe_openai::o200k_base`.
- All server tests pass except the four pre-existing environment failures.
- No fixture or production path still depends on the chars÷4 heuristic.
- Post-checkpoint breakdown costs are bounded: only special categories are tokenized; conversation remains characters-only.
