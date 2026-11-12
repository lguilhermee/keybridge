# Semantic refusal detection

Source review checked on 2026-11-11. The subsequent [local benchmark](refusal-benchmark.md), completed on 2026-11-12, downloaded and ran Qwen and garak against retained history and controls. This document preserves the upstream evidence and the rationale for selecting those candidates.

**Measured recommendation:** do not integrate either candidate as-is. On the provisionally reviewed historical subset, both produced more false switches and missed more refusals than the current source detector. See the [results and limitations](refusal-benchmark.md). Qwen3Guard-Gen-0.6B was selected for English/Portuguese support, with garak's ModernBERTRefusal as the smaller English-focused comparison. Both classify meaning; the ownership filter still determines whose words are being classified.

## Current ownership and execution path

```text
server/src/
├── run/engine.rs                  # Owns the run and each model-call retry
├── run/model_cycle.rs             # Receives provider events; checks completed replies
├── run/refusal_reply.rs           # Holds watched reply text until the call finishes
├── run/refusal_reply/detection.rs # Extracts assistant prose and matches explicit declines
├── run/refusal_fallback.rs        # Selects the configured refusal model for this call
└── store/refusal_fallbacks.rs     # Persists the user's source-model -> refusal-model mapping
```

```text
run starts -> load refusal mapping once
  -> each model call starts on the run's model
    -> provider events -> hold watched text; reasoning still streams
      -> tool call: release held text for this round
      -> completed ordinary answer: Markdown prose -> refusal decision
        -> no refusal: release held text
        -> refusal: retry this call on configured refusal model, using its own settings
  -> next model call starts on the run's model again
```

These are repository facts from the files above. A semantic classifier would replace the text decision inside the completed-reply path; it should not own retry policy, model settings, or persistence.

## Candidates

