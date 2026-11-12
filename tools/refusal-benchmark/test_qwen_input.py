import pathlib
import tempfile
import unittest

from qwen_input import prepare


class CharacterTokenizer:
    def encode(self, text, add_special_tokens=False):
        return [ord(character) for character in text]

    def decode(self, tokens):
        return "".join(chr(token) for token in tokens)

    def apply_chat_template(self, messages, tokenize=False):
        return messages[0]["content"] + "\nASSISTANT:\n" + messages[1]["content"]


class QwenInputTests(unittest.TestCase):
    def test_late_refusal_survives_response_windows(self):
        tokenizer = CharacterTokenizer()
        response = "Background. " * 6000 + "I cannot help with that request."
        jobs = prepare(tokenizer, [("example", response, "Please help.")])
        self.assertGreater(len(jobs), 1)
        self.assertTrue(
            any(
                "I cannot help with that request." in tokenizer.decode(ids)
                for _, _, ids in jobs
            )
        )
        self.assertTrue(all(len(ids) + 128 <= 32768 for _, _, ids in jobs))

    def test_prompt_omissions_are_counted(self):
        jobs = prepare(CharacterTokenizer(), [("example", "Answer", "P" * 3000)])
        self.assertEqual(jobs[0][1], 952)

    def test_cache_invalidates_changed_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "inputs.sqlite"
            tokenizer = CharacterTokenizer()
            first = prepare(tokenizer, [("example", "First answer", "Question")], path)
            cached = prepare(tokenizer, [("example", "First answer", "Question")], path)
            changed = prepare(tokenizer, [("example", "New answer", "Question")], path)
            self.assertEqual(first, [tuple(item) for item in cached])
            self.assertNotEqual(first, changed)


if __name__ == "__main__":
    unittest.main()
