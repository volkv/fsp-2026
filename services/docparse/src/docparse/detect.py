"""Format detection by content signature; the declared file name is never trusted."""

from __future__ import annotations

from enum import StrEnum

from docparse.errors import ErrorCode, ParseFailure


class Container(StrEnum):
    """What the first bytes say. ZIP and OLE containers are resolved to a document format after inspection."""

    PDF = "pdf"
    RTF = "rtf"
    PNG = "png"
    JPEG = "jpeg"
    ZIP = "zip"
    OLE = "ole"
    TEXT = "text"


_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_PDF_SEARCH_WINDOW = 1024


_SIGNATURES: tuple[tuple[tuple[bytes, ...], Container], ...] = (
    ((b"{\\rtf",), Container.RTF),
    ((b"\x89PNG\r\n\x1a\n",), Container.PNG),
    ((b"\xff\xd8\xff",), Container.JPEG),
    ((b"PK\x03\x04", b"PK\x05\x06"), Container.ZIP),
    ((_OLE_MAGIC,), Container.OLE),
)


def sniff(data: bytes) -> Container:
    if not data:
        raise ParseFailure(ErrorCode.UNSUPPORTED_FORMAT, "Empty file")
    # PDF readers accept a header preceded by junk within the first kilobyte.
    if b"%PDF-" in data[:_PDF_SEARCH_WINDOW]:
        return Container.PDF
    for prefixes, container in _SIGNATURES:
        if data.startswith(prefixes):
            return container
    return Container.TEXT


ODT_MIMETYPE = b"application/vnd.oasis.opendocument.text"


def ole_kind(data: bytes) -> str:
    """Classify an OLE compound file by its stream names (stored as UTF-16LE in the directory).

    An encrypted OOXML document is an OLE file with an `EncryptedPackage` stream; a Word 97-2003 document
    has a `WordDocument` stream. Anything else (spreadsheets, presentations) is not a resume format we read.
    """
    if "EncryptedPackage".encode("utf-16-le") in data:
        return "encrypted"
    if "WordDocument".encode("utf-16-le") in data:
        return "doc"
    raise ParseFailure(ErrorCode.UNSUPPORTED_FORMAT, "OLE file is not a Word document")
