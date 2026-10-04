"""External programs (LibreOffice, pdftoppm, Tesseract) run from the parse process.

They stay in the parse process's group, so the supervisor's timeout kills them together with it. Each gets its
own address-space cap: they map far more virtual memory than they use, so the parse process cap does not fit them.
"""

from __future__ import annotations

import resource
import signal
import subprocess
from collections.abc import Callable
from pathlib import Path

from docparse.errors import ErrorCode, ParseFailure


def _address_space_cap(megabytes: int) -> Callable[[], None]:
    def apply() -> None:
        cap = megabytes << 20
        _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        resource.setrlimit(resource.RLIMIT_AS, (cap, hard))

    return apply


def run_tool(
    cmd: list[str],
    *,
    memory_mb: int,
    env: dict[str, str],
    cwd: Path,
    failure: str,
) -> bytes:
    """Run a tool and return its stdout. A crash or a non-zero exit is a property of the input file
    (`corrupt`); a SIGKILL comes from the container OOM killer (`memory_exceeded`)."""
    completed = subprocess.run(  # noqa: S603 - fixed argument vectors, no shell
        cmd,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        env=env,
        cwd=cwd,
        # preexec_fn is safe here: the parse process is single-threaded.
        preexec_fn=_address_space_cap(memory_mb),
        check=False,
    )
    if completed.returncode == -signal.SIGKILL:
        raise ParseFailure(ErrorCode.MEMORY_EXCEEDED, f"{failure}: killed for exceeding memory")
    if completed.returncode != 0:
        raise ParseFailure(ErrorCode.CORRUPT, failure)
    return completed.stdout
