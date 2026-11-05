"""Dependency-free output redaction for the Gemini acceptance harness."""

from __future__ import annotations

import atexit
import io
import json
import re
import sys
from pathlib import Path
from typing import TextIO

SECRET_PATTERN = re.compile(r"AIza[0-9A-Za-z_\-]{30,}|AQ\.[0-9A-Za-z_\-]{20,}")


def redact(text: str) -> str:
    return SECRET_PATTERN.sub("<redacted>", text)


def write_report(path: str | Path, report: object) -> None:
    Path(path).write_text(redact(json.dumps(report, indent=2, ensure_ascii=False)) + "\n")


class RedactingStream(io.TextIOBase):
    """Keep incomplete lines private, even across flush(), until finish/exit.

    Logging and traceback printers can split a key over multiple writes. A
    per-write substitution (or flushing a partial line) would expose fragments.
    """

    def __init__(self, stream: TextIO):
        self._stream = stream
        self._pending = ""

    @property
    def encoding(self) -> str | None:
        return self._stream.encoding

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return self._stream.isatty()

    def write(self, text: str) -> int:
        self._pending += text
        complete, newline, self._pending = self._pending.rpartition("\n")
        if newline:
            self._stream.write(redact(complete + newline))
        return len(text)

    def flush(self) -> None:
        self._stream.flush()

    def finish(self) -> None:
        self._stream.write(redact(self._pending))
        self._pending = ""
        self.flush()


def install_console_redaction() -> None:
    """Install before SDK imports so their logging and uncaught errors are covered."""
    sys.stdout = RedactingStream(sys.stdout)
    sys.stderr = RedactingStream(sys.stderr)
    # Runs after uncaught tracebacks, including a final line without a newline.
    atexit.register(sys.stdout.finish)
    atexit.register(sys.stderr.finish)
