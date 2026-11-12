import json
import pathlib
import tempfile
import unittest
from collections import Counter

from archives import extract_archives, text_parts


class ArchiveTests(unittest.TestCase):
    def test_only_visible_text_is_extracted(self):
        content = [
            {"type": "thinking", "thinking": "private thought"},
            {"type": "text", "text": "Visible answer"},
            {"type": "tool_use", "input": {"secret": "not an answer"}},
            {"type": "text", "text": "Second paragraph"},
        ]
        self.assertEqual(text_parts(content), "Visible answer\n\nSecond paragraph")

    def test_tool_results_do_not_replace_the_user_request(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            path = home / ".cursor/projects/example/agent-transcripts/chat.jsonl"
            path.parent.mkdir(parents=True)
            records = [
                {
                    "role": "user",
                    "message": {
                        "content": [{"type": "text", "text": "Fix the parser."}]
                    },
                },
                {
                    "role": "user",
                    "message": {
                        "content": [
                            {
                                "type": "tool_result",
                                "content": "Quoted refusal in tool output",
                            }
                        ]
                    },
                },
                {
                    "role": "assistant",
                    "message": {
                        "content": [{"type": "text", "text": "The parser is fixed."}]
                    },
                },
                {"summary": "Compacted history is not an original assistant reply"},
            ]
            path.write_text(
                "\n".join(json.dumps(value) for value in records), encoding="utf-8"
            )
            replies = []

            def capture(source, ref, conversation, text, prompt="", **kwargs):
                if text.strip():
                    replies.append((text, prompt))

            extract_archives(home, capture, Counter(), lambda raw: ("", False))
            self.assertEqual(replies, [("The parser is fixed.", "Fix the parser.")])


if __name__ == "__main__":
    unittest.main()
