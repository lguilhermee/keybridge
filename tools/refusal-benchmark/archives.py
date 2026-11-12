"""Read role-attributed Cursor transcripts and historical Keybridge databases."""

import json
import sqlite3


def text_parts(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n\n".join(
        part["text"]
        for part in content
        if isinstance(part, dict)
        and part.get("type") == "text"
        and isinstance(part.get("text"), str)
    )


def extract_archives(home, add, stats, parse_response):
    projects = home / ".cursor/projects"
    files = sorted(projects.glob("*/agent-transcripts/**/*.jsonl"))
    for file_index, path in enumerate(files):
        prompt = ""
        reference = str(path.relative_to(home))
        try:
            with path.open(encoding="utf-8") as stream:
                for line_number, line in enumerate(stream, 1):
                    try:
                        value = json.loads(line)
                    except ValueError:
                        stats["transcript_invalid_lines"] += 1
                        continue
                    role = value.get("role")
                    content = value.get("message", {}).get("content", [])
                    text = text_parts(content)
                    if role == "user" and text.strip():
                        prompt = text
                    elif role == "assistant":
                        add(
                            "cursor-transcript",
                            reference + ":" + str(line_number),
                            path.stem,
                            text,
                            prompt,
                            tool=isinstance(content, list)
                            and any(
                                part.get("type") == "tool_use"
                                for part in content
                                if isinstance(part, dict)
                            ),
                        )
                        stats["transcript_assistant_records"] += 1
                    elif role not in ("user", "tool", "system"):
                        stats["transcript_non_message_records"] += 1
            stats["transcript_files_read"] += 1
        except (OSError, UnicodeError):
            stats["transcript_unreadable_files"] += 1
        if (file_index + 1) % 500 == 0:
            print(
                "Cursor transcript files", file_index + 1, "of", len(files), flush=True
            )
    # These are explicitly compaction records/indices, not original replies.
    stats["derived_compaction_markdown_files"] = len(
        list(projects.glob("*/agent-transcripts/**/*.md"))
    )

    for path in sorted((home / ".cursor-byok-backups").rglob("cursor-byok.db")):
        source = sqlite3.connect(
            path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30
        )
        source.execute("PRAGMA query_only=ON")
        tables = {
            row[0]
            for row in source.execute(
                "select name from sqlite_master where type='table'"
            )
        }
        if "messages" not in tables:
            source.close()
            continue
        prompt = previous = ""
        query = """SELECT conversation_id,message_id,role,
            json_extract(payload_json,'$.content.text'),
            json_extract(payload_json,'$.content.parts'),
            json_array_length(payload_json,'$.content.tool_calls')
            FROM messages WHERE role IN ('user','assistant')
            ORDER BY conversation_id,created_at_ms,message_id"""
        for convo, mid, role, text, parts, tools in source.execute(query):
            if convo != previous:
                prompt, previous = "", convo
            if role == "user":
                prompt = text_parts(json.loads(parts or "[]"))
            else:
                add(
                    "byok-backup-message",
                    str(path.relative_to(home)) + ":" + convo + ":" + mid,
                    convo,
                    text,
                    prompt,
                    tool=bool(tools),
                )
                stats["backup_assistant_records"] += 1
        if {"llm_calls", "llm_call_response_chunks"} <= tables:
            calls = source.execute(
                "SELECT call_id,conversation_id,finish_reason FROM llm_calls WHERE finish_reason IN ('stop','refusal','length')"
            ).fetchall()
            for call, convo, finish in calls:
                raw = b"".join(
                    data if isinstance(data, bytes) else data.encode()
                    for (data,) in source.execute(
                        "SELECT data FROM llm_call_response_chunks WHERE call_id=? ORDER BY seq",
                        (call,),
                    )
                )
                text, signal = parse_response(raw)
                add(
                    "byok-backup-call",
                    str(path.relative_to(home)) + ":" + call,
                    convo,
                    text,
                    native=finish == "refusal" or signal,
                )
                stats["backup_terminal_calls"] += 1
                stats["backup_terminal_calls_without_text"] += int(not text)
        source.close()
        stats["backup_databases_read"] += 1
