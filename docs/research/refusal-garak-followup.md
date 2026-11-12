# Refusal wording recovered from garak's correct detections

Implemented and checked on 2026-11-12. The source detector now recognizes **all
13 confirmed historical replies** where garak correctly flagged a refusal and the
frozen Keybridge baseline did not. No learned classifier or model runtime was
added to Keybridge.

The original 91-case reviewed sample had no garak-positive refusals that our
detector missed. Reviewing additional garak-positive/baseline-negative history
found the 13 development cases, including near-duplicate response variants.
These labels were assigned after seeing model predictions, so they are
development examples, not an independent accuracy evaluation.

The added wording covers:

- Declining to “lay out a way” or “lay out the steps.”
- Complete short declines such as “I can't add that,” “I can't set that up,”
  and “I will not plan those.” The clause must end there; “I can't add that
  column until the migration finishes” stays negative.
- Declining to adopt the requested persona.
- Declining to modify, rename, disguise, or continue generating something when
  the same paragraph explicitly states an evasion purpose. A locked file,
  read-only workspace, or internal tool failure does not satisfy that rule.

```text
server/src/run/refusal_reply/detection.rs # Owns prose extraction and refusal rules
  -> completed assistant-owned prose
    -> existing rules + the added refusal wording
      -> existing refusal-model switch and its saved settings

server/tests/refusal_fallback.rs         # Verifies outgoing HTTP settings and switch
tools/refusal-benchmark/compare.py        # Replays changes against the frozen baseline
```

The same ownership filter still runs before all rules. Tests put every added
form inside a code block, a Markdown blockquote, and a prose quotation; those
examples do not trigger fallback. Additional tests cover late refusals and
ordinary capability limits or implementation choices.

## Replay result

The changed detector was replayed against **all 176,808 stored cases**, using the
original private corpus read-only. The original baseline decisions, ownership
filter output, model scores, and review labels were preserved.

| Check | Before | After |
| --- | ---: | ---: |
| Confirmed garak catches recognized | 0 / 13 | **13 / 13** |
| Original reviewed historical refusals caught | 17 / 23 | 17 / 23 |
| False switches on the original historical negatives | 1 / 68 | 1 / 68 |
| Positive controls caught | 23 / 24 | 23 / 24 |
| False switches on negative controls | 1 / 22 | 1 / 22 |

Only **15 decisions changed**, all from negative to positive; there were no
changed ownership-filter outputs. The other two changed responses were also
reviewed as explicit refusals. Those post-change reviews are recorded separately
in the private data. This does not establish population-wide accuracy or eliminate
the previously documented misses and quote-parser edge cases.

Verification passed:

- `cargo fmt --all -- --check`
- `cargo clippy -p cursor-server --all-targets -- -D warnings`
- `cargo test -p cursor-server --all-targets`
- The benchmark's 10 Python tests and Ruff lint/format checks.

The HTTP regressions verify primary **Medium and Max**, refusal-model saved
**high or unset** effort, its own token settings, Fast reset, and the next run
returning to the primary settings. The test suite also exercises the new wording
through the actual run engine and outgoing requests. No live Cursor UI test was
performed.

The follow-up verification preserved the running Keybridge release as requested.
Deploying the checked source into the desktop executable is a separate operation.

## Evidence

[Aggregate replay results](refusal-garak-followup-results.json) include source and
review fingerprints. [Reproduction commands](../../tools/refusal-benchmark/README.md#compare-a-detector-change)
describe the read-only comparison.

```text
~/.cursor-byok-v3/benchmarks/refusal-2026-11-11/
├── corpus.sqlite                       # Frozen original responses, baseline, and scores
├── garak-followup-review.jsonl          # The 13 reviewed garak development cases
├── additional-followup-review.jsonl     # Reviews of the other two changed cases
└── detector-followup-differences.jsonl   # All 15 changed case IDs and decisions
```

Private history and source references remain outside the checkout. The original
[model comparison](refusal-benchmark.md) and its aggregate results remain the
record of the frozen pre-change benchmark.
