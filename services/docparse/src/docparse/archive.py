"""Checks for ZIP-based documents (DOCX, ODT) before any library opens them.

Archive limits are enforced twice: on the sizes declared in the central directory and on the bytes actually
produced while decompressing, because declared sizes can lie. XML parts must not carry a document type
declaration: neither OOXML nor ODF allows one, and a DTD is how external entities (XXE) and entity expansion
bombs get in. Such files are rejected explicitly instead of being parsed with entities silently dropped.
"""

from __future__ import annotations

import zipfile
import zlib
from pathlib import Path

from docparse.errors import ErrorCode, ParseFailure
from docparse.limits import Limits

_CHUNK = 1 << 16
_DTD_MARKERS = tuple(
    marker.encode(encoding) for marker in ("<!DOCTYPE", "<!ENTITY") for encoding in ("utf-8", "utf-16-le", "utf-16-be")
)
_MARKER_TAIL = max(len(m) for m in _DTD_MARKERS) - 1
_XML_SUFFIXES = (".xml", ".rels", ".xhtml", ".svg")


def _is_xml_part(name: str) -> bool:
    return name.lower().endswith(_XML_SUFFIXES)


def inspect_archive(path: Path, limits: Limits) -> list[str]:
    """Validate a ZIP document and return its member names."""
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, zipfile.LargeZipFile) as e:
        raise ParseFailure(ErrorCode.CORRUPT, "Broken ZIP container") from e
    with archive:
        members = archive.infolist()
        if len(members) > limits.max_archive_entries:
            raise ParseFailure(ErrorCode.UNPACKED_TOO_LARGE, "Archive has too many entries")
        if sum(m.file_size for m in members) > limits.max_unpacked_bytes:
            raise ParseFailure(ErrorCode.UNPACKED_TOO_LARGE, "Archive expands beyond limit")
        total = 0
        for member in members:
            if member.flag_bits & 0x1:
                raise ParseFailure(ErrorCode.ENCRYPTED, "Archive member is encrypted")
            check_dtd = _is_xml_part(member.filename)
            tail = b""
            try:
                with archive.open(member) as stream:
                    while chunk := stream.read(_CHUNK):
                        total += len(chunk)
                        if total > limits.max_unpacked_bytes:
                            raise ParseFailure(ErrorCode.UNPACKED_TOO_LARGE, "Archive expands beyond limit")
                        if check_dtd:
                            window = tail + chunk
                            if any(marker in window for marker in _DTD_MARKERS):
                                raise ParseFailure(
                                    ErrorCode.CORRUPT, "Document type declarations are not allowed in document XML"
                                )
                            tail = window[-_MARKER_TAIL:]
            except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError) as e:
                # Wrong CRC or size (a lying header), truncated data or an unknown compression method.
                raise ParseFailure(ErrorCode.CORRUPT, "Broken ZIP member") from e
        return [m.filename for m in members]
