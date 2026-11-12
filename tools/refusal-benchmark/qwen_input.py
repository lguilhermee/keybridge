"""One documented Qwen3Guard response template for both local runtimes."""

import hashlib
import json
import sqlite3
import zlib
from functools import lru_cache


def prepare(tokenizer, rows, cache_path=None):
    cache = sqlite3.connect(cache_path) if cache_path else None
    if cache:
        cache.execute(
            "CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY,digest TEXT,windows BLOB)"
        )

    @lru_cache(maxsize=32768)
    def prompt_tail(prompt):
        ids = tokenizer.encode(prompt or "", add_special_tokens=False)
        return tokenizer.decode(ids[-2048:]), max(0, len(ids) - 2048)

    jobs = []
    for index, (identity, response, prompt) in enumerate(rows):
        digest = hashlib.sha256(
            (str(response) + "\0" + str(prompt)).encode()
        ).hexdigest()
        stored = (
            cache.execute(
                "SELECT digest,windows FROM inputs WHERE id=?", (identity,)
            ).fetchone()
            if cache
            else None
        )
        if stored and stored[0] == digest:
            jobs.extend(json.loads(zlib.decompress(stored[1])))
            continue
        windows = []
        response_ids = tokenizer.encode(response or "", add_special_tokens=False)
        prompt, omission = prompt_tail(prompt)
        budget = 32768 - 2048 - 512
        for start in range(0, max(1, len(response_ids)), budget - 128):
            response = tokenizer.decode(response_ids[start : start + budget])
            messages = [
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": response},
            ]
            ids = tokenizer.encode(
                tokenizer.apply_chat_template(messages, tokenize=False),
                add_special_tokens=False,
            )
            if len(ids) + 128 > 32768:
                raise ValueError("Qwen input exceeds context; truncation is forbidden")
            windows.append((identity, omission, ids))
        jobs.extend(windows)
        if cache:
            cache.execute(
                "INSERT OR REPLACE INTO inputs VALUES(?,?,?)",
                (
                    identity,
                    digest,
                    zlib.compress(json.dumps(windows).encode(), level=1),
                ),
            )
        if (index + 1) % 10000 == 0:
            if cache:
                cache.commit()
            print("Prepared inputs", index + 1, "of", len(rows), flush=True)
    if cache:
        cache.commit()
        cache.close()
    jobs.sort(key=lambda item: len(item[2]))
    return jobs
