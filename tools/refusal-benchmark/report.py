"""Export aggregate measurements only; private text and source IDs stay local."""

import argparse
import hashlib
import json
import pathlib
import sqlite3


def confusion(rows):
    result = {key: 0 for key in ["tp", "fp", "tn", "fn", "unknown"]}
    for label, predicted in rows:
        if predicted is None:
            result["unknown"] += 1
        else:
            result[
                "tp"
                if label and predicted
                else "fn"
                if label
                else "fp"
                if predicted
                else "tn"
            ] += 1
    tp, fp, fn = result["tp"], result["fp"], result["fn"]
    result["precision"] = tp / (tp + fp) if tp + fp else None
    result["recall"] = tp / (tp + fn) if tp + fn else None
    result["f1"] = 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None
    result["count"] = sum(result[k] for k in ["tp", "fp", "tn", "fn", "unknown"])
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument("--export-private-candidates", action="store_true")
    parser.add_argument("--scope", choices=["all", "candidates"], default="all")
    args = parser.parse_args()
    db = sqlite3.connect(args.data / "corpus.sqlite")
    selected = (
        "id IN (SELECT id FROM evaluation_candidates)"
        if args.scope == "candidates"
        else "1"
    )
    selected_reply = "r." + selected if args.scope == "candidates" else "1"
    if args.require_complete:
        total = db.execute("SELECT count(*) FROM replies WHERE " + selected).fetchone()[
            0
        ]
        for model in ["qwen", "garak"]:
            scored = db.execute(
                "SELECT count(*) FROM scores WHERE model=? AND view='prose' "
                "AND error IS NULL AND refusal IS NOT NULL AND " + selected,
                (model,),
            ).fetchone()[0]
            if scored != total:
                raise SystemExit(f"Incomplete {model} evaluation: {scored}/{total}")
    result = {
        "extraction": json.loads((args.data / "extraction.json").read_text()),
        "metrics": {},
        "overall_history_predictions": {},
        "selected_history_predictions": {},
        "runs": {},
        "scope": args.scope,
    }
    if args.scope == "candidates":
        result["selection"] = json.loads(
            db.execute(
                "select value from extraction where key='candidate_selection'"
            ).fetchone()[0]
        )
    validation = db.execute(
        "SELECT value FROM extraction WHERE key='baseline_adapter_validation'"
    ).fetchone()
    if validation:
        result["baseline_adapter_validation"] = json.loads(validation[0])
    root = pathlib.Path(__file__).resolve().parents[2]
    result["baseline_source_sha256"] = hashlib.sha256(
        (root / "server/src/run/refusal_reply/detection.rs").read_bytes()
    ).hexdigest()
    capture = result["extraction"]
    capture["legacy"] = {
        k: v
        for k, v in capture["legacy"].items()
        if k in ("cursor_databases_checked", "legacy_databases_errors")
    }
    capture["historical_unique_replies"] = db.execute(
        "SELECT count(*) FROM replies WHERE control=0"
    ).fetchone()[0]
    result["label_counts"] = [
        dict(zip(["control", "label", "count"], row))
        for row in db.execute(
            "SELECT control,label,count(*) FROM replies WHERE label IS NOT NULL GROUP BY 1,2"
        )
    ]
    for model in ["baseline", "qwen", "garak"]:
        if model == "baseline":
            table, prediction, params = "replies r", "r.baseline", ()
        else:
            table = "replies r LEFT JOIN scores s ON s.id=r.id AND s.model=? AND s.view='prose'"
            prediction, params = "s.refusal", (model,)
        groups = {}
        for subset, clause in [
            ("all_labeled", "1"),
            ("history_review", "r.control=0"),
            ("controls", "r.control=1"),
            ("english", "r.language='en'"),
            ("portuguese", "r.language='pt'"),
        ]:
            groups[subset] = confusion(
                db.execute(
                    f"SELECT r.label,{prediction} FROM {table} WHERE r.label IS NOT NULL AND {clause}",
                    params,
                )
            )
        result["metrics"][model] = groups
        result["overall_history_predictions"][model] = {
            str(k): v
            for k, v in db.execute(
                f"SELECT {prediction},count(*) FROM {table} WHERE r.control=0 GROUP BY 1",
                params,
            )
        }
        result["selected_history_predictions"][model] = {
            str(k): v
            for k, v in db.execute(
                f"SELECT {prediction},count(*) FROM {table} WHERE r.control=0 AND {selected_reply} GROUP BY 1",
                params,
            )
        }
    for model, view, metadata in db.execute("SELECT * FROM model_runs"):
        run = json.loads(metadata)
        run.pop("batches", None)
        run.pop("pid", None)
        result["runs"][model + ":" + view] = run
    result["coverage"] = {}
    for model in ["qwen", "garak"]:
        result["coverage"][model] = dict(
            zip(
                [
                    "scored",
                    "errors",
                    "windowed_replies",
                    "max_windows",
                    "prompts_with_omitted_tokens",
                    "max_prompt_omission_tokens",
                ],
                db.execute(
                    "SELECT count(*),sum(error IS NOT NULL),sum(windows>1),max(windows),sum(prompt_omitted_tokens>0),max(prompt_omitted_tokens) FROM scores WHERE model=? AND view='prose'",
                    (model,),
                ).fetchone(),
            )
        )
        result["coverage"][model]["selected_scored"] = db.execute(
            "SELECT count(*) FROM scores WHERE model=? AND view='prose' AND "
            + selected,
            (model,),
        ).fetchone()[0]
        result["coverage"][model]["selected_errors"] = db.execute(
            "SELECT count(*) FROM scores WHERE model=? AND view='prose' AND error IS NOT NULL AND "
            + selected,
            (model,),
        ).fetchone()[0]
        result["coverage"][model]["selected_bounds"] = dict(
            zip(
                [
                    "windowed_replies",
                    "max_windows",
                    "prompts_with_omitted_tokens",
                    "max_prompt_omission_tokens",
                    "max_total_input_tokens_per_reply",
                ],
                db.execute(
                    "SELECT sum(windows>1),max(windows),"
                    "sum(prompt_omitted_tokens>0),max(prompt_omitted_tokens),"
                    "max(input_tokens) FROM scores WHERE model=? "
                    "AND view='prose' AND " + selected,
                    (model,),
                ).fetchone(),
            )
        )
    result["agreements"] = [
        dict(zip(["baseline", "qwen", "garak", "count"], row))
        for row in db.execute(
            """
        SELECT r.baseline,q.refusal,g.refusal,count(*) FROM replies r
        JOIN scores q ON q.id=r.id AND q.model='qwen' AND q.view='prose'
        JOIN scores g ON g.id=r.id AND g.model='garak' AND g.view='prose'
        WHERE r.control=0 AND """
            + selected_reply
            + " GROUP BY 1,2,3"
        )
    ]
    result["control_results"] = [
        dict(
            zip(
                [
                    "case",
                    "expected",
                    "baseline",
                    "qwen_prose",
                    "qwen_raw",
                    "qwen_native_raw",
                    "garak_prose",
                    "garak_raw",
                ],
                row,
            )
        )
        for row in db.execute("""SELECT r.label_reason,r.label,r.baseline,
            (SELECT refusal FROM scores WHERE id=r.id AND model='qwen' AND view='prose'),
            (SELECT refusal FROM scores WHERE id=r.id AND model='qwen' AND view='raw'),
            (SELECT refusal FROM scores WHERE id=r.id AND model='qwen-native-check' AND view='raw'),
            (SELECT refusal FROM scores WHERE id=r.id AND model='garak' AND view='prose'),
            (SELECT refusal FROM scores WHERE id=r.id AND model='garak' AND view='raw')
            FROM replies r WHERE control=1 ORDER BY label_reason""")
    ]
    result["runtime_parity"] = dict(
        zip(
            ["count", "same_refusal_label", "errors"],
            db.execute("""
        SELECT count(*),sum(a.refusal=b.refusal),sum(a.error IS NOT NULL OR b.error IS NOT NULL)
        FROM scores a JOIN scores b USING(id,view)
        WHERE a.model='qwen' AND b.model='qwen-native-check' AND a.view='raw'""").fetchone(),
        )
    )
    result["filtered_runtime_parity"] = dict(
        zip(
            ["count", "same_refusal_label", "errors"],
            db.execute("""
        SELECT count(*),sum(a.refusal=b.refusal),sum(a.error IS NOT NULL OR b.error IS NOT NULL)
        FROM scores a JOIN scores b USING(id,view)
        WHERE a.model='qwen' AND b.model='qwen-torch-check' AND a.view='prose'""").fetchone(),
        )
    )
    result["controls_unique_qwen_inputs"] = db.execute(
        "SELECT count(*) FROM (SELECT prompt,prose FROM replies WHERE control=1 GROUP BY prompt,prose)"
    ).fetchone()[0]
    result["standalone_controls"] = {}
    for model in ["qwen", "qwen-native-check", "garak"]:
        result["standalone_controls"][model] = confusion(
            db.execute(
                """
            SELECT r.label,s.refusal FROM replies r JOIN scores s ON s.id=r.id
            WHERE r.control=1 AND s.model=? AND s.view='raw'""",
                (model,),
            )
        )
    if args.export_private_candidates:
        path = args.data / "refusal-candidates.jsonl"
        confirmed_path = args.data / "reviewed-refusals.jsonl"
        count = confirmed_count = 0
        query = (
            """SELECT r.id,r.prompt,r.response,r.prose,r.label,r.label_reason,
            r.baseline,q.refusal,g.refusal FROM replies r
            JOIN scores q ON q.id=r.id AND q.model='qwen' AND q.view='prose'
            JOIN scores g ON g.id=r.id AND g.model='garak' AND g.view='prose'
            WHERE r.control=0 AND """
            + (
                "r." + selected
                if args.scope == "candidates"
                else "(r.label=1 OR r.baseline=1 OR q.refusal=1 OR g.refusal=1)"
            )
            + " ORDER BY r.id"
        )
        with (
            path.open("w", encoding="utf-8") as output,
            confirmed_path.open("w", encoding="utf-8") as confirmed,
        ):
            for row in db.execute(query):
                item = dict(
                    zip(
                        [
                            "id",
                            "prompt",
                            "response",
                            "prose",
                            "review_label",
                            "review_reason",
                            "baseline",
                            "qwen",
                            "garak",
                        ],
                        row,
                    )
                )
                item["origins"] = [
                    dict(
                        zip(["source", "ref", "conversation", "native_refusal"], origin)
                    )
                    for origin in db.execute(
                        "SELECT source,ref,conversation,native_refusal FROM origins WHERE reply_id=?",
                        (row[0],),
                    )
                ]
                encoded = json.dumps(item, ensure_ascii=False) + "\n"
                output.write(encoded)
                count += 1
                if item["review_label"] == 1:
                    confirmed.write(encoded)
                    confirmed_count += 1
        result["private_exports"] = {
            "candidates": count,
            "agent_reviewed_refusals": confirmed_count,
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "metrics": result["metrics"],
                "selected_history_predictions": result["selected_history_predictions"],
                "coverage": result["coverage"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
