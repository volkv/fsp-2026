"""HTTP interface of docparse/v1: `POST /v1/parse` and `GET /v1/health`.

Starlette is enough here: two routes, streaming multipart with limits, and an event loop that supervises parse
processes without a thread per request. The response schema lives in `contracts/docparse/v1.schema.json`,
so there is no model layer to keep in sync.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
from collections.abc import AsyncIterator
from pathlib import Path, PurePath

from starlette.applications import Starlette
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.types import Message, Receive

from docparse.errors import ERROR_SPECS, ErrorCode, error_body
from docparse.limits import Limits
from docparse.parser import FORMATS
from docparse.supervisor import run_parse
from docparse.version import extractor

log = logging.getLogger("docparse")

MULTIPART_OVERHEAD = 64 * 1024
REQUIRED_TOOLS = ("soffice", "pdftoppm", "tesseract")
REQUIRED_OCR_LANGUAGES = {"rus", "eng"}
_MAX_FIELD_BYTES = 1024


class _BodyTooLarge(Exception):
    pass


def _limited(receive: Receive, max_bytes: int) -> Receive:
    received = 0

    async def limited_receive() -> Message:
        nonlocal received
        message = await receive()
        if message["type"] == "http.request":
            received += len(message.get("body", b""))
            if received > max_bytes:
                raise _BodyTooLarge
        return message

    return limited_receive


def _error_response(code: ErrorCode, message: str, status: int | None = None) -> JSONResponse:
    return JSONResponse(error_body(code, message), status_code=status or ERROR_SPECS[code].http_status)


def _check_environment(scratch_root: Path) -> None:
    paths = {tool: shutil.which(tool) for tool in REQUIRED_TOOLS}
    missing = [tool for tool, path in paths.items() if path is None]
    if missing:
        raise RuntimeError(f"Required tools are not installed: {', '.join(missing)}")
    tesseract = paths["tesseract"]
    assert tesseract is not None  # noqa: S101 - checked above
    languages = subprocess.run(  # noqa: S603 - fixed argument vector
        [tesseract, "--list-langs"], capture_output=True, text=True, check=True
    ).stdout.split()
    absent = REQUIRED_OCR_LANGUAGES.difference(languages)
    if absent:
        raise RuntimeError(f"Tesseract language models are missing: {', '.join(sorted(absent))}")
    if not os.access(scratch_root, os.W_OK):
        raise RuntimeError(f"Scratch directory {scratch_root} is not writable")
    extractor()


def _configure_logging() -> None:
    """One JSON object per line on stdout; uvicorn keeps its own loggers."""
    if not log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        log.addHandler(handler)
        log.setLevel(logging.INFO)
        log.propagate = False


def create_app(limits: Limits | None = None, scratch_root: Path | None = None) -> Starlette:
    _configure_logging()
    limits = limits or Limits.from_env()
    root = scratch_root or Path(tempfile.gettempdir())
    slots = asyncio.Semaphore(limits.max_concurrent)

    async def health(_: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "extractor": extractor(), "formats": list(FORMATS)})

    async def parse(request: Request) -> Response:
        # Checked and taken without awaiting in between, so two requests cannot both see a free slot.
        if slots.locked():
            return _error_response(ErrorCode.BUSY, "All parse slots are busy")
        async with slots:
            return await _parse(request)

    async def _parse(request: Request) -> Response:
        started = time.perf_counter()
        max_body = limits.max_file_bytes + MULTIPART_OVERHEAD
        declared_length = request.headers.get("content-length")
        if declared_length is not None and declared_length.isdigit() and int(declared_length) > max_body:
            return _error_response(ErrorCode.TOO_LARGE, "File exceeds size limit")
        bounded = Request(request.scope, _limited(request.receive, max_body))
        try:
            async with bounded.form(max_files=1, max_fields=2, max_part_size=_MAX_FIELD_BYTES) as form:
                upload = form.get("file")
                request_id = form.get("request_id")
                declared_name = form.get("declared_name")
                if not isinstance(upload, UploadFile):
                    return _error_response(ErrorCode.BAD_REQUEST, "Multipart part 'file' is required")
                data = await upload.read()
        except _BodyTooLarge:
            return _error_response(ErrorCode.TOO_LARGE, "File exceeds size limit")
        if len(data) > limits.max_file_bytes:
            return _error_response(ErrorCode.TOO_LARGE, "File exceeds size limit")
        request_ref = request_id if isinstance(request_id, str) else ""
        outcome = await run_parse(data, limits, root, request_ref)
        # The declared name is personal data more often than not: only its extension is logged.
        extension = PurePath(declared_name).suffix.lower()[:16] if isinstance(declared_name, str) else ""
        log.info(
            json.dumps(
                {
                    "event": "parse",
                    "requestId": request_ref[:128],
                    "declaredExtension": extension,
                    "sizeBytes": len(data),
                    "status": outcome.status,
                    "error": outcome.error_code.value if outcome.error_code else None,
                    "durationMs": round((time.perf_counter() - started) * 1000),
                }
            )
        )
        return Response(outcome.body, status_code=outcome.status, media_type="application/json")

    async def http_error(_: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, HTTPException)  # noqa: S101 - registered for HTTPException only
        return _error_response(ErrorCode.BAD_REQUEST, str(exc.detail), status=exc.status_code)

    async def unexpected_error(_: Request, exc: Exception) -> JSONResponse:
        log.error(json.dumps({"event": "request_failed", "error": type(exc).__qualname__}))
        return _error_response(ErrorCode.INTERNAL, "Unexpected server error")

    @contextlib.asynccontextmanager
    async def lifespan(_: Starlette) -> AsyncIterator[None]:
        _check_environment(root)
        yield

    return Starlette(
        routes=[
            Route("/v1/parse", parse, methods=["POST"]),
            Route("/v1/health", health, methods=["GET"]),
        ],
        exception_handlers={HTTPException: http_error, Exception: unexpected_error},
        lifespan=lifespan,
    )
