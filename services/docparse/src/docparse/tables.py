"""Tables of PDF pages: ruled tables from the visible lines of a page, aligned tables from the gaps between words.

- Ruled: pdfplumber finds cells from the edges of lines and rectangles. Only visible strokes and fills count: word
  processors paint white cell backgrounds, and their edges would cut words that run over them into pieces. Cells are
  placed on a grid of their edges, larger first; a box drawn inside a cell (a check box, a frame around a value) is
  part of that cell, not a cell of its own. Characters go to the cell under their center, so text drawn tight across
  a ruling still splits.
- Aligned (no rulings): a run of at least three lines that each fall apart into three or more segments at wide gaps,
  with the segments lining up into columns. Lines around the run that fit the columns (a header wrapped onto several
  lines, a wrapped cell) join it; a line without text in the first column continues the cell text of the row above.

Characters and words that end up in no cell stay in the page text outside the tables.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Callable
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

from pdfplumber.page import Page
from pdfplumber.utils.text import extract_words

from docparse.document import Block, CellDraft, DocumentBuilder, TableDraft
from docparse.layout import FIELD_GAP, Word, group_lines, line_text

EDGE_TOLERANCE = 1.0  # points: cell edges closer than this are one grid line
WHITE = 0.95  # a gray or RGB component at least this light (or a CMYK one this dark or less) paints nothing visible
MIN_ROWS = 2  # ruled grids smaller than 2 x 2 are frames and boxes, not tables
MIN_COLUMNS = 2
MIN_FILLED_CELLS = 2

ALIGNED_MIN_COLUMNS = 3  # two segments side by side are a label and a value, or two layout columns
ALIGNED_MIN_ROWS = 3
ALIGNED_ROW_GAP = 1.5  # vertical gap between lines of one table, in median font sizes
ALIGNED_LOOSE_LINES = 2  # lines with fewer segments allowed between two full lines, and around the run
COLUMN_OVERLAP = 0.5  # share of the narrower column two tables must overlap in, column by column, to be one table

_PAGE_NUMBER = re.compile(
    r"^(?:(?:стр(?:аница)?|с|page|p)\.?\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?(?:\s*(?:из|of|/)\s*\d{1,4})?$"
)

Box = tuple[float, float, float, float]


@dataclass
class PageTable:
    """A table found on a page: grid cells with the words of each, before they become blocks."""

    bbox: Box
    row_count: int
    column_count: int
    columns: list[tuple[float, float]]
    # (row, col, row_span, col_span, lines of words) in reading order: row by row, left to right.
    cells: list[tuple[int, int, int, int, list[list[Word]]]]


def _is_white(color: Any) -> bool:
    if isinstance(color, int | float):
        color = (color,)
    if not isinstance(color, tuple | list) or not color or not all(isinstance(v, int | float) for v in color):
        # No color is the default black; a pattern or a named color space is taken as visible.
        return False
    if len(color) == 4:
        return all(v <= 1 - WHITE for v in color)
    return all(v >= WHITE for v in color)


def _is_visible(obj: dict[str, Any]) -> bool:
    if obj.get("object_type") not in ("rect", "line", "curve"):
        return True
    if obj.get("stroke") and not _is_white(obj.get("stroking_color")):
        return True
    return bool(obj.get("fill")) and not _is_white(obj.get("non_stroking_color"))


def _cluster(values: list[float]) -> list[float]:
    """Sorted distinct values, values closer than EDGE_TOLERANCE merged into the first of them."""
    result: list[float] = []
    for value in sorted(values):
        if not result or value - result[-1] > EDGE_TOLERANCE:
            result.append(value)
    return result


def _index(lines: list[float], value: float) -> int:
    """Index of the grid line at `value`."""
    return bisect_right(lines, value + EDGE_TOLERANCE) - 1


def words_of(chars: list[dict[str, Any]]) -> list[Word]:
    return [
        Word(w["text"], w["x0"], w["x1"], w["top"], w["bottom"], w["size"])
        for w in extract_words(chars, keep_blank_chars=False, use_text_flow=False, extra_attrs=["size"])
    ]


def _grid(cells: list[Box]) -> tuple[list[float], list[float], list[tuple[Box, int, int, int, int]]]:
    """Cells on the grid of their edges, larger first; a cell overlapping a placed one is dropped. Returns the grid
    lines of the kept cells and each kept cell with (row, col, row_span, col_span)."""
    xs = _cluster([v for c in cells for v in (c[0], c[2])])
    ys = _cluster([v for c in cells for v in (c[1], c[3])])
    taken: set[tuple[int, int]] = set()
    kept: list[Box] = []
    for cell in sorted(cells, key=lambda c: (-(c[2] - c[0]) * (c[3] - c[1]), c[1], c[0])):
        c0, c1 = _index(xs, cell[0]), _index(xs, cell[2])
        r0, r1 = _index(ys, cell[1]), _index(ys, cell[3])
        positions = {(r, c) for r in range(r0, r1) for c in range(c0, c1)}
        if not positions or positions & taken:
            continue
        taken |= positions
        kept.append(cell)
    # Grid lines only where kept cells have edges: a dropped box leaves no empty rows or columns behind.
    xs = _cluster([v for c in kept for v in (c[0], c[2])])
    ys = _cluster([v for c in kept for v in (c[1], c[3])])
    placed = []
    for cell in kept:
        c0, c1 = _index(xs, cell[0]), _index(xs, cell[2])
        r0, r1 = _index(ys, cell[1]), _index(ys, cell[3])
        placed.append((cell, r0, c0, r1 - r0, c1 - c0))
    placed.sort(key=lambda p: (p[1], p[2]))
    return xs, ys, placed


def ruled_tables(page: Page) -> tuple[list[PageTable], list[dict[str, Any]]]:
    """Ruled tables of a page and the characters outside their cells."""
    chars = list(page.chars)
    free = [True] * len(chars)
    found = page.filter(_is_visible).find_tables({"vertical_strategy": "lines", "horizontal_strategy": "lines"})
    accepted: list[Box] = []
    tables: list[PageTable] = []
    for candidate in sorted(found, key=lambda t: (-(t.bbox[2] - t.bbox[0]) * (t.bbox[3] - t.bbox[1]), t.bbox)):
        bbox: Box = tuple(candidate.bbox)  # type: ignore[assignment]
        if any(_inside(bbox, frame) for frame in accepted):
            continue
        xs, ys, placed = _grid([tuple(c) for c in candidate.cells])  # type: ignore[misc]
        if len(xs) - 1 < MIN_COLUMNS or len(ys) - 1 < MIN_ROWS:
            continue
        members = _cell_members(chars, free, xs, ys, placed)
        words = [words_of([chars[i] for i in m]) for m in members]
        if sum(1 for w in words if w) < MIN_FILLED_CELLS:
            continue
        for m in members:
            for i in m:
                free[i] = False
        accepted.append(bbox)
        tables.append(
            PageTable(
                bbox=bbox,
                row_count=len(ys) - 1,
                column_count=len(xs) - 1,
                columns=list(pairwise(xs)),
                cells=[
                    (r, c, row_span, col_span, group_lines(w))
                    for (_, r, c, row_span, col_span), w in zip(placed, words, strict=True)
                ],
            )
        )
    return tables, [char for i, char in enumerate(chars) if free[i]]


def _cell_members(
    chars: list[dict[str, Any]],
    free: list[bool],
    xs: list[float],
    ys: list[float],
    placed: list[tuple[Box, int, int, int, int]],
) -> list[list[int]]:
    """Indices of the free characters whose center lies in each placed cell."""
    at: dict[tuple[int, int], int] = {}
    for n, (_, r, c, row_span, col_span) in enumerate(placed):
        for rr in range(r, r + row_span):
            for cc in range(c, c + col_span):
                at[(rr, cc)] = n
    members: list[list[int]] = [[] for _ in placed]
    for i, char in enumerate(chars):
        x = (char["x0"] + char["x1"]) / 2
        y = (char["top"] + char["bottom"]) / 2
        if free[i] and xs[0] <= x <= xs[-1] and ys[0] <= y <= ys[-1]:
            n = at.get((bisect_right(ys, y) - 1, bisect_right(xs, x) - 1))
            if n is not None:
                members[n].append(i)
    return members


def _inside(box: Box, frame: Box) -> bool:
    return (
        box[0] >= frame[0] - EDGE_TOLERANCE
        and box[1] >= frame[1] - EDGE_TOLERANCE
        and box[2] <= frame[2] + EDGE_TOLERANCE
        and box[3] <= frame[3] + EDGE_TOLERANCE
    )


def _segments(line: list[Word], gap: float) -> list[list[Word]]:
    segments = [[line[0]]]
    for word in line[1:]:
        if word.x0 - segments[-1][-1].x1 >= gap:
            segments.append([word])
        else:
            segments[-1].append(word)
    return segments


def _merge(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    merged: list[tuple[float, float]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _slot(segment: list[Word], bounds: list[float]) -> int | None:
    """Column slot of a segment between the boundaries (midpoints of the gaps between columns), or None when the
    segment crosses a boundary."""
    x0, x1 = segment[0].x0, segment[-1].x1
    slot = bisect_right(bounds, x0)
    return slot if slot == bisect_right(bounds, x1) else None


def aligned_tables(words: list[Word], median: float) -> tuple[list[PageTable], list[Word]]:
    """Tables without rulings among the words of a page, and the words outside them."""
    lines = group_lines(words)
    segments = [_segments(line, FIELD_GAP * median) for line in lines]

    def close(a: int, b: int) -> bool:
        return min(w.top for w in lines[b]) - max(w.bottom for w in lines[a]) <= ALIGNED_ROW_GAP * median

    used = [False] * len(lines)
    tables: list[PageTable] = []
    start = 0
    while start < len(lines):
        if len(segments[start]) < ALIGNED_MIN_COLUMNS:
            start += 1
            continue
        full = [start]
        k = start + 1
        while k < len(lines) and close(k - 1, k) and k - full[-1] <= ALIGNED_LOOSE_LINES + 1:
            if len(segments[k]) >= ALIGNED_MIN_COLUMNS:
                full.append(k)
            k += 1
        table = _aligned(lines, segments, full, close, used) if len(full) >= ALIGNED_MIN_ROWS else None
        if table is None:
            start += 1
            continue
        tables.append(table[0])
        for i in range(table[1], table[2] + 1):
            used[i] = True
        start = table[2] + 1
    rest = [w for i, line in enumerate(lines) if not used[i] for w in line]
    return tables, rest


def _aligned(
    lines: list[list[Word]],
    segments: list[list[list[Word]]],
    full: list[int],
    close: Callable[[int, int], bool],
    used: list[bool],
) -> tuple[PageTable, int, int] | None:
    """The table around a run of full lines: (table, first line, last line), or None when they do not line up."""
    columns = _merge([(s[0].x0, s[-1].x1) for i in full for s in segments[i]])
    if len(columns) < ALIGNED_MIN_COLUMNS:
        return None
    bounds = [(a[1] + b[0]) / 2 for a, b in pairwise(columns)]
    for i in full:
        slots = [_slot(s, bounds) for s in segments[i]]
        if None in slots or len(set(slots)) != len(slots):
            return None

    def fits(i: int) -> bool:
        return all(_slot(s, bounds) is not None for s in segments[i])

    first, last = full[0], full[-1]
    # A loose line inside the run that does not fit ends the table before it.
    last = next((i - 1 for i in range(first, last + 1) if not fits(i)), last)
    if sum(1 for i in full if i <= last) < ALIGNED_MIN_ROWS:
        return None
    # Header lines above (a header may wrap), wrapped cells of the last row below.
    while first > 0 and full[0] - first <= ALIGNED_LOOSE_LINES and not used[first - 1]:
        if not (close(first - 1, first) and fits(first - 1)):
            break
        first -= 1
    while last + 1 < len(lines) and last - full[-1] < ALIGNED_LOOSE_LINES:
        if not (close(last, last + 1) and fits(last + 1)):
            break
        last += 1
    rows = _aligned_rows([segments[i] for i in range(first, last + 1)], bounds, len(columns))
    table_words = [w for i in range(first, last + 1) for w in lines[i]]
    bbox: Box = (
        min(w.x0 for w in table_words),
        min(w.top for w in table_words),
        max(w.x1 for w in table_words),
        max(w.bottom for w in table_words),
    )
    cells = [(r, c, 1, 1, cell) for r, row in enumerate(rows) for c, cell in enumerate(row)]
    table = PageTable(bbox=bbox, row_count=len(rows), column_count=len(columns), columns=columns, cells=cells)
    return table, first, last


def _aligned_rows(
    line_segments: list[list[list[Word]]], bounds: list[float], column_count: int
) -> list[list[list[list[Word]]]]:
    """Lines → rows of cells, each cell a list of lines of words. A line with nothing in the first column whose text
    falls only in cells that already have text in the row above continues those cells (a wrapped name)."""
    rows: list[list[list[list[Word]]]] = []
    for segments in line_segments:
        row: list[list[list[Word]]] = [[] for _ in range(column_count)]
        for segment in segments:
            slot = _slot(segment, bounds)
            if slot is not None:
                row[slot] = [row[slot][0] + segment] if row[slot] else [segment]
        previous = rows[-1] if rows else None
        if previous and previous[0] and not row[0] and all(previous[c] for c, cell in enumerate(row) if cell):
            for c, cell in enumerate(row):
                previous[c] += cell
        else:
            rows.append(row)
    return rows


def add_table(builder: DocumentBuilder, page_no: int, table: PageTable) -> None:
    """The table's cells as blocks in reading order, one block per cell with text."""
    draft = TableDraft(
        page=page_no,
        bbox=table.bbox,
        row_count=table.row_count,
        column_count=table.column_count,
        columns=table.columns,
    )
    for row, col, row_span, col_span, lines in table.cells:
        cell = CellDraft(row=row, col=col, row_span=row_span, col_span=col_span)
        index = builder.add("\n".join(line_text(line) for line in lines), "table_cell", page_no) if lines else None
        if index is not None:
            cell.blocks.append(index)
        draft.cells.append(cell)
    builder.add_table(draft)


