"""Qwen3Guard inference on a loopback-only llama.cpp instance using exact token IDs."""

import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import time
import urllib.request

os.environ.update(
    HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1"
)
from models import MODELS
from qwen_input import prepare


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=pathlib.Path, required=True)
    parser.add_argument("--view", choices=["prose", "raw"], default="prose")
    parser.add_argument("--controls-only", action="store_true")
    parser.add_argument("--labeled-only", action="store_true")
    parser.add_argument("--candidates-only", action="store_true")
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--token-budget", type=int, default=60000)
    parser.add_argument("--max-input-tokens", type=int, default=32768)
    parser.add_argument("--run-label", default="")
    parser.add_argument(
        "--score-model", choices=["qwen", "qwen-native-check"], default="qwen"
    )
    args = parser.parse_args()
    # Endpoint is deliberately fixed to loopback; no user text leaves this host.
    endpoint = "http://127.0.0.1:49563"
    with urllib.request.urlopen(endpoint + "/health", timeout=10) as response:
        assert json.load(response)["status"] == "ok"
    with urllib.request.urlopen(endpoint + "/props", timeout=10) as response:
        server_properties = json.load(response)
    from transformers import AutoTokenizer

    repo, revision = MODELS["qwen"]
    tokenizer = AutoTokenizer.from_pretrained(
        repo, revision=revision, local_files_only=True
    )
    db = sqlite3.connect(args.data / "corpus.sqlite", timeout=60)
    column = "prose" if args.view == "prose" else "response"
    condition = " AND control=1" if args.controls_only else ""
    if args.labeled_only:
        condition += " AND label IS NOT NULL"
    if args.candidates_only:
        condition += " AND r.id IN (SELECT id FROM evaluation_candidates)"
    rows = db.execute(
        f"SELECT id,{column},prompt FROM replies r WHERE baseline IS NOT NULL {condition} AND NOT EXISTS(SELECT 1 FROM scores s WHERE s.id=r.id AND s.model=? AND s.view=?) ORDER BY id",
        (args.score_model, args.view),
    ).fetchall()
    if not rows:
        print("All requested replies are already scored.", flush=True)
        return
    start = time.perf_counter()
    jobs = prepare(
        tokenizer, rows, args.data / ("qwen-inputs-" + args.view + ".sqlite")
    )
    deferred = {
        identity for identity, _, ids in jobs if len(ids) > args.max_input_tokens
    }
    jobs = [job for job in jobs if job[0] not in deferred]
    print("Deferred long replies", len(deferred), flush=True)
    print("Native windows", len(jobs), "replies", len(rows), flush=True)
    expected, parts = {}, {}
    for identity, _, _ in jobs:
        expected[identity] = expected.get(identity, 0) + 1
        parts[identity] = []
    model_file = (
        pathlib.Path.home() / ".cache/keybridge-benchmark/qwen3guard-0.6b-bf16.gguf"
    )
    metadata = {
        "repo": repo,
        "revision": revision,
        "engine": "llama.cpp " + server_properties["build_info"],
        "dtype": "BF16 weights; F32 normalization",
        "context": 32768,
        "max_input_tokens": args.max_input_tokens,
        "deferred_replies": len(deferred),
        "workers": args.workers,
        "token_budget": args.token_budget,
        "server_context_per_slot": server_properties["default_generation_settings"][
            "n_ctx"
        ],
        "prompt_budget": 2048,
        "window_overlap": 128,
        "started": time.time(),
        "gguf_sha256": hashlib.file_digest(model_file.open("rb"), "sha256").hexdigest(),
    }
    db.execute(
        "INSERT OR REPLACE INTO model_runs VALUES(?,?,?)",
        (args.score_model, args.view + args.run_label, json.dumps(metadata)),
    )
    db.commit()

    def classify(job):
        identity, omission, ids = job
        payload = {
            "prompt": ids,
            "temperature": 0,
            "n_predict": 128,
            "cache_prompt": True,
            "seed": 0,
        }
        before = time.perf_counter()
        request = urllib.request.Request(
            endpoint + "/completion",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=600) as response:
            output = json.load(response)
        if output.get("truncated"):
            raise RuntimeError("llama.cpp truncated a response window")
        match = re.search(r"Refusal:\s*(Yes|No)\b", output.get("content", ""))
        return (
            identity,
            omission,
            len(ids),
            int(match[1] == "Yes") if match else None,
            output.get("content", ""),
            None if match else "missing_refusal_label",
            (time.perf_counter() - before) * 1000,
            output.get("timings", {}),
        )

    completed, latencies, next_progress = 0, [], 500
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        # A bounded producer prevents storing thousands of pending HTTP requests.
        iterator = iter(jobs)
        next_job = next(iterator, None)
        pending = {}
        active_tokens = 0

        def fill():
            nonlocal next_job, active_tokens
            while next_job is not None and len(pending) < args.workers:
                cost = len(next_job[2]) + 128
                if cost > args.token_budget:
                    raise ValueError("A window exceeds the scheduler token budget")
                if active_tokens + cost > args.token_budget:
                    break
                pending[executor.submit(classify, next_job)] = cost
                active_tokens += cost
                next_job = next(iterator, None)

        fill()
        while pending:
            done, _ = concurrent.futures.wait(
                pending, return_when=concurrent.futures.FIRST_COMPLETED
            )
            for future in done:
                active_tokens -= pending.pop(future)
                item = future.result()
                identity = item[0]
                parts[identity].append(item)
                latencies.append(item[6])
                if len(parts[identity]) == expected[identity]:
                    items = parts.pop(identity)
                    decisions = [x[3] for x in items]
                    decision = 1 if 1 in decisions else None if None in decisions else 0
                    db.execute(
                        "INSERT OR REPLACE INTO scores VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            identity,
                            args.score_model,
                            args.view,
                            decision,
                            None,
                            len(items),
                            sum(x[2] for x in items),
                            max(x[1] for x in items),
                            sum(x[6] for x in items),
                            json.dumps([x[4] for x in items]),
                            ";".join(x[5] for x in items if x[5]) or None,
                        ),
                    )
                    completed += 1
            fill()
            db.commit()
            if completed >= next_progress:
                print(
                    "Native classified",
                    completed,
                    "of",
                    len(rows),
                    "seconds",
                    round(time.perf_counter() - start),
                    flush=True,
                )
                next_progress = completed + 500
    latencies.sort()
    metadata.update(
        classified=completed,
        finished=time.time(),
        wall_seconds=time.perf_counter() - start,
        request_ms_p50=latencies[len(latencies) // 2] if latencies else None,
        request_ms_p95=latencies[int(len(latencies) * 0.95)] if latencies else None,
    )
    db.execute(
        "INSERT OR REPLACE INTO model_runs VALUES(?,?,?)",
        (args.score_model, args.view + args.run_label, json.dumps(metadata)),
    )
    db.commit()
    print(json.dumps(metadata), flush=True)


if __name__ == "__main__":
    main()
