"""PDF: words with coordinates from pdfplumber (pdfminer.six), tables (see `tables.py`), reading order from XY-cut
for the text around them, OCR for pages without text.

Nothing in a PDF is executed or fetched. Active content (JavaScript, launch and remote actions, URL file
specifications) is only detected and reported as `externalResourcesIgnored`.
"""

from __future__ import annotations

import statistics
from pathlib import Path

import pdfplumber
from pdfminer.pdfdocument import PDFEncryptionError, PDFException, PDFPasswordIncorrect
from pdfminer.psexceptions import PSException
from pdfplumber.page import Page
from pdfplumber.utils.exceptions import MalformedPDFException, PdfminerException
from pypdf import PdfReader
from pypdf.errors import PyPdfError
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, PdfObject

from docparse.context import ParseContext
from docparse.document import DocumentBuilder
from docparse.errors import ErrorCode, ParseFailure
from docparse.layout import Word, region_blocks, xy_cut
from docparse.ocr import OcrSession
from docparse.tables import PageTable, add_table, aligned_tables, link_continuations, ruled_tables, words_of

DEFAULT_FONT_SIZE = 10.0
MIN_TEXT_CHARS = 5  # a page with fewer usable characters is treated as having no text layer
_UNMAPPED_GLYPH = "(cid:"  # pdfminer's rendering of a glyph without a Unicode mapping

_ACTIVE_ACTIONS = {"/JavaScript", "/Launch", "/GoToR", "/GoToE", "/ImportData", "/SubmitForm"}
_MAX_OBJECT_DEPTH = 64


def _open_failure(error: Exception) -> ParseFailure:
    cause = error.args[0] if isinstance(error, PdfminerException) and error.args else error
    if isinstance(cause, PDFPasswordIncorrect | PDFEncryptionError):
        return ParseFailure(ErrorCode.ENCRYPTED, "PDF is password protected")
    return ParseFailure(ErrorCode.CORRUPT, "PDF structure cannot be read")


def _words(page: Page) -> list[Word]:
    return [
        Word(w["text"], w["x0"], w["x1"], w["top"], w["bottom"], w["size"])
        for w in page.extract_words(keep_blank_chars=False, use_text_flow=False, extra_attrs=["size"])
    ]


def _has_text_layer(words: list[Word]) -> bool:
    usable = sum(len(w.text) for w in words if _UNMAPPED_GLYPH not in w.text)
    return usable >= MIN_TEXT_CHARS


def _has_graphics(page: Page) -> bool:
    """Images or vector outlines: what a page without a text layer shows when it still has content."""
    return bool(page.images or page.curves)


def extract_pdf(path: Path, builder: DocumentBuilder, ctx: ParseContext) -> None:
    ocr = OcrSession(ctx, builder)
    try:
        with pdfplumber.open(path) as pdf:
            pages = pdf.pages
            builder.page_count = len(pages)
            if len(pages) > ctx.limits.max_pages:
                builder.mark_incomplete("page_limit")
            selected = pages[: ctx.limits.max_pages]
            words_per_page = [_words(page) for page in selected]
            sizes = [w.size for words in words_per_page for w in words]
            median = statistics.median(sizes) if sizes else DEFAULT_FONT_SIZE
            for page_no, (page, words) in enumerate(zip(selected, words_per_page, strict=True), start=1):
                if not _has_text_layer(words):
                    if _has_graphics(page):
                        ocr.pdf_page(path, page_no, float(page.width), float(page.height))
                    continue
                _page_content(page, page_no, median, builder)
    except (PdfminerException, MalformedPDFException, PSException, PDFException) as e:
        raise _open_failure(e) from e
    ocr.finish()
    link_continuations(builder)
    builder.external_resources = _has_active_content(path)


def _page_content(page: Page, page_no: int, median: float, builder: DocumentBuilder) -> None:
    """Tables and the text around them in reading order: the text above the first table, the table, the text beside
    and below it up to the next table, and so on."""
    ruled, free_chars = ruled_tables(page)
    aligned, free_words = aligned_tables(words_of(free_chars), median)
    tables: list[PageTable] = sorted(ruled + aligned, key=lambda t: (t.bbox[1], t.bbox[0]))
    parts: list[list[Word]] = [[] for _ in range(len(tables) + 1)]
    for word in free_words:
        center = (word.top + word.bottom) / 2
        parts[sum(1 for t in tables if t.bbox[1] <= center)].append(word)
    for n, part in enumerate(parts):
        if part:
            for region in xy_cut(part, median):
                for kind, text in region_blocks(region.words, median):
                    builder.add(text, kind, page_no, region.column)
        if n < len(tables):
            add_table(builder, page_no, tables[n])


def _has_active_content(path: Path) -> bool:
    """Walk the object graph from the catalog looking for actions that would run code or fetch something."""
    try:
        reader = PdfReader(path)
        root = reader.trailer["/Root"]
    except (PyPdfError, KeyError, ValueError) as e:
        raise ParseFailure(ErrorCode.CORRUPT, "PDF structure cannot be read") from e
    seen: set[int] = set()
    stack: list[tuple[PdfObject, int]] = [(root, 0)]
    while stack:
        obj, depth = stack.pop()
        if depth > _MAX_OBJECT_DEPTH:
            continue
        if isinstance(obj, IndirectObject):
            if obj.idnum in seen:
                continue
            seen.add(obj.idnum)
            try:
                obj = obj.get_object()
            except (PyPdfError, ValueError) as e:
                raise ParseFailure(ErrorCode.CORRUPT, "PDF structure cannot be read") from e
        if isinstance(obj, DictionaryObject):
            if obj.get("/S") in _ACTIVE_ACTIONS or "/JS" in obj or obj.get("/FS") == "/URL":
                return True
            stack.extend((value, depth + 1) for value in obj.values())
        elif isinstance(obj, ArrayObject):
            stack.extend((value, depth + 1) for value in obj)
    return False
