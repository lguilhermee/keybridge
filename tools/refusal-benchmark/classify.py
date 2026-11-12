"""Run pinned public weights locally. The classifier phase disables network access."""

import argparse
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import time

from models import MODELS
from qwen_input import prepare as prepare_qwen

os.environ.update(
    HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1"
)


def prepare(db, executable):
    process = subprocess.Popen(
        [str(executable)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    try:
        for index, (identity, text) in enumerate(
            db.execute("SELECT id,response FROM replies WHERE baseline IS NULL")
        ):
            process.stdin.write(json.dumps({"id": identity, "text": text}) + "\n")
            process.stdin.flush()
            output = json.loads(process.stdout.readline())
            db.execute(
                "UPDATE replies SET baseline=?,prose=? WHERE id=?",
                (
                    int(output["refusal"]),
                    output["prose"].replace("\0", " ").replace("\1", "\n"),
                    identity,
                ),
            )
            if index % 5000 == 0:
                db.commit()
                print("Production detector replies", index, flush=True)
    finally:
        process.stdin.close()
        process.wait()
    if process.returncode:
        raise RuntimeError("Production detector failed")
    db.commit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=pathlib.Path, required=True)
    parser.add_argument("--model", choices=["baseline", *MODELS], required=True)
    parser.add_argument("--baseline-exe", type=pathlib.Path)
    parser.add_argument("--view", choices=["prose", "raw"], default="prose")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--controls-only", action="store_true")
    parser.add_argument("--candidates-only", action="store_true")
    args = parser.parse_args()
    db = sqlite3.connect(args.data / "corpus.sqlite", timeout=60)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS scores (
            id TEXT,model TEXT,view TEXT,refusal INTEGER,score REAL,
            windows INTEGER,input_tokens INTEGER,prompt_omitted_tokens INTEGER,
            milliseconds REAL,output TEXT,error TEXT,
            PRIMARY KEY(id,model,view));
        CREATE TABLE IF NOT EXISTS model_runs (
            model TEXT,view TEXT,metadata TEXT,PRIMARY KEY(model,view));
    """)
    if args.model == "baseline":
        prepare(db, args.baseline_exe)
        return

    import numpy as np
    import psutil
    import torch
    import transformers
    from transformers import (
        AutoModelForCausalLM,
        AutoModelForSequenceClassification,
        AutoTokenizer,
    )

    torch.set_num_threads(8)
    torch.backends.cuda.matmul.allow_tf32 = True
    repo, revision = MODELS[args.model]
    started = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(
        repo, revision=revision, local_files_only=True
    )
    if args.model == "qwen":
        tokenizer.padding_side = "left"
        model = (
            AutoModelForCausalLM.from_pretrained(
                repo,
                revision=revision,
                local_files_only=True,
                torch_dtype=torch.bfloat16,
                attn_implementation="sdpa",
            )
            .to("cuda")
            .eval()
        )
        context = 32768
    else:
        model = (
            AutoModelForSequenceClassification.from_pretrained(
                repo,
                revision=revision,
                local_files_only=True,
                torch_dtype=torch.bfloat16,
                attn_implementation="sdpa",
                reference_compile=False,
            )
            .to("cuda")
            .eval()
        )
        assert model.config.id2label[0] == "refusal"
        context = 8192
    metadata = {
        "repo": repo,
        "revision": revision,
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "gpu": torch.cuda.get_device_name(),
        "dtype": "bfloat16",
        "context": context,
        "load_seconds": time.perf_counter() - started,
        "pid": os.getpid(),
        "batch_size": args.batch_size,
        "prompt_budget": 2048 if args.model == "qwen" else 0,
        "window_overlap": 128,
        "view": args.view,
        "started": time.time(),
    }
    print(json.dumps(metadata), flush=True)
    column = "prose" if args.view == "prose" else "response"
    query = f"""SELECT id,{column},prompt FROM replies r WHERE baseline IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM scores s WHERE s.id=r.id AND s.model=? AND s.view=?)"""
    if args.controls_only:
        query += " AND control=1"
    if args.candidates_only:
        query += " AND r.id IN (SELECT id FROM evaluation_candidates)"
    query += f" ORDER BY length({column}),id"
    if args.limit:
        query += " LIMIT " + str(args.limit)
    rows = db.execute(query, (args.model, args.view)).fetchall()
    print("Replies to classify", len(rows), flush=True)
    if not rows:
        return
    db.execute(
        "INSERT OR REPLACE INTO model_runs VALUES(?,?,?)",
        (args.model, args.view, json.dumps(metadata)),
    )
    db.commit()
    prepared, counts, measurements = [], {}, []

    def flush():
        if not prepared:
            return
        encoded = tokenizer.pad(
            {"input_ids": [item[2] for item in prepared]},
            padding=True,
            return_tensors="pt",
        ).to("cuda")
        torch.cuda.synchronize()
        before = time.perf_counter()
        with torch.inference_mode():
            if args.model == "garak":
                outputs = (
                    model(**encoded).logits.float().softmax(-1)[:, 0].cpu().tolist()
                )
                predictions = [(int(p > 0.5), p, "", None) for p in outputs]
            else:
                outputs = model.generate(
                    **encoded,
                    max_new_tokens=128,
                    do_sample=False,
                    pad_token_id=tokenizer.pad_token_id,
                )
                texts = tokenizer.batch_decode(
                    outputs[:, encoded.input_ids.shape[1] :], skip_special_tokens=True
                )
                predictions = []
                for text in texts:
                    match = re.search(r"Refusal:\s*(Yes|No)\b", text)
                    predictions.append(
                        (
                            int(match[1] == "Yes") if match else None,
                            None,
                            text,
                            None if match else "missing_refusal_label",
                        )
                    )
        torch.cuda.synchronize()
        duration = (time.perf_counter() - before) * 1000
        measurements.append(
            {
                "batch": len(prepared),
                "max_tokens": encoded.input_ids.shape[1],
                "ms": duration,
            }
        )
        for (identity, omission, tokens), (refusal, score, output, error) in zip(
            prepared, predictions
        ):
            counts[identity].append(
                (
                    refusal,
                    score,
                    output,
                    error,
                    len(tokens),
                    omission,
                    duration / len(prepared),
                )
            )
        prepared.clear()

    def save(identity):
        items = counts.pop(identity)
        # Any refusal window means the full response contains a refusal. Unknown
        # remains unknown unless a positive window establishes the result.
        decisions = [x[0] for x in items]
        decision = 1 if 1 in decisions else None if None in decisions else 0
        db.execute(
            "INSERT OR REPLACE INTO scores VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                identity,
                args.model,
                args.view,
                decision,
                max((x[1] for x in items if x[1] is not None), default=None),
                len(items),
                sum(x[4] for x in items),
                max(x[5] for x in items),
                sum(x[6] for x in items),
                json.dumps([x[2] for x in items]),
                ";".join(x[3] for x in items if x[3]) or None,
            ),
        )

    pending = []
    inference_started = time.perf_counter()
    # Bucket by the complete input length. Response length alone badly mixes
    # short and long user prompts, wasting GPU work on left padding.
    if args.model == "qwen":
        jobs = prepare_qwen(tokenizer, rows)
        counts = {identity: [] for identity, _, _ in jobs}
        expected = {}
        for identity, _, _ in jobs:
            expected[identity] = expected.get(identity, 0) + 1
        jobs.sort(key=lambda item: len(item[2]))
        print(
            "Prepared windows",
            len(jobs),
            "maximum input",
            max(len(x[2]) for x in jobs),
            flush=True,
        )
        completed = 0

        def complete_ready():
            nonlocal completed
            ready = [
                identity
                for identity, items in counts.items()
                if len(items) == expected[identity]
            ]
            for identity in ready:
                save(identity)
                completed += 1
            db.commit()

        for index, job in enumerate(jobs):
            if len(job[2]) + 128 > context:
                raise RuntimeError("Input exceeds context; truncation is forbidden")
            if prepared and (
                len(job[2]) * (len(prepared) + 1) > 20000
                or len(prepared) >= args.batch_size
            ):
                flush()
                complete_ready()
                if completed and completed % 500 < args.batch_size:
                    print(
                        "Classified",
                        completed,
                        "of",
                        len(rows),
                        "seconds",
                        round(time.perf_counter() - inference_started),
                        flush=True,
                    )
            prepared.append(job)
        flush()
        complete_ready()
        rows_processed = len(rows)
        rows = []
    else:
        rows_processed = len(rows)
    for index, (identity, response, prompt) in enumerate(rows):
        if args.view == "prose" and not (response or "").strip():
            db.execute(
                "INSERT OR REPLACE INTO scores VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (identity, args.model, args.view, 0, None, 0, 0, 0, 0, "[]", None),
            )
            continue
        counts[identity] = []
        response_ids = tokenizer.encode(response or "", add_special_tokens=False)
        if args.model == "qwen":
            prompt_ids = tokenizer.encode(prompt or "", add_special_tokens=False)
            omission = max(0, len(prompt_ids) - 2048)
            prompt = tokenizer.decode(prompt_ids[-2048:])
            budget = context - min(len(prompt_ids), 2048) - 512
        else:
            omission, budget = 0, context - 2
        chunks = [
            response_ids[start : start + budget]
            for start in range(0, max(1, len(response_ids)), budget - 128)
        ]
        for chunk in chunks:
            if args.model == "qwen":
                messages = [
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": tokenizer.decode(chunk)},
                ]
                ids = tokenizer.encode(
                    tokenizer.apply_chat_template(messages, tokenize=False),
                    add_special_tokens=False,
                )
            else:
                # This checkpoint uses a generic fast tokenizer whose Python
                # build_inputs_with_special_tokens omits its backend template.
                ids = [tokenizer.cls_token_id, *chunk, tokenizer.sep_token_id]
            if len(ids) + (128 if args.model == "qwen" else 0) > context:
                raise RuntimeError("Input exceeds context; truncation is forbidden")
            # Bound total padded tokens, since long windows should be classified
            # alone rather than exhausting GPU memory in a large padded batch.
            if prepared and (
                max(len(ids), max(len(x[2]) for x in prepared)) * (len(prepared) + 1)
                > 20000
                or len(prepared) >= args.batch_size
            ):
                flush()
                for ready in pending:
                    save(ready)
                pending.clear()
            prepared.append((identity, omission, ids))
            if len(chunks) > 1:
                flush()
        if len(chunks) > 1:
            save(identity)
        else:
            pending.append(identity)
        if (index + 1) % 500 == 0:
            db.commit()
            print(
                "Classified",
                index + 1,
                "of",
                len(rows),
                "seconds",
                round(time.perf_counter() - inference_started),
                flush=True,
            )
    flush()
    for identity in pending:
        save(identity)
    metadata.update(
        finished=time.time(),
        wall_seconds=time.perf_counter() - inference_started,
        classified=rows_processed,
        gpu_peak_allocated_bytes=torch.cuda.max_memory_allocated(),
        process_rss_bytes=psutil.Process().memory_info().rss,
        batch_ms_p50=float(np.median([x["ms"] for x in measurements]))
        if measurements
        else None,
        batch_ms_p95=float(np.percentile([x["ms"] for x in measurements], 95))
        if measurements
        else None,
        batches=measurements,
    )
    db.execute(
        "INSERT OR REPLACE INTO model_runs VALUES(?,?,?)",
        (args.model, args.view, json.dumps(metadata)),
    )
    db.commit()
    print(
        "Finished",
        args.model,
        "replies",
        rows_processed,
        "seconds",
        round(metadata["wall_seconds"], 2),
        flush=True,
    )


if __name__ == "__main__":
    main()
