"""Plain text: UTF-8 or UTF-16 with a byte order mark, UTF-8, or a Cyrillic single-byte encoding."""

from __future__ import annotations

import codecs
import re

from charset_normalizer import from_bytes

from docparse.document import DocumentBuilder
from docparse.errors import ErrorCode, ParseFailure

_LEGACY_ENCODINGS = ["cp1251", "koi8_r", "cp866"]
_BINARY_CONTROL = re.compile(r"[\x00-\x08\x0e-\x1f\x7f]")
_MAX_CONTROL_SHARE = 0.01
_PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n")


def _decode(data: bytes) -> str:
    if data.startswith(codecs.BOM_UTF8):
        return data[len(codecs.BOM_UTF8) :].decode("utf-8", errors="strict")
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return data.decode("utf-16", errors="strict")
    try:
        return data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as e:
        best = from_bytes(data, cp_isolation=_LEGACY_ENCODINGS).best()
        if best is None:
            raise ParseFailure(ErrorCode.UNSUPPORTED_FORMAT, "File is neither a known document format nor text") from e
        return str(best)


def extract_text(data: bytes, builder: DocumentBuilder) -> None:
    try:
        text = _decode(data)
    except UnicodeDecodeError as e:
        raise ParseFailure(ErrorCode.CORRUPT, "Text is not valid in its declared encoding") from e
    if len(_BINARY_CONTROL.findall(text)) > _MAX_CONTROL_SHARE * max(len(text), 1):
        raise ParseFailure(ErrorCode.UNSUPPORTED_FORMAT, "File is neither a known document format nor text")
    builder.page_count = None
    for paragraph in _PARAGRAPH_BREAK.split(text.replace("\r\n", "\n").replace("\r", "\n")):
        builder.add(paragraph, "paragraph", None)