| Project | Mechanism and evidence | Languages and desktop implications |
| --- | --- | --- |
| **[QwenLM/Qwen3Guard](https://github.com/QwenLM/Qwen3Guard)** | `Gen` consumes prompt + response and emits a separate `Refusal: Yes/No`, alongside safety labels. Sizes: 0.6B, 4B, 8B. The authors report **0.6B refusal F1 93.3 on XSTest / 89.4 on WildGuardTest**; precision **89.2 / 83.1**, recall **97.6 / 96.8**. These numbers are benchmark results, not measured Portuguese performance. [Report, Table 7](https://arxiv.org/html/2510.14276v1#S3.SS4.SSS1) | Official language list includes **English and Portuguese** among 119 languages/dialects. Apache-2.0 weights. Transformers reference implementation and OpenAI-compatible serving examples; generation adds inference work and label parsing. Best first semantic candidate for the requested languages. Use **Gen**, since Stream's token safety classification solves a different integration problem. [Official language list](https://qwenlm.github.io/blog/qwen3guard/), [model card](https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B) |
| **[NVIDIA/garak](https://github.com/NVIDIA/garak/blob/main/garak/detectors/mitigation.py)** | `ModernBERTRefusal` uses `garak-llm/garak-refusal-detector`: 149M-parameter encoder, 8,192-token window, binary semantic classification. Its training covers partial refusals, redirection, and fulfillment with disclaimers. The older `MitigationBypass` / `Prefixes` classes are still string heuristics, not the semantic improvement. | Tagged **English**. External evaluation uses multilingual refusal data, but its documented languages are EN/DE/FR/RU/ES, **not Portuguese**. Model card lists Windows and ONNX Runtime; exported artifact/runtime compatibility still needs checking. Code Apache-2.0; **weights NVIDIA Open Model License**. [Model card](https://huggingface.co/garak-llm/garak-refusal-detector), [evaluation dataset](https://huggingface.co/datasets/s-nlp/multilingual_refusals) |
| **[ProtectAI/llm-guard](https://github.com/protectai/llm-guard/blob/main/llm_guard/output_scanners/no_refusal.py)** | `NoRefusal` uses learned DistilRoBERTa rejection classification; `NoRefusalLight` uses substrings. Card reports validation **F1 .9748 / precision .9596 / recall .9905** on its own dataset. That is not an apples-to-apples comparison with our detector. [Model card](https://huggingface.co/protectai/distilroberta-base-rejection-v1) | **English**, Apache-2.0 weights, MIT library. Published **329 MB ONNX artifact** makes this the clearest native-runtime starting point. Scanner defaults to only **128 tokens**; card example uses 512. Sentence mode flags any rejecting sentence, which can mistake local caveats for rejection of the task. **Repository is archived**, so do not adopt its whole Python stack as a maintained dependency. [Artifacts](https://huggingface.co/protectai/distilroberta-base-rejection-v1/tree/main/onnx), [repository](https://github.com/protectai/llm-guard) |
| **[allenai/wildguard](https://github.com/allenai/wildguard)** | Explicit prompt harmfulness, response harmfulness, and **response refusal** outputs. Research-backed comparison reference, rather than just a toxicity classifier. Python wrapper supports Transformers and vLLM. [README](https://github.com/allenai/wildguard/blob/main/README.md) | **English**, **7B**, Apache-2.0 model; Hugging Face access requires accepting its access conditions. Substantially larger than the encoder candidates and Qwen 0.6B. Portuguese and Windows desktop latency remain unverified. [Model card](https://huggingface.co/allenai/wildguard) |
| **[confident-ai/deepeval](https://github.com/confident-ai/deepeval)** | `RefusalClassifier` is a one-call LLM judge distinguishing complied, refused, and partial refusal. Can use a custom model. Useful as an evaluation comparison and to articulate the label boundary. [Official documentation](https://deepeval.com/docs/classifiers-refusal) | Apache-2.0 framework; language quality, latency, privacy, and request cost depend on the chosen judge. No published Portuguese refusal accuracy was established here. Avoid adding an entire Python evaluation framework to the Rust request path just to reuse this concept. |

Garak's model card contains a discrepancy: its headline benchmark accuracy is **91.10%**, while its table gives **92.06%**, refusal precision **96.08%**, recall **87.69%**. Its reported **1.68 ms/sample** lacks enough serving details to predict a single Windows desktop request. Do not turn either number into a product promise. [Card source](https://huggingface.co/garak-llm/garak-refusal-detector/raw/main/README.md)

Maintenance snapshot: GitHub reported garak unarchived, last push **2026-11-06**; llm-guard archived, last push **2026-07-08**; Qwen3Guard unarchived, last push **2025-10-21**; WildGuard unarchived, last push **2024-12-02**. Dates describe repository activity, not model quality. [garak](https://github.com/NVIDIA/garak), [llm-guard](https://github.com/protectai/llm-guard), [Qwen3Guard](https://github.com/QwenLM/Qwen3Guard), [WildGuard](https://github.com/allenai/wildguard)

An additional research lead is [agentlans/multilingual-e5-small-refusal-classifier](https://huggingface.co/agentlans/multilingual-e5-small-refusal-classifier): about 0.1B parameters, MIT, 512 tokens, role-delimited conversation input, reported accuracy .9153. Its multilingual dataset advertises Portuguese, but its tiny displayed translated-example evaluation omits Portuguese and shows false positives. The card explicitly limits production use without human oversight. Treat it as an experimental comparison, not the default. [Training data](https://huggingface.co/datasets/agentlans/refusal-classifier-data)

## Hypothetical integration, if a future evaluation supports it

```text
server/src/run/refusal_reply/
├── detection.rs  # Preserve assistant-prose ownership extraction; replace phrase decision
└── classifier.rs # Proposed: one bounded semantic classification request
```

Nothing moves or is deleted in this research change. If semantic detection ships, replace the selected decision mechanism rather than introducing a permanent regex/model/judge cascade. `refusal_reply.rs` still owns held events, `refusal_fallback.rs` still owns switching, and the existing store owns the mapping.

For the first experiment, use a resident classifier behind a local endpoint and the existing `reqwest` client: no Python or model runtime is needed inside Tauri. Qwen's official serving examples establish an API shape, **not a verified native Windows deployment**. A self-contained Windows product would additionally need a validated runtime, model packaging, tokenizer/template handling, startup/shutdown ownership, and measured memory/latency. ONNX is attractive for the encoder candidates, but this crate currently has no ONNX dependency. Do not assume an export or quantized variant preserves the source model's scores.

Classify once after completion using the current request and the assistant's own prose. Preserve truncation/omission metadata and test late refusals; silently checking only the start recreates the original miss. A parse error or timeout is an unavailable classification, never proof of refusal. Keep that distinction observable. Because text is held until this decision, classifier latency directly increases the time before the user sees the answer. Local inference consumes memory/compute; remote judging adds network latency and billed requests. The subsequent benchmark records local replay timing, with workload and hardware limitations.

## Evaluation criteria from the initial review

Freeze human labels before running candidates. Include the three supplied English/Portuguese replies and unseen paraphrases, then measure precision/recall separately by language and refusal type. Test full declines, partial completion, redirection, capability limitations, clarification, and a disclaimer followed by successful work. Decide explicitly which of those should trigger the existing mapping.

Negatives must contain the same refusal phrases inside code, Markdown/HTML quotations, prose quotations, documentation, and descriptions of another assistant's behavior. Also include ordinary engineering choices such as declining an unnecessary dependency while completing the task. No reviewed candidate establishes immunity to these false positives. Run both the classifier alone and the full Markdown-to-decision path; record truncation, load failures, label-parse errors, cold/warm memory, and single-request p50/p95 latency on the actual Windows machine. Author benchmark scores cannot establish an improvement on these cases.

Prompt-injection, jailbreak-intent, harmfulness, and AI-written-text detectors answer different questions. A safe response may be either a useful answer or a refusal; a harmful request can receive either. Route on the explicit refusal decision, never infer it from the safety category.