def link_continuations(builder: DocumentBuilder) -> None:
    """A table that opens a page continues the table that closed the previous one when nothing but a page number
    lies between them and their columns match; leading rows that repeat the first table's rows are its header."""
    first_on: dict[int, int] = {}
    last_on: dict[int, int] = {}
    for index, table in enumerate(builder.tables):
        if table.page is None or not any(cell.blocks for cell in table.cells):
            continue
        start, end = table.block_range()
        if table.page not in first_on or start < builder.tables[first_on[table.page]].block_range()[0]:
            first_on[table.page] = index
        if table.page not in last_on or end > builder.tables[last_on[table.page]].block_range()[1]:
            last_on[table.page] = index
    for page, index in sorted(first_on.items()):
        previous = last_on.get(page - 1)
        if previous is None:
            continue
        table, before = builder.tables[index], builder.tables[previous]
        if table.column_count != before.column_count or not _same_columns(before.columns, table.columns):
            continue
        between = builder.blocks[before.block_range()[1] + 1 : table.block_range()[0]]
        if not all(_is_page_number(block) for block in between):
            continue
        table.continues = previous
        root = before
        while root.continues is not None:
            root = builder.tables[root.continues]
        table.repeated_header_rows = _repeated_rows(builder, root, table)


def _is_page_number(block: Block) -> bool:
    return _PAGE_NUMBER.match(block.text.lower()) is not None


def _same_columns(a: list[tuple[float, float]] | None, b: list[tuple[float, float]] | None) -> bool:
    if a is None or b is None or len(a) != len(b):
        return False
    for (a0, a1), (b0, b1) in zip(a, b, strict=True):
        overlap = min(a1, b1) - max(a0, b0)
        if overlap < COLUMN_OVERLAP * min(a1 - a0, b1 - b0):
            return False
    return True


def _repeated_rows(builder: DocumentBuilder, root: TableDraft, table: TableDraft) -> int:
    def row(t: TableDraft, r: int) -> list[tuple[int, int, int, str]]:
        return sorted(
            (c.col, c.row_span, c.col_span, "\n".join(builder.blocks[i].text for i in c.blocks))
            for c in t.cells
            if c.row == r
        )

    count = 0
    while count < min(root.row_count, table.row_count - 1) and row(root, count) == row(table, count):
        count += 1
    return count
