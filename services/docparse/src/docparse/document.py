"""Result assembly: blocks in reading order become one normalized text with code point offsets; tables are grids of
cells whose text is held by blocks, so a quote from a cell is addressed in the text like any other."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Literal

from docparse.errors import ErrorCode, ParseFailure

BlockKind = Literal["heading", "paragraph", "list_item", "table_cell", "line"]
DetectedFormat = Literal["pdf", "docx", "doc", "rtf", "odt", "txt", "png", "jpeg"]
IncompleteReason = Literal[
    "page_limit",
    "ocr_low_confidence",
    "unsupported_element",
    "encrypted_part",
    "embedded_object_skipped",
]

SCHEMA_VERSION = "docparse/v1"

# C0/C1 controls except tab and line feed, plus Unicode line/paragraph separators (they become "\n").
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_SPACES = re.compile(r"[ \t\u00a0\u2000-\u200a\u202f\u205f\u3000]+")
_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


def normalize_text(raw: str) -> str:
    """Normalize one block: NFC, "\\n" line breaks, no control characters, no lone surrogates,
    runs of horizontal whitespace collapsed to one space, lines trimmed, empty lines dropped."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n").replace("\u2028", "\n").replace("\u2029", "\n")
    text = text.replace("\f", "\n").replace("\v", "\n")
    text = _LONE_SURROGATE.sub("\ufffd", text)
    text = _CONTROL.sub("", text)
    text = unicodedata.normalize("NFC", text)
    lines = (_SPACES.sub(" ", line).strip() for line in text.split("\n"))
    return "\n".join(line for line in lines if line)


@dataclass(frozen=True)
class Block:
    text: str
    kind: BlockKind
    page: int | None
    column: int | None


@dataclass
class CellDraft:
    """A cell of a table grid: its top-left grid position, its spans and the blocks (by index) holding its text."""

    row: int
    col: int
    row_span: int = 1
    col_span: int = 1
    blocks: list[int] = field(default_factory=list)


@dataclass
class TableDraft:
    """A table as an extractor found it. `bbox` is (x0, top, x1, bottom) in PDF points from the top-left corner of
    the page; `columns` are the horizontal extents of the grid columns, used to tell a table continued on the next
    page. `continues` is the index of the table this one continues."""

    page: int | None
    bbox: tuple[float, float, float, float] | None
    row_count: int
    column_count: int
    cells: list[CellDraft] = field(default_factory=list)
    columns: list[tuple[float, float]] | None = None
    continues: int | None = None
    repeated_header_rows: int = 0

    def block_range(self) -> tuple[int, int]:
        indices = [i for cell in self.cells for i in cell.blocks]
        return min(indices), max(indices)


@dataclass
class DocumentBuilder:
    """Collects blocks, tables and document-level facts while an extractor walks a file."""

    page_count: int | None = None
    blocks: list[Block] = field(default_factory=list)
    tables: list[TableDraft] = field(default_factory=list)
    ocr_pages: list[int] = field(default_factory=list)
    incomplete: set[IncompleteReason] = field(default_factory=set)
    external_resources: bool = False

    def add(self, raw: str, kind: BlockKind, page: int | None, column: int | None = None) -> int | None:
        """Adds a block; returns its index, or None when nothing is left of the text after normalization."""
        text = normalize_text(raw)
        if not text:
            return None
        self.blocks.append(Block(text, kind, page, column))
        return len(self.blocks) - 1

    def add_table(self, table: TableDraft) -> None:
        """Registers a table, possibly before its cells are filled. A table left without text is not reported: a grid
        without any is layout, not a table."""
        self.tables.append(table)

    def mark_incomplete(self, reason: IncompleteReason) -> None:
        self.incomplete.add(reason)


def build_response(
    builder: DocumentBuilder,
    data: bytes,
    detected_format: DetectedFormat,
    extractor: dict[str, str],
    duration_ms: int,
) -> dict[str, object]:
    """Assemble the docparse/v1 response. Blocks are joined with "\\n"; offsets are Unicode code points,
    which is what `len()` counts on a Python `str`."""
    if not builder.blocks:
        # Empty text is never a result: a blank page, a picture without recognizable text, an empty document.
        raise ParseFailure(ErrorCode.NO_TEXT, "Document contains no extractable text")
    parts: list[str] = []
    blocks: list[dict[str, object]] = []
    per_page: dict[str, int] = {}
    position = 0
    for block in builder.blocks:
        prefix = _prefix(block.page)
        per_page[prefix] = per_page.get(prefix, 0) + 1
        if parts:
            parts.append("\n")
            position += 1
        start = position
        parts.append(block.text)
        position += len(block.text)
        blocks.append(
            {
                "id": f"{prefix}-b{per_page[prefix]:03d}",
                "page": block.page,
                "kind": block.kind,
                "column": block.column,
                "start": start,
                "end": position,
            }
        )
    incomplete = sorted(builder.incomplete)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "extractor": extractor,
        "input": {
            "sha256": hashlib.sha256(data).hexdigest(),
            "sizeBytes": len(data),
            "detectedFormat": detected_format,
            "pageCount": builder.page_count,
        },
        "status": "partial" if incomplete else "complete",
        "text": "".join(parts),
        "blocks": blocks,
        "tables": _tables(builder, [str(b["id"]) for b in blocks]),
        "flags": {
            "ocrUsed": bool(builder.ocr_pages),
            "ocrPages": sorted(builder.ocr_pages),
            "incompleteReasons": incomplete,
            "externalResourcesIgnored": builder.external_resources,
        },
        "stats": {"durationMs": duration_ms},
    }


def _prefix(page: int | None) -> str:
    return "d" if page is None else f"p{page}"


def _tables(builder: DocumentBuilder, block_ids: list[str]) -> list[dict[str, object]]:
    """Tables in document order (a table before the tables nested in its cells), ids numbered per page like blocks.
    A cell's text is the text of its blocks joined by "\n"; spans of 1 and an empty `continues` are left out."""
    ids: dict[int, str] = {}
    per_page: dict[str, int] = {}
    for index, table in enumerate(builder.tables):
        if not any(cell.blocks for cell in table.cells):
            continue
        prefix = _prefix(table.page)
        per_page[prefix] = per_page.get(prefix, 0) + 1
        ids[index] = f"{prefix}-t{per_page[prefix]:03d}"
    result: list[dict[str, object]] = []
    for index, table_id in ids.items():
        table = builder.tables[index]
        rows: list[list[dict[str, object]]] = [[] for _ in range(table.row_count)]
        for cell in sorted(table.cells, key=lambda c: (c.row, c.col)):
            item: dict[str, object] = {"col": cell.col}
            if cell.row_span > 1:
                item["rowSpan"] = cell.row_span
            if cell.col_span > 1:
                item["colSpan"] = cell.col_span
            item["text"] = "\n".join(builder.blocks[i].text for i in cell.blocks)
            item["blockIds"] = [block_ids[i] for i in cell.blocks]
            rows[cell.row].append(item)
        entry: dict[str, object] = {
            "id": table_id,
            "page": table.page,
            "bbox": None if table.bbox is None else [round(v, 2) for v in table.bbox],
            "columnCount": table.column_count,
            "rows": rows,
        }
        if table.continues is not None:
            entry["continues"] = ids[table.continues]
            if table.repeated_header_rows:
                entry["repeatedHeaderRows"] = table.repeated_header_rows
        result.append(entry)
    return result
