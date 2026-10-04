"""Error codes of the docparse/v1 contract and the controlled failure raised by extractors."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class ErrorCode(StrEnum):
    UNSUPPORTED_FORMAT = "unsupported_format"
    TOO_LARGE = "too_large"
    UNPACKED_TOO_LARGE = "unpacked_too_large"
    ENCRYPTED = "encrypted"
    CORRUPT = "corrupt"
    NO_TEXT = "no_text"
    TIMEOUT = "timeout"
    MEMORY_EXCEEDED = "memory_exceeded"
    BUSY = "busy"
    INTERNAL = "internal"
    BAD_REQUEST = "bad_request"


@dataclass(frozen=True)
class ErrorSpec:
    http_status: int
    retryable: bool


ERROR_SPECS: dict[ErrorCode, ErrorSpec] = {
    ErrorCode.UNSUPPORTED_FORMAT: ErrorSpec(415, retryable=False),
    ErrorCode.TOO_LARGE: ErrorSpec(413, retryable=False),
    ErrorCode.UNPACKED_TOO_LARGE: ErrorSpec(422, retryable=False),
    ErrorCode.ENCRYPTED: ErrorSpec(422, retryable=False),
    ErrorCode.CORRUPT: ErrorSpec(422, retryable=False),
    ErrorCode.NO_TEXT: ErrorSpec(422, retryable=False),
    ErrorCode.TIMEOUT: ErrorSpec(504, retryable=True),
    ErrorCode.MEMORY_EXCEEDED: ErrorSpec(507, retryable=False),
    ErrorCode.BUSY: ErrorSpec(503, retryable=True),
    ErrorCode.INTERNAL: ErrorSpec(500, retryable=True),
    ErrorCode.BAD_REQUEST: ErrorSpec(400, retryable=False),
}


class ParseFailure(Exception):
    """A controlled, expected failure: maps to an error response of the contract.

    The message goes to the caller and to logs, so it never contains document content or personal data.
    """

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def error_body(code: ErrorCode, message: str) -> dict[str, object]:
    return {"error": {"code": code.value, "retryable": ERROR_SPECS[code].retryable, "message": message}}
