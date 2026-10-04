"""What an extractor needs besides the file: limits, a private scratch directory and the OCR signal."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from docparse.limits import Limits


@dataclass(frozen=True)
class ParseContext:
    limits: Limits
    workdir: Path
    # Called once before the first OCR run: the supervisor then extends the deadline to the OCR limit.
    on_ocr_start: Callable[[], None]

    def tool_env(self) -> dict[str, str]:
        """Environment for external tools: no inherited variables (proxies included), home in the scratch directory."""
        return {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(self.workdir),
            "TMPDIR": str(self.workdir),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "OMP_THREAD_LIMIT": "1",
        }
