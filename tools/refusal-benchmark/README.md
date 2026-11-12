# Local refusal benchmark

This is an offline evaluation tool. It does not install a detector in Keybridge,
change model settings, or update the source databases. Model downloads are public;
classification uses cached weights and a loopback-only native inference server.

```text
tools/refusal-benchmark/
├── models.py          # Pins both upstream model revisions
├── download.py        # Downloads public weights and tokenizer files
├── extract.py         # Reads Cursor/Keybridge history into a private corpus
├── archives.py        # Recovers role-owned text from JSONL and database backups
├── controls.py        # Freezes screenshot examples and adversarial controls
├── candidates.py      # Freezes the denial shortlist plus negative controls
├── compare.py         # Replays changed rules without replacing the frozen baseline
├── classify.py        # Runs the production baseline and PyTorch classifiers
├── qwen_input.py      # Applies one Qwen template and observable context bounds
├── qwen_native.py     # Runs the same Qwen token IDs through local llama.cpp
├── report.py          # Exports aggregate results without private history
├── Cargo.toml         # Builds the production adapter without server dependencies
├── Cargo.lock         # Pins the adapter's dependencies
├── test_extract.py    # Verifies response reconstruction and exclusion of thinking
├── test_archives.py   # Verifies transcript roles and user-prompt ownership
└── test_qwen_input.py # Verifies late-response coverage and cache invalidation

server/examples/refusal_benchmark.rs  # JSONL adapter to the production detector
```

Private application data stays outside the checkout:

```text
~/.cursor-byok-v3/benchmarks/
├── runtime/                    # Python 3.12 and inference dependencies
└── refusal-2026-11-11/
    ├── corpus.sqlite           # Private text, provenance, labels, and scores
    ├── extraction.json         # Source coverage counts
    ├── refusal-candidates.jsonl # Selected historical cases with provenance
    └── reviewed-refusals.jsonl  # Provisionally reviewed positives

~/.cache/huggingface/hub/        # Pinned upstream model artifacts
~/.cache/keybridge-benchmark/    # Native runtime and converted Qwen weights
```

## Reproduce

From the workspace root in PowerShell, create the external runtime and install:

```powershell
$runtime = Join-Path $env:USERPROFILE '.cursor-byok-v3/benchmarks/runtime'
$data = Join-Path $env:USERPROFILE '.cursor-byok-v3/benchmarks/refusal-2026-11-11'
uv venv --python 3.12 $runtime
$python = Join-Path $runtime 'Scripts/python.exe'
uv pip install --python $python torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
uv pip install --python $python transformers==4.57.6 numpy==2.5.4 psutil==7.2.2 sentencepiece==0.2.3 gguf==0.19.0
& $python tools/refusal-benchmark/download.py
& $python tools/refusal-benchmark/extract.py --output $data
& $python tools/refusal-benchmark/controls.py --data $data
```

Build the baseline adapter using the repository's Windows Rust prerequisites.
The standalone manifest compiles the same production source with pinned parser
dependencies, without linking the server. Use the workspace-root target cache;
restore the environment afterward:

```powershell
$previousTarget = $env:CARGO_TARGET_DIR
try {
    $env:CARGO_TARGET_DIR = Join-Path $PWD 'target'
    cargo build --manifest-path tools/refusal-benchmark/Cargo.toml --bin refusal_benchmark
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
}
& $python tools/refusal-benchmark/classify.py --data $data --model baseline --baseline-exe target/debug/refusal_benchmark.exe
& $python tools/refusal-benchmark/candidates.py --data $data
& $python tools/refusal-benchmark/classify.py --data $data --model garak --view prose --candidates-only
& $python tools/refusal-benchmark/classify.py --data $data --model garak --view raw --controls-only --batch-size 1
& $python tools/refusal-benchmark/classify.py --data $data --model qwen --view raw --controls-only --batch-size 4
```

For Qwen, the measured native runtime is official llama.cpp
**b12292, Windows CUDA 13.5**. Both release archives were verified against the
SHA256 digests published by the GitHub release API. Convert the pinned upstream
snapshot with official `convert_hf_to_gguf.py --outtype bf16`; no weight
quantization is used. See the benchmark report for conversion/runtime hashes.

Start the native server on **127.0.0.1:49563**, using the converted model and
`--ctx-size 32768 --parallel 1 --no-kv-unified --flash-attn on --n-gpu-layers 99
--batch-size 8192 --ubatch-size 2048 --no-context-shift --log-disable`. Run:

```powershell
& $python tools/refusal-benchmark/qwen_native.py --data $data --view raw --controls-only --score-model qwen-native-check --workers 1 --token-budget 32768
& $python tools/refusal-benchmark/qwen_native.py --data $data --view prose --candidates-only --workers 1 --token-budget 32768 --run-label=-candidates
& $python tools/refusal-benchmark/report.py --data $data --scope candidates --output docs/research/refusal-benchmark-results.json --require-complete --export-private-candidates
```

