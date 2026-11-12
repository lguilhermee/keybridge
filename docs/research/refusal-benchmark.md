# Refusal detector comparison on retained Cursor and Keybridge history

This records the frozen initial baseline. The later
[garak follow-up](refusal-garak-followup.md) adds confirmed missed wording and
records a separate full-corpus replay without rewriting these measurements.

Completed locally on 2026-11-12. **Keep the current source detector; do not integrate
either candidate as-is.** In this tested pipeline, both learned models produced
more false switches and missed more reviewed historical refusals. This is a
comparison on a small, provisional labeled subset, not proof that no external
model can outperform Keybridge.

The models were downloaded and executed locally:
[Qwen3Guard-Gen-0.6B](https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B) and
[garak's refusal detector](https://huggingface.co/garak-llm/garak-refusal-detector).
Neither was installed into the application. The running desktop and its settings
were preserved; its health endpoint still returned HTTP 204 after the benchmark.

## Scope and evidence

Extraction produced **176,762 distinct historical responses**, plus **46 artificial
controls**. The user selected **all identified denial candidates plus false-positive
controls** instead of completing the much slower full-corpus Qwen replay.
Both models finished **all 3,132 selected cases**: 3,086 historical candidates and
46 controls, with **zero inference/label errors**. Candidate predictions alone are
not ground truth.

The shortlist includes broad denial cues anywhere in assistant-owned prose,
current-detector positives, recorded protocol refusal finishes containing text,
and every frozen label/control. It is not restricted to the opening paragraph.
Its heuristic selection can still miss unknown refusal wording outside the pool.

| Retained source | Coverage |
| --- | ---: |
| Cursor main composer/bubble store | 5,618 composers; 1,721,472 bubbles; 198,505 assistant text observations |
| Cursor JSONL agent transcripts | 5,870 files; 197,449 assistant text observations |
| Keybridge canonical history | 155,915 user/assistant rows inspected; 32,352 assistant text observations |
| Keybridge recorded terminal attempts | 3,027 attempts inspected; 91 with recoverable response text |
| Retained Keybridge database backup | 227 assistant records; 29 text observations |
| Cursor legacy global/workspace databases | 306 checked |

Counts overlap across sources. Deduplication uses trimmed response text with
normalized CRLF, not conversation identity. It preserves source references and
uses the first recoverable preceding user prompt. Different prompts associated
with an identical answer are not separately evaluated. Orphan Cursor bubbles are
retained without inventing user context. Derived compaction Markdown is excluded.
Search-index mixed-role text is not treated as a separate assistant-response source.

Keybridge had 838 recorded protocol refusal finishes, but only **8 contained
recoverable text**; 830 could not be classified as text. A refusal finish is not
itself a reviewed positive: some textful attempts contain only preparatory work.
The corpus also contains intermediate assistant updates, not only final answers.
This covers the retained sources inspected, not deleted or inaccessible history.

## Measured classification results

**91 historical cases received provisional agent review:** 23 task refusals and
68 negatives, including capability limits, ordinary implementation choices,
successful completion, and descriptions of refusals. A deterministic hash-ordered
75-case cue shortlist was reviewed, then 16 additional Portuguese cases.
Labels were assigned before inspecting the corresponding model predictions.
Review used historical excerpts and available context; it was performed through
Codex, not independent human adjudication. The enriched selection and small sample
do not support population accuracy claims.

| Detector | Caught / 23 refusals | False switches / 68 negatives | Precision | Recall | F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current source detector | **17** | **1** | **94.4%** | **73.9%** | **82.9%** |
| Qwen3Guard 0.6B | 15 | 19 | 44.1% | 65.2% | 52.6% |
| garak ModernBERT | 10 | 21 | 32.3% | 43.5% | 37.0% |

The **46 controls** include the three supplied English/Portuguese replies,
late refusals after a long benign prefix, refusals embedded in code/quotations,
and a genuine refusal following a quoted example. Expected labels comprise
24 positives and 22 negatives.

| Detector | Caught / 24 positives | False switches / 22 negatives |
| --- | ---: | ---: |
| Current source detector | **23** | **1** |
| Qwen3Guard 0.6B | 24 | 16 |
| garak ModernBERT | 3 | 19 |

All three literal screenshot refusals were recognized by the source detector and
Qwen; garak missed all three. The controls are correlated: after filtering,
46 controls represent only **35 distinct Qwen prompt/prose inputs**. They should
not be presented as 46 independent observations.

The unlabelled selected historical cases produced 170 baseline, 697 Qwen, and
738 garak positive predictions. These counts identify review candidates; they do
not establish which detector has the best recall over all retained history.

## Tested input and runtime

```text
Retained databases / JSONL files (read-only)
  -> private corpus: response + preceding user + provenance
    -> production Markdown/quotation ownership filter
      -> current production refusal decision
      -> Qwen: official prompt/response template -> Refusal Yes/No
      -> garak: response classifier -> refusal/non-refusal
        -> bounded windows -> one decision per response
          -> private scores/review extracts -> aggregate report in this repo
```

Every classifier saw the same filtered assistant prose for the main comparison.
Qwen additionally received the last **2,048 tokens** of the preceding user prompt
when recoverable. This is not a full conversation replay: system messages,
tool results, images, and other conversation context were not supplied.
248 selected prompts exceeded that bound; the largest omission was 376,150
tokens. That loss of request context limits Qwen's interpretation of compliance.

Qwen uses the official response-classification template and deterministic decoding,
parsing the explicit **Refusal** field rather than inferring refusal from safety
categories. Garak uses its documented binary label mapping and special-token
template. The upstream interfaces are described in their linked model cards.

Prepared response windows cover the whole filtered response with 128-token
overlap; positive windows aggregate with “any refusal.” Qwen's context bound is
32,768 tokens including output allowance. No selected Qwen response required
multiple windows; its largest prepared input was 18,932 tokens. Garak has an
8,192-token bound; 16 selected replies needed multiple windows, at most three.
Actual native truncation raises an error rather than silently checking a prefix.

The ownership filter can remove evidence that a task was fulfilled, such as a
code block or quoted test fixture. Therefore these measurements describe this
specific integration, not an intrinsic model ranking. Raw, unfiltered controls
were also tested: Qwen produced 16 false positives on 22 negatives, and garak
produced 7 while still missing 21 of 24 positives. Removing the ownership filter
alone does not establish a suitable replacement.

Hardware: RTX 5090 (32,607 MiB), Intel Core Ultra 9 285K, Windows driver 616.64.
Other graphical applications remained active, so measurements are not isolated
performance guarantees. Python 3.12.13, PyTorch 2.11.0+cu128, Transformers 4.57.6;
garak ran BF16. Qwen's replay used official llama.cpp **b12292-af6b5243d CUDA 13.5**
with BF16 weights and F32 normalization weights, without weight quantization.

| Completed replay phase | Newly scored cases | Inference wall time | Latency measurement |
| --- | ---: | ---: | --- |
| Qwen, four 8,192-token slots | 2,930 | 667.1 s | Request p50 762.7 ms; p95 1,708.9 ms |
| Qwen, one 32,768-token slot | 23 | 20.9 s | Request p50 845.8 ms; p95 1,323.2 ms |
| garak, batches up to 32 | 2,123 | 37.2 s | Batch p50 199.4 ms; p95 396.2 ms |

Previously completed scores fill the rest of the selected pool. These timings
exclude preparation/load and are different workloads; batch latency is not
single-request latency. Early broader replay results remain in the private data:
20,224 Qwen and 90,350 garak cases were scored in total. Neither count is a
complete replay of the final 176,808-case corpus.

## Reproducibility and remaining defects

Pinned upstream revisions:

```text
Qwen: fada3b2f655b89601929198343c94cd2f64d93cc
garak: 5cb5ec8f364318cc48724ddf8ad414000c36781b
GGUF converter: llama.cpp dd6b945be2188da875ab05a259ce94c6b2736e64
Qwen BF16 GGUF SHA256:
18f9b2684d0113f134cb480c2bbd60867e0d8e315148a5f7040c2f4a6e41bcf8
Native runtime ZIP SHA256:
f173b246ab8d7e55c13024fdf53192d5b6a0c333042c37724c38d4c333cb92be
CUDA runtime ZIP SHA256:
c2bf4cc202bfbaaa7a0b75f5082457c3811326947bb216059b72839d844e9cba
Baseline source SHA256:
2452676f74f07a559a1a3f9e68cf555864dbf9d14cfe5c92c064be5f4e24b0cf
Selected-case identity SHA256:
867bee864f422195239e4eb2e98d9a8724ea9ac03258e1c8eb27dbc66870922d
```

The minimal Rust adapter imports the actual production detector. After rebuilding
it with pinned parser dependencies, **137/137 labeled cases matched** the saved
baseline decision and filtered prose. Qwen's native/PyTorch labels matched on
**46/46 filtered controls** and **45/46 raw controls**. The raw discrepancy was a
Portuguese fenced-code negative; this small parity check is not proof of numerical
equivalence on the full corpus. Garak's three literal screenshot misses were
also reproduced through the standard Transformers pipeline in BF16 and FP32.

The source detector still missed six reviewed historical refusals. Two controlled
ownership defects also remain: multi-paragraph HTML blockquotes can leak quoted
text into prose, and nested ASCII quotations can consume a subsequent real
refusal. They were recorded without tuning the frozen baseline against this test
set. “Always switches correctly” is not established by these results.

```text
tools/refusal-benchmark/               # Reproducible extraction, scoring, and checks
server/examples/refusal_benchmark.rs  # Adapter to the production decision/filter
docs/research/
├── refusal-detection.md              # Upstream source review and candidate rationale
├── refusal-benchmark.md              # Measured recommendation and limitations
└── refusal-benchmark-results.json    # Aggregate counts and run metadata; no history text

~/.cursor-byok-v3/benchmarks/refusal-2026-11-11/
├── corpus.sqlite                     # Private history, source references, labels, scores
├── extraction.json                   # Source coverage counters
├── refusal-candidates.jsonl           # All 3,086 selected historical cases and predictions
└── reviewed-refusals.jsonl            # The 23 provisionally reviewed historical positives
```

Raw history remains outside the checkout. Candidate inference ran locally; the
provisional review used excerpts through Codex. See the
[reproduction commands](../../tools/refusal-benchmark/README.md) and
[aggregate results](refusal-benchmark-results.json). Existing automated HTTP tests
cover Medium/Max primary settings and the refusal model's independent settings;
this benchmark adds no live Cursor UI verification and deploys no replacement.
