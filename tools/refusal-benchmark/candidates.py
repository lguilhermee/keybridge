"""Freeze a broad whole-response shortlist, independent of the production regex."""

import argparse
import hashlib
import json
import pathlib
import re
import sqlite3

PATTERN = re.compile(
    r"\b(?:i|we)\b.{0,80}\b(?:cannot|can't|won't|unable|unwilling|refuse|decline|refusing|declining|refused|declined|not allowed|not permitted|not going|will not|do not want|don't want|rather not|stopping|ending|sorry|apologiz\w*|regret)\b"
    r"|(?m:^\s*(?:sorry|unfortunately|cannot|can't|won't|unable)\b)"
    r"|\b(?:against|violat\w*)\b.{0,60}\bmy (?:policy|guidelines)\b"
    r"|\bnot something (?:i|we) can\b|\bsafe alternatives?\b"
    r"|\b(?:i|we) can\b.{0,60}\binstead\b"
    r"|\bn[aã]o\s+(?:vou|posso|quero|consigo|podemos|iremos|vamos|irei)\b"
    r"|\b(?:me recus\w*|recuso|recusamos|desculp\w*|lamento|infelizmente)\b"
    r"|我(?:不能|无法|不会|没法|不可以)|抱歉",
    re.IGNORECASE,
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=pathlib.Path, required=True)
    args = parser.parse_args()
    db = sqlite3.connect(args.data / "corpus.sqlite", timeout=60)
    if db.execute("select count(*) from replies where baseline is null").fetchone()[0]:
        raise SystemExit("Run the production baseline on every extracted reply first.")
    db.execute(
        "create table if not exists evaluation_candidates(id TEXT PRIMARY KEY,reasons TEXT NOT NULL)"
    )
    db.execute("delete from evaluation_candidates")
    rows = db.execute("""select r.id,r.prose,r.baseline,r.label,r.control,
        exists(select 1 from origins o where o.reply_id=r.id and o.native_refusal=1)
        from replies r order by r.id""")
    identities = []
    for identity, prose, baseline, label, control, native in rows:
        reasons = []
        if PATTERN.search(prose or ""):
            reasons.append("broad_whole_prose_cue")
        if baseline:
            reasons.append("production_detector")
        if native:
            reasons.append("protocol_refusal_with_text")
        if label is not None:
            reasons.append("frozen_review_label")
        if control:
            reasons.append("control")
        if reasons:
            db.execute(
                "insert into evaluation_candidates values(?,?)",
                (identity, json.dumps(reasons)),
            )
            identities.append(identity)
    metadata = {
        "scope": "denial candidates plus false-positive controls",
        "count": len(identities),
        "corpus_size": db.execute("select count(*) from replies").fetchone()[0],
        "selection_sha256": hashlib.sha256("\n".join(identities).encode()).hexdigest(),
        "selection_pattern": PATTERN.pattern,
        "controls": db.execute(
            "select count(*) from replies r join evaluation_candidates e on e.id=r.id where r.control=1"
        ).fetchone()[0],
    }
    db.execute(
        "insert or replace into extraction values('candidate_selection',?)",
        (json.dumps(metadata),),
    )
    db.commit()
    print(json.dumps(metadata, indent=2), flush=True)


if __name__ == "__main__":
    main()