Stop the native server after the evaluation. Keep the running Keybridge desktop
unchanged. Remove the adapter executable/PDB after its process exits.

The completed run used four 8,192-token slots for the shorter inputs
(`--ctx-size 32768 --parallel 4 --no-kv-unified`, client `--workers 4
--max-input-tokens 8064 --token-budget 32768 --run-label=-candidates-short`).
It deferred entire replies whose prepared windows exceeded that bound, then
restarted with the single-slot configuration above to finish the 23 long cases.
The simpler single-slot command reproduces the selected scope without bucketing.

## Interpretation and bounds

- Extraction reads the primary Cursor `cursorDiskKV` composer/bubble store and
  checks legacy chat keys in global and workspace `ItemTable` databases. The
  search index is not treated as an independent source: it mixes roles and text.
- JSONL agent transcripts and retained Keybridge database backups add archived
  assistant replies. Compaction Markdown is derived mixed-role text and is
  excluded. Original databases and transcript files are opened read-only.
- Assistant text is extracted; thinking, tool arguments/results, request headers,
  credential settings, and provider replay state are not exported. Historical
  user/assistant text can itself contain secrets, so the corpus stays private.
- BYOK canonical messages cover retained conversations. Recorded terminal
  attempts additionally recover responses excluded from committed history.
  SSE and Devin Connect framing are reconstructed before extracting text.
  Recorded protocol refusal finishes without text cannot be scored as text.
- Exact response text is deduplicated after trimming and normalizing CRLF.
  Qwen uses the first available preceding user prompt for that response.
  Different prompt contexts for an identical response are not separate samples.
- Cursor header order establishes preceding users where available. Orphan
  bubbles are retained, with no invented ordering or prompt. BYOK message
  ordering uses persisted timestamps; recorded calls use their base checkpoint.
- The corpus includes intermediate assistant text as well as final answers.
  A positive prediction is a candidate, not proof a completed task was refused.
- The selected scope is all broad whole-prose denial cues, production detector
  positives, textful protocol refusals, frozen review labels, and controls.
  Selection is heuristic: unknown wording outside the shortlist can be missed.
  The user chose this scope instead of finishing Qwen on the entire corpus.
- `prose` uses the production Markdown/quotation filter. `raw` diagnostic
  controls test the standalone classifiers without that filter.
- Qwen receives up to the last **2,048 tokens** of the user prompt; omissions
  are counted. Every response token is covered in overlapping windows:
  Qwen has a 32,768-token context, garak 8,192, overlap 128. Windows aggregate
  with “any refusal”; label errors remain unknown unless another window is
  positive. Native context truncation raises an error.
- The bounded native producer counts input plus 128 output tokens against its
  concurrency budget. Server slot context must fit each admitted request. The
  private input cache is keyed by response + prompt.
- Language grouping is a transparent lexical heuristic, not certified language
  identification. Results need review before claiming Portuguese performance.
- History review labels in the private database are agent-reviewed provisional
  labels, not an independent human-adjudicated dataset. They must not be used
  to claim accuracy over the entire unlabelled corpus. Freeze new labels before
  inspecting per-sample model predictions.
- A fresh extraction does not recreate the 91 manual review labels. Reproducing
  those historical metrics requires the retained private corpus; a new capture
  needs its own frozen review. The source tools reproduce extraction/inference
  and the artificial controls without committing private examples.
- Re-running classifiers resumes unscored rows. Extraction stages are fixed to
  the initial capture; use a new data directory for a fresh complete capture.
  `--refresh-byok` refreshes that source while retaining existing corpus rows.

Checks: `python -m unittest discover -s tools/refusal-benchmark -p 'test_*.py'`,
`ruff check tools/refusal-benchmark`, and the repository Rust verification suite.
See [the measured comparison](../../docs/research/refusal-benchmark.md) for the
result, pinned runtime hashes, sampling limitations, and known detector failures.

## Compare a detector change

Keep `replies.baseline`, its filtered prose, and the original model scores frozen.
Review garak-positive/baseline-negative replies before adding rules. The follow-up
review file stays private and contains JSONL `{id, label, reason}` records. Those
post-benchmark examples are development cases, not an independent test set.

After rebuilding the adapter, replay every retained response:

```powershell
& $python tools/refusal-benchmark/compare.py --data $data --baseline-exe target/debug/refusal_benchmark.exe --review "$data/garak-followup-review.jsonl" --output docs/research/refusal-garak-followup-results.json
```

The command opens the corpus read-only, compares both decisions and filtered
prose, and exports aggregate counts. Changed case IDs go into the private
`detector-followup-differences.jsonl`; their text remains in `corpus.sqlite`.
