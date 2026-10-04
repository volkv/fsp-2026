"""Parse process: one per request, started by the supervisor.

It caps its own address space before importing the parsers, so a document that needs more memory ends in a
MemoryError that is reported as `memory_exceeded` instead of taking the container down. It also volunteers as
the first victim of the container OOM killer. Protocol:

- stdout: the docparse/v1 response (exit 0) or `{"code", "message"}` of a controlled failure (exit 2);
- events fd: a line `ocr` before the first OCR run;
- stderr: diagnostics without document content.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import sys
import traceback
from pathlib import Path

from docparse.context import ParseContext
from docparse.errors import ErrorCode, ParseFailure
from docparse.limits import Limits

EXIT_FAILURE = 2
EXIT_CRASH = 1
OCR_EVENT = b"ocr\n"


def _cap_memory(megabytes: int) -> None:
    # Only the soft limit: external tools raise it to their own cap (see tools.py).
    _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    resource.setrlimit(resource.RLIMIT_AS, (megabytes << 20, hard))
    Path("/proc/self/oom_score_adj").write_text("1000", encoding="ascii")


def _emit(payload: dict[str, object]) -> None:
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    sys.stdout.buffer.flush()


def _failure(code: ErrorCode, message: str) -> int:
    _emit({"code": code.value, "message": message})
    return EXIT_FAILURE


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="docparse.worker")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--workdir", type=Path, required=True)
    parser.add_argument("--events-fd", type=int, required=True)
    parser.add_argument("--limits", type=json.loads, required=True)
    args = parser.parse_args(argv)
    limits = Limits(**args.limits)
    _cap_memory(limits.worker_memory_mb)

    events = os.fdopen(args.events_fd, "wb", buffering=0)

    def announce_ocr() -> None:
        events.write(OCR_EVENT)

    ctx = ParseContext(limits=limits, workdir=args.workdir, on_ocr_start=announce_ocr)
    try:
        # Imported under the memory cap: the parsers and their native libraries count against it.
        from docparse.parser import parse_file  # noqa: PLC0415
        from docparse.version import extractor  # noqa: PLC0415

        _emit(parse_file(args.input, ctx, extractor()))
    except ParseFailure as failure:
        return _failure(failure.code, failure.message)
    except MemoryError:
        return _failure(ErrorCode.MEMORY_EXCEEDED, "Document needs more memory than allowed")
    except Exception as e:  # noqa: BLE001 - reported as `internal` with a traceback of code locations only
        # Exception messages may quote document content, so only the type and the stack go to the log.
        frames = "".join(traceback.format_tb(e.__traceback__))
        sys.stderr.write(f"{frames}{type(e).__module__}.{type(e).__qualname__}\n")
        return EXIT_CRASH
    finally:
        events.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
