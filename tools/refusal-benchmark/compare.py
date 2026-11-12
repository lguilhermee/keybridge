"""Replay a changed detector without overwriting the frozen benchmark baseline."""

import argparse
import hashlib
import json
import pathlib
import sqlite3
import subprocess

from report import confusion


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=pathlib.Path, required=True)
    parser.add_argument("--baseline-exe", type=pathlib.Path, required=True)
    parser.add_argument("--review", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    reviewed = {
        item["id"]: item["label"]
        for line in args.review.read_text(encoding="utf-8").splitlines()
        if (item := json.loads(line))
    }
    db = sqlite3.connect((args.data / "corpus.sqlite").as_uri() + "?mode=ro", uri=True)
    query = """SELECT r.id,r.response,r.prose,r.baseline,r.control,r.label,
        (SELECT refusal FROM scores s WHERE s.id=r.id AND model='garak' AND view='prose')
        FROM replies r ORDER BY r.id"""
    root = pathlib.Path(__file__).resolve().parents[2]
    result = {
        "review_sha256": hashlib.sha256(args.review.read_bytes()).hexdigest(),
        "source_sha256": hashlib.sha256(
            (root / "server/src/run/refusal_reply/detection.rs").read_bytes()
        ).hexdigest(),
        "cases": 0,
        "new_positives": 0,
        "new_negatives": 0,
        "new_positives_also_flagged_by_garak": 0,
        "prose_changes": 0,
    }
    groups = {key: [] for key in ["history_review", "controls", "garak_followup"]}
    before = {key: [] for key in groups}
    seen_reviewed = set()
    differences = args.data / "detector-followup-differences.jsonl"
    process = subprocess.Popen(
        [str(args.baseline_exe.resolve())],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    try:
        with differences.open("w", encoding="utf-8") as output:
            for identity, text, prose, previous, control, label, garak in db.execute(
                query
            ):
                process.stdin.write(json.dumps({"id": identity, "text": text}) + "\n")
                process.stdin.flush()
                prediction = json.loads(process.stdout.readline())
                if prediction["id"] != identity:
                    raise RuntimeError("Detector response identity mismatch")
                current = int(prediction["refusal"])
                result["cases"] += 1
                if result["cases"] % 10000 == 0:
                    print("Compared", result["cases"], "replies", flush=True)
                filtered = prediction["prose"].replace("\0", " ").replace("\1", "\n")
                result["prose_changes"] += filtered != prose
                if label is not None:
                    group = "controls" if control else "history_review"
                    groups[group].append((label, current))
                    before[group].append((label, previous))
                if identity in reviewed:
                    seen_reviewed.add(identity)
                    groups["garak_followup"].append((reviewed[identity], current))
                    before["garak_followup"].append((reviewed[identity], previous))
                if current != previous:
                    result["new_positives" if current else "new_negatives"] += 1
                    result["new_positives_also_flagged_by_garak"] += bool(
                        current and garak == 1
                    )
                    output.write(
                        json.dumps(
                            {"id": identity, "before": previous, "after": current}
                        )
                        + "\n"
                    )
    finally:
        process.stdin.close()
        process.wait()
    if process.returncode:
        raise RuntimeError("Production detector adapter failed")
    if set(reviewed) != seen_reviewed:
        raise RuntimeError("A follow-up review identity is missing from the corpus")
    result["before"] = {key: confusion(rows) for key, rows in before.items()}
    result["after"] = {key: confusion(rows) for key, rows in groups.items()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
