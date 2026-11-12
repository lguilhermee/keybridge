"""Extract local assistant text without exporting request headers or tool output."""

import argparse
import hashlib
import json
import pathlib
import re
import sqlite3
import time
from collections import Counter

from archives import extract_archives


def readonly(path):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    db.execute("PRAGMA query_only=ON")
    return db


def language(text):
    # A transparent heuristic, not language ground truth. Review labels separately.
    pt = len(
        re.findall(
            r"\b(?:não|posso|você|para|isso|está|arquivo|também|pelo|uma|com|que)\b",
            text.lower(),
        )
    )
    en = len(
        re.findall(
            r"\b(?:the|this|with|that|will|have|your|can|and|for|not)\b", text.lower()
        )
    )
    return "pt" if pt > en and pt >= 2 else "en" if en >= 2 else "other"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--refresh-byok", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(args.output / "corpus.sqlite")
    db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS replies (
            id TEXT PRIMARY KEY, response TEXT NOT NULL, prompt TEXT NOT NULL,
            language TEXT NOT NULL, prose TEXT, baseline INTEGER, label INTEGER,
            label_reason TEXT, control INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS origins (
            source TEXT, ref TEXT, reply_id TEXT, conversation TEXT,
            native_refusal INTEGER DEFAULT 0, tool_round INTEGER DEFAULT 0,
            PRIMARY KEY(source,ref));
        CREATE INDEX IF NOT EXISTS origins_reply ON origins(reply_id);
        CREATE TABLE IF NOT EXISTS extraction (key TEXT PRIMARY KEY,value TEXT);
    """)
    stats = Counter()
    has_scores = (
        db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scores'"
        ).fetchone()
        is not None
    )
    if args.refresh_byok:
        db.execute("DELETE FROM extraction WHERE key='byok'")
        db.commit()

    def add(source, ref, convo, response, prompt="", native=False, tool=False):
        if not isinstance(response, str) or not response.strip():
            return
        response = response.replace("\r\n", "\n").strip()
        identity = hashlib.sha256(response.encode()).hexdigest()
        db.execute(
            "INSERT OR IGNORE INTO replies(id,response,prompt,language) VALUES(?,?,?,?)",
            (identity, response, prompt, language(response)),
        )
        if prompt:
            updated = db.execute(
                "UPDATE replies SET prompt=? WHERE id=? AND length(prompt)=0",
                (prompt, identity),
            ).rowcount
            if updated and has_scores:
                removed = db.execute(
                    "DELETE FROM scores WHERE id=? AND model='qwen' AND view='prose'",
                    (identity,),
                ).rowcount
                stats["qwen_scores_invalidated_for_recovered_prompt"] += removed
        db.execute(
            "INSERT OR IGNORE INTO origins VALUES(?,?,?,?,?,?)",
            (source, ref, identity, convo, int(native), int(tool)),
        )
        stats[source + "_text_replies"] += 1

    home = pathlib.Path.home()
    user = home / "AppData/Roaming/Cursor/User"
    cursor_path = user / "globalStorage/state.vscdb"
    started = time.time()
    if not db.execute("SELECT 1 FROM extraction WHERE key='cursor'").fetchone():
        source = readonly(cursor_path)
        # Header order gives the actual preceding user message, unlike UUID order.
        orders = {}
        for key, value in source.execute(
            "SELECT key,value FROM cursorDiskKV WHERE key>='composerData:' AND key<'composerData;'"
        ):
            try:
                composer = json.loads(value)
                for index, header in enumerate(
                    composer.get("fullConversationHeadersOnly", [])
                ):
                    orders[(key.split(":", 1)[1], header["bubbleId"])] = index
                stats["cursor_composers"] += 1
            except (ValueError, KeyError):
                stats["cursor_invalid_composers"] += 1
        print("Cursor header entries", len(orders), flush=True)
        db.execute(
            "CREATE TABLE IF NOT EXISTS cursor_text(conversation TEXT,bubble TEXT,ordinal INTEGER,kind INTEGER,text TEXT,tool INTEGER,PRIMARY KEY(conversation,bubble))"
        )
        query = """SELECT key,json_extract(value,'$.type'),json_extract(value,'$.text'),
                   json_type(value,'$.toolFormerData') FROM cursorDiskKV
                   WHERE key>='bubbleId:' AND key<'bubbleId;'"""
        for index, (key, kind, text, tool) in enumerate(source.execute(query)):
            stats["cursor_bubbles"] += 1
            if kind in (1, 2) and isinstance(text, str) and text.strip():
                _, convo, bubble = key.split(":", 2)
                ordinal = orders.get((convo, bubble))
                if ordinal is None:
                    stats["cursor_orphan_text_bubbles"] += 1
                db.execute(
                    "INSERT OR REPLACE INTO cursor_text VALUES(?,?,?,?,?,?)",
                    (
                        convo,
                        bubble,
                        ordinal,
                        kind,
                        text,
                        int(tool not in (None, "null")),
                    ),
                )
            if index % 50000 == 0:
                db.commit()
                print(
                    "Cursor scanned bubbles",
                    index,
                    "seconds",
                    round(time.time() - started),
                    flush=True,
                )
        del orders
        db.commit()
        previous = None
        prompt = ""
        for convo, bubble, ordinal, kind, text, tool in db.execute(
            "SELECT * FROM cursor_text ORDER BY conversation,ordinal"
        ):
            if convo != previous:
                prompt, previous = "", convo
            if kind == 1 and ordinal is not None:
                prompt = text
            elif kind == 2:
                add(
                    "cursor",
                    bubble,
                    convo,
                    text,
                    prompt if ordinal is not None else "",
                    tool=tool,
                )
        db.execute("DROP TABLE cursor_text")
        db.execute(
            "INSERT INTO extraction VALUES('cursor',?)", (json.dumps(dict(stats)),)
        )
        db.commit()
        source.close()

    if not db.execute("SELECT 1 FROM extraction WHERE key='byok'").fetchone():
        source = readonly(home / ".cursor-byok-v3/cursor-byok.db")
        previous, prompt = None, ""
        # SQLite projects only text; replay state and tool payloads never leave source.
        query = """SELECT conversation_id,message_id,role,
                 json_extract(payload_json,'$.content.text'),
                 json_extract(payload_json,'$.content.parts'),
                 json_array_length(payload_json,'$.content.tool_calls')
                 FROM messages WHERE role IN ('user','assistant')
                 ORDER BY conversation_id,created_at_ms,message_id"""
        for convo, mid, role, text, parts, tools in source.execute(query):
            stats["byok_messages"] += 1
            if convo != previous:
                prompt, previous = "", convo
            if role == "user":
                prompt = "\n".join(
                    p.get("text", "")
                    for p in json.loads(parts or "[]")
                    if p.get("type") == "text"
                )
            else:
                add("byok-message", mid, convo, text, prompt, tool=bool(tools))
        db.commit()
        # A refused attempt may be absent from committed conversation messages.
        # Reconstruct all terminal recorded attempts from their SSE, not requests.
        calls = source.execute("""SELECT call_id,conversation_id,finish_reason,protocol_type
            FROM llm_calls WHERE finish_reason IN ('stop','refusal','length')""").fetchall()
        for index, (call, convo, finish, protocol) in enumerate(calls):
            chunks = source.execute(
                "SELECT data FROM llm_call_response_chunks WHERE call_id=? ORDER BY seq",
                (call,),
            )
            raw = b"".join(
                bytes(data) if not isinstance(data, str) else data.encode()
                for (data,) in chunks
            )
            text, signals = parse_response(raw)
            stats["byok_native_refusal_calls"] += int(finish == "refusal")
            stats["byok_native_refusals_with_text"] += int(
                finish == "refusal" and bool(text)
            )
            user_message = source.execute(
                """SELECT m.payload_json FROM llm_calls c
                JOIN runs r ON r.run_id=c.run_id JOIN checkpoint_messages cm ON cm.checkpoint_id=r.base_checkpoint_id
                JOIN messages m ON m.conversation_id=cm.conversation_id AND m.message_id=cm.message_id
                WHERE c.call_id=? AND m.role='user' ORDER BY cm.ordinal DESC LIMIT 1""",
                (call,),
            ).fetchone()
            prompt = ""
            if user_message:
                content = json.loads(user_message[0]).get("content", {})
                prompt = "\n".join(
                    p.get("text", "")
                    for p in content.get("parts", [])
                    if p.get("type") == "text"
                )
            add(
                "byok-call",
                call,
                convo,
                text,
                prompt,
                native=finish == "refusal" or signals,
            )
            stats["byok_terminal_calls"] += 1
            if not text:
                stats["byok_terminal_calls_without_text"] += 1
            if index % 250 == 0:
                db.commit()
                print("BYOK terminal calls", index, flush=True)
        db.execute(
            "INSERT INTO extraction VALUES('byok',?)", (json.dumps(dict(stats)),)
        )
        db.commit()
        source.close()

    # Legacy workspace chat formats, including old composer conversation arrays.
    if not db.execute("SELECT 1 FROM extraction WHERE key='legacy'").fetchone():
        for path in [
            cursor_path,
            *sorted((user / "workspaceStorage").glob("*/state.vscdb")),
        ]:
            try:
                source = readonly(path)
                rows = source.execute(
                    "SELECT key,value FROM ItemTable WHERE key IN ('workbench.panel.aichat.view.aichat.chatdata','composer.composerData')"
                ).fetchall()
                stats["cursor_databases_checked"] += 1
                for key, value in rows:
                    value = json.loads(value)
                    legacy_extract(
                        value,
                        lambda ref, convo, text, prompt, path=path: add(
                            "cursor-legacy",
                            str(path.parent.name) + ":" + ref,
                            convo,
                            text,
                            prompt,
                        ),
                    )
                source.close()
            except (sqlite3.Error, ValueError):
                stats["legacy_databases_errors"] += 1
        db.execute(
            "INSERT INTO extraction VALUES('legacy',?)", (json.dumps(dict(stats)),)
        )
        db.commit()

    if not db.execute("SELECT 1 FROM extraction WHERE key='archives'").fetchone():
        extract_archives(home, add, stats, parse_response)
        db.execute(
            "INSERT INTO extraction VALUES('archives',?)", (json.dumps(dict(stats)),)
        )
        db.commit()

    totals = {
        key: json.loads(value) for key, value in db.execute("SELECT * FROM extraction")
    }
    totals["unique_replies"] = db.execute("SELECT count(*) FROM replies").fetchone()[0]
    totals["unique_by_language_heuristic"] = dict(
        db.execute("SELECT language,count(*) FROM replies GROUP BY language")
    )
    totals["source_counts"] = dict(
        db.execute("SELECT source,count(*) FROM origins GROUP BY source")
    )
    (args.output / "extraction.json").write_text(
        json.dumps(totals, indent=2), encoding="utf-8"
    )
    print(json.dumps(totals, indent=2), flush=True)


def parse_response(raw):
    text, final, refusal = [], [], False
    events = []
    if isinstance(raw, bytes):
        # Devin's Connect protocol uses a one-byte flag + big-endian length.
        # HTTP chunks may split a frame anywhere; callers join them first.
        if raw[:1] in (b"\0", b"\2"):
            offset = 0
            while offset + 5 <= len(raw):
                flags = raw[offset]
                length = int.from_bytes(raw[offset + 1 : offset + 5], "big")
                if flags not in (0, 2) or offset + 5 + length > len(raw):
                    break
                frame = json.loads(raw[offset + 5 : offset + 5 + length])
                if flags == 0:
                    text.append(frame.get("deltaText", ""))
                    refusal |= bool(frame.get("usage", {}).get("providerRefusal"))
                offset += 5 + length
            return "".join(text), refusal
        raw = raw.decode("utf-8", errors="replace")
    for block in re.split(r"\r?\n\r?\n", raw):
        data = "\n".join(
            line[5:].lstrip() for line in block.splitlines() if line.startswith("data:")
        )
        if data and data != "[DONE]":
            try:
                events.append(json.loads(data))
            except ValueError:
                pass
    if not events:
        try:
            events = [json.loads(raw)]
        except ValueError:
            return "", False
    for event in events:
        kind = event.get("type", "")
        delta = event.get("delta", {})
        if (
            kind == "content_block_start"
            and event.get("content_block", {}).get("type") == "text"
        ):
            text.append(event["content_block"].get("text", ""))
        if isinstance(delta, dict) and delta.get("type") == "text_delta":
            text.append(delta.get("text", ""))
        if kind == "response.output_text.delta":
            text.append(delta)
        if kind == "response.refusal.delta":
            text.append(delta)
            refusal = True
        for choice in event.get("choices", []):
            message = choice.get("delta", choice.get("message", {}))
            if isinstance(message.get("content"), str):
                text.append(message["content"])
            if message.get("refusal"):
                text.append(message["refusal"])
                refusal = True
        if kind == "response.output_text.done":
            final.append(event.get("text", ""))
        if kind == "response.completed":
            for item in event.get("response", {}).get("output", []):
                for content in item.get("content", []):
                    if content.get("type") in ("output_text", "refusal"):
                        final.append(content.get("text", content.get("refusal", "")))
    return "".join(text) or "\n".join(final), refusal


def legacy_extract(value, add):
    if isinstance(value, dict):
        for container in ("tabs", "allComposers", "composers"):
            if isinstance(value.get(container), list):
                for item in value[container]:
                    legacy_extract(item, add)
        messages = value.get("bubbles", value.get("conversation", []))
        if not isinstance(messages, list):
            return
        prompt = ""
        convo = str(value.get("id", value.get("composerId", "legacy")))
        for index, item in enumerate(messages):
            role = item.get("type", item.get("role"))
            text = item.get("text", "")
            if role in (1, "user"):
                prompt = text
            if role in (2, "assistant", "ai"):
                add(convo + ":" + str(index), convo, text, prompt)
    elif isinstance(value, list):
        for item in value:
            legacy_extract(item, add)


if __name__ == "__main__":
    main()
