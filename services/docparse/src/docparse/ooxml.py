"""DOCX: body in document order (paragraphs, tables cell by cell, text boxes), page headers and footers.

A table becomes a grid of the document's own layout: a cell spans the grid columns of its `w:gridSpan`, a vertical
merge (`w:vMerge`) is one cell spanning rows, and rows starting later (`w:gridBefore`) leave the first columns empty.

`python-docx` reads the parts; the archive is checked before (see `archive.py`). Relationships to external
targets other than hyperlinks (linked images, attached templates, OLE links) are never followed and are
reported as `externalResourcesIgnored`.
"""

from __future__ import annotations

import zipfile
from collections.abc import Iterator
from pathlib import Path

import docx
from docx.document import Document
from docx.opc.exceptions import OpcError
from docx.opc.part import XmlPart
from docx.section import _Footer, _Header
from docx.table import Table, _Cell
from docx.text.paragraph import Paragraph
from lxml import etree

from docparse.document import BlockKind, CellDraft, DocumentBuilder, TableDraft
from docparse.errors import ErrorCode, ParseFailure

_NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
}
# Word writes each text box twice: the DrawingML version (mc:Choice) and a VML fallback. Only the first is read.
_TEXT_BOX_PARAGRAPHS = etree.XPath(
    ".//w:txbxContent[not(ancestor::mc:Fallback)]/w:p",
    namespaces=_NS,
)
_EMBEDDED_OBJECTS = etree.XPath(".//w:object | .//w:altChunk", namespaces=_NS)
_HYPERLINK_REL = "/relationships/hyperlink"


def _paragraph_kind(paragraph: Paragraph) -> BlockKind:
    style = paragraph.style.name if paragraph.style is not None else ""
    if style and style.startswith(("Heading", "Title")):
        return "heading"
    p_pr = paragraph._p.pPr  # noqa: SLF001 - python-docx exposes list numbering only through the element
    if (style and style.startswith("List")) or (p_pr is not None and p_pr.numPr is not None):
        return "list_item"
    return "paragraph"


def _paragraph(paragraph: Paragraph, builder: DocumentBuilder) -> None:
    builder.add(paragraph.text, _paragraph_kind(paragraph), None)
    for box_element in _TEXT_BOX_PARAGRAPHS(paragraph._p):  # noqa: SLF001
        box_paragraph = Paragraph(box_element, paragraph._parent)  # noqa: SLF001
        builder.add(box_paragraph.text, _paragraph_kind(box_paragraph), None)


def _table(table: Table, builder: DocumentBuilder) -> None:
    rows = table._tbl.tr_lst  # noqa: SLF001 - spans and merges are only in the elements
    grid_columns = len(table._tbl.tblGrid.gridCol_lst)  # noqa: SLF001
    draft = TableDraft(page=None, bbox=None, row_count=len(rows), column_count=grid_columns)
    # Listed before the tables nested in its cells, which are read in place.
    builder.add_table(draft)
    # The cell covering a grid position of the previous row: a vertically merged cell continues it.
    above: dict[int, CellDraft] = {}
    for r, tr in enumerate(rows):
        here: dict[int, CellDraft] = {}
        col = tr.grid_before
        for tc in tr.tc_lst:
            span = tc.grid_span
            origin = above.get(col) if tc.vMerge == "continue" else None
            if origin is not None and origin.col == col and origin.col_span == span:
                origin.row_span = r - origin.row + 1
                cell = origin
            else:
                cell = CellDraft(row=r, col=col, col_span=span)
                draft.cells.append(cell)
            # A continuation keeps whatever text it has, as a further block of the merged cell.
            _cell(_Cell(tc, table), cell, builder)
            for c in range(col, col + span):
                here[c] = cell
            col += span
        above = here
        draft.column_count = max(draft.column_count, col + tr.grid_after)


def _cell(cell: _Cell, draft: CellDraft, builder: DocumentBuilder) -> None:
    texts: list[str] = []
    nested: list[Table] = []
    for item in cell.iter_inner_content():
        if isinstance(item, Paragraph):
            texts.append(item.text)
        else:
            nested.append(item)
    index = builder.add("\n".join(texts), "table_cell", None)
    if index is not None:
        draft.blocks.append(index)
    for table in nested:
        _table(table, builder)


def _story(container: Document | _Header | _Footer, builder: DocumentBuilder) -> None:
    for item in container.iter_inner_content():
        if isinstance(item, Paragraph):
            _paragraph(item, builder)
        else:
            _table(item, builder)


def _page_parts(document: Document, footers: bool) -> Iterator[_Header | _Footer]:
    """Distinct header (or footer) definitions across sections: default, first page and even pages."""
    seen: set[int] = set()
    for section in document.sections:
        variants = (
            (section.footer, section.first_page_footer, section.even_page_footer)
            if footers
            else (section.header, section.first_page_header, section.even_page_header)
        )
        for part in variants:
            if part.is_linked_to_previous:
                continue
            element_id = id(part._element)  # noqa: SLF001
            if element_id in seen:
                continue
            seen.add(element_id)
            yield part


def extract_docx(path: Path, builder: DocumentBuilder) -> None:
    try:
        document = docx.Document(str(path))
    except etree.XMLSyntaxError as e:
        # Under the memory cap libxml2 reports a failed allocation as a syntax error with its own code.
        if e.code == etree.ErrorTypes.ERR_NO_MEMORY:
            raise MemoryError from e
        raise ParseFailure(ErrorCode.CORRUPT, "Word document structure cannot be read") from e
    except (OpcError, KeyError, ValueError, zipfile.BadZipFile) as e:
        raise ParseFailure(ErrorCode.CORRUPT, "Word document structure cannot be read") from e
    builder.page_count = None
    for header in _page_parts(document, footers=False):
        _story(header, builder)
    _story(document, builder)
    for footer in _page_parts(document, footers=True):
        _story(footer, builder)

    parts = list(document.part.package.iter_parts())
    if any(_EMBEDDED_OBJECTS(part.element) for part in parts if isinstance(part, XmlPart)):
        builder.mark_incomplete("embedded_object_skipped")
    builder.external_resources = builder.external_resources or any(
        rel.is_external and not rel.reltype.endswith(_HYPERLINK_REL) for part in parts for rel in part.rels.values()
    )
