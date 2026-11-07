"""Offline regression tests. Every key-shaped value below is fabricated."""

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from gemini_redaction import RedactingStream, redact, write_report

ROOT = Path(__file__).resolve().parent.parent
STANDARD = "AIza" + "aB0_-" * 7  # 39 characters, synthetic.
AUTH = "AQ." + "cD1_-" * 10  # 53 characters, synthetic.
CONTEXTS = {
    "json": lambda value: json.dumps({"key": value}),
    "plain": lambda value: f"key: {value}\n",
    "url": lambda value: f"https://example.invalid/?key={value}&alt=json",
    "error": lambda value: f"RuntimeError: invalid API key '{value}' (403)",
}


class GeminiRedactionTests(unittest.TestCase):
    def test_both_formats_in_every_context(self):
        self.assertEqual(len(STANDARD), 39)
        self.assertEqual(len(AUTH), 53)
        for key in (STANDARD, AUTH):
            for name, context in CONTEXTS.items():
                with self.subTest(format=key[:4], context=name):
                    self.assertEqual(redact(context(key)), context("<redacted>"))

    def test_thresholds_and_below_thresholds(self):
        for prefix, threshold in (("AIza", 30), ("AQ.", 20)):
            for length in (threshold - 1, threshold, threshold + 1):
                key = prefix + "x" * length
                expected = "<redacted>" if length >= threshold else key
                for name, context in CONTEXTS.items():
                    with self.subTest(prefix=prefix, length=length, context=name):
                        self.assertEqual(redact(context(key)), context(expected))

    def test_prose_and_ordinary_values_are_unchanged(self):
        text = 'AQ. is an abbreviation. AQ.short_note AIza-not-a-key; 日本語; 0x123; 1000000000000000000'
        self.assertEqual(redact(text), text)

    def test_multiple_keys_and_idempotence(self):
        text = f'{STANDARD},"{AUTH}"/{STANDARD}'
        expected = '<redacted>,"<redacted>"/<redacted>'
        self.assertEqual(redact(text), expected)
        self.assertEqual(redact(expected), expected)

    def test_report_file_redacts_nested_values_and_preserves_json(self):
        report = {"answer": f"日本語 {STANDARD}", "errors": [CONTEXTS["error"](AUTH)], "count": 2}
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "report.json"
            write_report(out, report)
            text = out.read_text()
        self.assertEqual(json.loads(text), {
            "answer": "日本語 <redacted>",
            "errors": [CONTEXTS["error"]("<redacted>")],
            "count": 2,
        })
        self.assertTrue(text.endswith("\n"))

    def test_console_handles_every_write_split_even_with_flush(self):
        for key in (STANDARD, AUTH):
            for split in range(len(key) + 1):
                with self.subTest(format=key[:4], split=split):
                    output = io.StringIO()
                    stream = RedactingStream(output)
                    stream.write(key[:split])
                    stream.flush()
                    self.assertEqual(output.getvalue(), "")
                    stream.write(key[split:] + "\n")
                    self.assertEqual(output.getvalue(), "<redacted>\n")

    def test_console_finishes_unterminated_line_once(self):
        output = io.StringIO()
        stream = RedactingStream(output)
        self.assertEqual(stream.write(f"ordinary\n{AUTH}"), len(f"ordinary\n{AUTH}"))
        self.assertEqual(output.getvalue(), "ordinary\n")
        stream.finish()
        stream.finish()
        self.assertEqual(output.getvalue(), "ordinary\n<redacted>")

    def test_entrypoint_guards_sdk_logging_stdout_and_uncaught_errors(self):
        # Fail in the first SDK import: no ADK installation, network or keys.
        # A fresh process also exercises real traceback and atexit handling.
        stub = '''import logging, sys
standard = "AIza" + "aB0_-" * 7
auth = "AQ." + "cD1_-" * 10
logging.warning("SDK key: %s", standard)
sys.stdout.write(auth[:10])
sys.stdout.flush()
sys.stdout.write(auth[10:])
raise RuntimeError("SDK failure: " + auth)
'''
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "httpx.py").write_text(stub)
            result = subprocess.run(
                [sys.executable, "-B", str(ROOT / "script/gemini-adk-acceptance.py")],
                env={"PATH": os.defpath, "PYTHONPATH": directory},
                capture_output=True, text=True, timeout=10,
            )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "<redacted>")
        self.assertIn("SDK key: <redacted>", result.stderr)
        self.assertIn("RuntimeError: SDK failure: <redacted>", result.stderr)
        self.assertNotIn(STANDARD, result.stderr)
        self.assertNotIn(AUTH, result.stderr)


if __name__ == "__main__":
    unittest.main()
