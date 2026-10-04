"""Format dispatch: one file in, one docparse/v1 response out (or a ParseFailure)."""

from __future__ import annotations

import time
import zipfile
from pathlib import Path

from docparse.archive import inspect_archive
from docparse.context import ParseContext
from docparse.detect import ODT_MIMETYPE, Container, ole_kind, sniff
from docparse.document import DetectedFormat, DocumentBuilder, build_response
from docparse.errors import ErrorCode, ParseFailure
from docparse.ocr import OcrSession
from docparse.office import convert_to_docx, odf_references_external, rtf_references_external
from docparse.ooxml import extract_docx
from docparse.pdf import extract_pdf
from docparse.plaintext import extract_text

FORMATS: tuple[DetectedFormat, ...] = ("pdf", "docx", "doc", "rtf", "odt", "txt", "png", "jpeg")


def _via_office(data: bytes, suffix: str, builder: DocumentBuilder, ctx: ParseContext) -> None:
    source = ctx.workdir / f"source.{suffix}"
    source.write_bytes(data)
    converted = convert_to_docx(source, ctx)
    inspect_archive(converted, ctx.limits)
    extract_docx(converted, builder)


def _zip_document(path: Path, data: bytes, builder: DocumentBuilder, ctx: ParseContext) -> DetectedFormat:
    names = set(inspect_archive(path, ctx.limits))
    if "word/document.xml" in names:
        extract_docx(path, builder)
        return "docx"
    if "mimetype" in names:
        with zipfile.ZipFile(path) as archive:
            is_odt = archive.read("mimetype").strip() == ODT_MIMETYPE
            parts = [archive.read(name) for name in ("content.xml", "styles.xml") if name in names]
        if is_odt:
            builder.external_resources = any(odf_references_external(part) for part in parts)
            _via_office(data, "odt", builder, ctx)
            return "odt"
    raise ParseFailure(ErrorCode.UNSUPPORTED_FORMAT, "Archive is not a Word or OpenDocument text document")


def _dispatch(path: Path, data: bytes, builder: DocumentBuilder, ctx: ParseContext) -> DetectedFormat:
    match sniff(data):
        case Container.PDF:
            extract_pdf(path, builder, ctx)
            return "pdf"
        case Container.ZIP:
            return _zip_document(path, data, builder, ctx)
        case Container.OLE:
            if ole_kind(data) == "encrypted":
                raise ParseFailure(ErrorCode.ENCRYPTED, "Document is password protected")
            _via_office(data, "doc", builder, ctx)
            return "doc"
        case Container.RTF:
            builder.external_resources = rtf_references_external(data)
            _via_office(data, "rtf", builder, ctx)
            return "rtf"
        case Container.PNG | Container.JPEG as image:
            builder.page_count = 1
            ocr = OcrSession(ctx, builder)
            ocr.image(path)
            ocr.finish()
            return "png" if image is Container.PNG else "jpeg"
        case Container.TEXT:
            extract_text(data, builder)
            return "txt"


def parse_file(path: Path, ctx: ParseContext, extractor: dict[str, str]) -> dict[str, object]:
    started = time.perf_counter()
    data = path.read_bytes()
    if len(data) > ctx.limits.max_file_bytes:
        raise ParseFailure(ErrorCode.TOO_LARGE, "File exceeds size limit")
    builder = DocumentBuilder()
    detected = _dispatch(path, data, builder, ctx)
    duration_ms = round((time.perf_counter() - started) * 1000)
    return build_response(builder, data, detected, extractor, duration_ms)
