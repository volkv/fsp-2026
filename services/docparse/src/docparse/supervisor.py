"""Runs one parse in a child process with a deadline and turns its outcome into an HTTP status and body.

Each request gets a private scratch directory, removed when the request ends. The child is the leader of its
own process group; the converters and OCR it starts stay in that group, so on timeout the whole group is killed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from docparse.errors import ERROR_SPECS, ErrorCode, error_body
from docparse.limits import Limits
from docparse.worker import EXIT_FAILURE, OCR_EVENT

log = logging.getLogger("docparse")

_STDERR_TAIL = 4000


@dataclass(frozen=True)
class Outcome:
    status: int
    body: bytes
    error_code: ErrorCode | None


def _error(code: ErrorCode, message: str) -> Outcome:
    body = json.dumps(error_body(code, message), ensure_ascii=False).encode("utf-8")
    return Outcome(ERROR_SPECS[code].http_status, body, code)


async def _tail(stream: asyncio.StreamReader) -> bytes:
    tail = b""
    while chunk := await stream.read(1 << 16):
        tail = (tail + chunk)[-_STDERR_TAIL:]
    return tail


def _worker_env(workdir: Path) -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "PYTHONPATH": os.environ.get("PYTHONPATH", ""),
        "PYTHONDONTWRITEBYTECODE": "1",
        "HOME": str(workdir),
        "TMPDIR": str(workdir),
        "LANG": "C.UTF-8",
    }


def _kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        # The group is already gone: every process in it has exited.
        return


async def run_parse(data: bytes, limits: Limits, scratch_root: Path, request_id: str) -> Outcome:
    workdir = Path(tempfile.mkdtemp(prefix="parse-", dir=scratch_root))
    try:
        source = workdir / "input"
        source.write_bytes(data)
        return await _supervise(source, workdir, limits, request_id)
    finally:
        shutil.rmtree(workdir)


async def _spawn(source: Path, workdir: Path, limits: Limits, events_fd: int) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "docparse.worker",
        "--input",
        str(source),
        "--workdir",
        str(workdir),
        "--events-fd",
        str(events_fd),
        "--limits",
        json.dumps(limits.to_json()),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        pass_fds=(events_fd,),
        start_new_session=True,
        env=_worker_env(workdir),
        cwd=workdir,
    )


async def _wait_within_deadline(
    exit_task: asyncio.Task[int], events: asyncio.StreamReader, limits: Limits
) -> tuple[bool, bool]:
    """Wait for the parse process; the budget grows to the OCR limit once it announces OCR.
    Returns (timed_out, ocr_started)."""
    loop = asyncio.get_running_loop()
    started = loop.time()
    ocr_started = False
    event_task: asyncio.Task[bytes] | None = asyncio.create_task(events.readline())
    try:
        while not exit_task.done():
            budget = limits.ocr_timeout_s if ocr_started else limits.timeout_s
            remaining = started + budget - loop.time()
            if remaining <= 0:
                return True, ocr_started
            waiting: list[asyncio.Task[Any]] = [exit_task] if event_task is None else [exit_task, event_task]
            await asyncio.wait(waiting, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
            if event_task is not None and event_task.done():
                ocr_started = event_task.result() == OCR_EVENT
                event_task = None
        return False, ocr_started
    finally:
        if event_task is not None:
            event_task.cancel()


async def _supervise(source: Path, workdir: Path, limits: Limits, request_id: str) -> Outcome:
    read_fd, write_fd = os.pipe()
    try:
        process = await _spawn(source, workdir, limits, write_fd)
    except BaseException:
        os.close(read_fd)
        raise
    finally:
        os.close(write_fd)
    events = asyncio.StreamReader()
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(events), os.fdopen(read_fd, "rb", buffering=0)
    )
    if process.stdout is None or process.stderr is None:
        raise RuntimeError("Parse process was started without output pipes")
    stdout_task = asyncio.create_task(process.stdout.read())
    stderr_task = asyncio.create_task(_tail(process.stderr))
    exit_task = asyncio.create_task(process.wait())
    try:
        timed_out, ocr_started = await _wait_within_deadline(exit_task, events, limits)
    finally:
        # Killed while not yet reaped, the group id cannot belong to anyone else.
        if process.returncode is None:
            _kill_group(process.pid)
        returncode = await exit_task
        stdout = await stdout_task
        stderr = await stderr_task
        transport.close()

    if timed_out:
        budget = limits.ocr_timeout_s if ocr_started else limits.timeout_s
        log.warning(json.dumps({"event": "parse_timeout", "requestId": request_id, "ocr": ocr_started}))
        return _error(ErrorCode.TIMEOUT, f"Parsing took longer than {budget:g} s")
    return _outcome(returncode, stdout, stderr, process.pid, request_id)


def _outcome(returncode: int, stdout: bytes, stderr: bytes, pid: int, request_id: str) -> Outcome:
    if returncode == 0:
        return Outcome(200, stdout, None)
    if returncode == EXIT_FAILURE:
        failure = json.loads(stdout)
        return _error(ErrorCode(failure["code"]), failure["message"])
    # Tools may outlive a crashed parse process; the group keeps its id while any of them runs.
    _kill_group(pid)
    if returncode == -signal.SIGKILL:
        # Nobody but the kernel OOM killer sends SIGKILL to a parse process that has not timed out.
        return _error(ErrorCode.MEMORY_EXCEEDED, "Parse process was killed for exceeding memory")
    log.error(
        json.dumps(
            {
                "event": "parse_crashed",
                "requestId": request_id,
                "exitCode": returncode,
                "stderr": stderr.decode("utf-8", errors="replace"),
            }
        )
    )
    return _error(ErrorCode.INTERNAL, "Parser failed unexpectedly")
