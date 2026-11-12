import json
import unittest

from extract import parse_response


class ResponseParsingTests(unittest.TestCase):
    def test_streaming_snapshot_is_not_duplicated(self):
        raw = (
            'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'
            'data: {"type":"response.output_text.done","text":"hello"}\n\n'
            'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"hello"}]}]}}\n\n'
        )
        self.assertEqual(parse_response(raw), ("hello", False))

    def test_thinking_and_tools_are_excluded(self):
        raw = (
            'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private"}}\n\n'
            'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n'
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\n\n'
        )
        self.assertEqual(parse_response(raw), ("answer", False))

    def test_explicit_refusal(self):
        self.assertEqual(
            parse_response('data: {"type":"response.refusal.delta","delta":"No"}\n\n'),
            ("No", True),
        )

    def test_chat(self):
        self.assertEqual(
            parse_response(
                'data: {"choices":[{"delta":{"content":"Answer"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
            ),
            ("Answer", False),
        )

    def test_connect_frames_exclude_thinking(self):
        def frame(value):
            body = json.dumps(value).encode()
            return b"\0" + len(body).to_bytes(4, "big") + body

        raw = frame({"deltaThinking": "private"}) + frame(
            {"deltaText": "answer", "usage": {"providerRefusal": True}}
        )
        self.assertEqual(parse_response(raw), ("answer", True))


if __name__ == "__main__":
    unittest.main()
