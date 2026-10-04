"""Reading order for PDF pages: recursive XY-cut over word boxes.

The order of text in a PDF content stream is whatever the generator wrote, and multi-column resumes are often
written row by row across columns. Reading order is therefore rebuilt from geometry:

1. a wide vertical gap running through the whole region splits it into columns;
2. otherwise horizontal whitespace bands split it into blocks;
3. otherwise narrower vertical gaps split it (side-by-side fields such as dates next to a company name).

Thresholds are relative to the median font size of the document.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise

from docparse.document import BlockKind

COLUMN_GAP = 2.0  # vertical gap, in median font sizes, that separates columns
BAND_GAP = 0.5  # horizontal gap that separates blocks
FIELD_GAP = 1.0  # vertical gap that separates side-by-side fields inside a band
WORD_SPACE = 0.15  # horizontal distance between words, in their font size, that means a space
HEADING_RATIO = 1.2  # font size relative to the median that marks a heading
SAME_SIZE = 0.6  # font size difference, in points, that still continues the same block

BULLETS = ("•", "▪", "–", "—", "-", "·", "●", "■", "◦", "‣", "*")


@dataclass(frozen=True)
class Word:
    text: str
    x0: float
    x1: float
    top: float
    bottom: float
    size: float


@dataclass(frozen=True)
class Region:
    words: list[Word]
    column: int | None


def _gaps(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Gaps between the union of intervals, as (gap_start, gap_end)."""
    ordered = sorted(intervals)
    merged: list[list[float]] = [list(ordered[0])]
    for start, end in ordered[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(merged[i][1], merged[i + 1][0]) for i in range(len(merged) - 1)]


def _split(words: list[Word], cuts: list[tuple[float, float]], axis: str) -> list[list[Word]]:
    bounds = [(a + b) / 2 for a, b in cuts]
    groups: list[list[Word]] = [[] for _ in range(len(bounds) + 1)]
    for word in words:
        center = (word.x0 + word.x1) / 2 if axis == "x" else (word.top + word.bottom) / 2
        groups[sum(1 for b in bounds if center > b)].append(word)
    return [g for g in groups if g]


def xy_cut(words: list[Word], size: float, column: int | None = None) -> list[Region]:
    """Split words into leaf regions in reading order; columns are numbered from 1, left to right."""
    if len(words) <= 1:
        return [Region(words, column)]
    vertical = _gaps([(w.x0, w.x1) for w in words])
    horizontal = _gaps([(w.top, w.bottom) for w in words])
    columns = [g for g in vertical if g[1] - g[0] >= COLUMN_GAP * size]
    if columns:
        regions: list[Region] = []
        for n, part in enumerate(_split(words, columns, "x"), start=1):
            regions += xy_cut(part, size, column if column is not None else n)
        return regions
    bands = [g for g in horizontal if g[1] - g[0] >= BAND_GAP * size]
    if bands:
        regions = []
        for part in _split(words, bands, "y"):
            regions += xy_cut(part, size, column)
        return regions
    fields = [g for g in vertical if g[1] - g[0] >= FIELD_GAP * size]
    if fields:
        regions = []
        for part in _split(words, fields, "x"):
            regions += xy_cut(part, size, column)
        return regions
    return [Region(words, column)]


def group_lines(words: list[Word]) -> list[list[Word]]:
    """Words → lines from top to bottom: a word whose vertical center falls within the first word of a line joins it.
    Words of a line are ordered left to right."""
    lines: list[list[Word]] = []
    for word in sorted(words, key=lambda w: (w.top, w.x0)):
        center = (word.top + word.bottom) / 2
        if lines and lines[-1][0].top <= center <= lines[-1][0].bottom:
            lines[-1].append(word)
        else:
            lines.append([word])
    for line in lines:
        line.sort(key=lambda w: w.x0)
    return lines


def line_text(line: list[Word]) -> str:
    """Words of one line (left to right) → text: a space where the gap between words is wide enough."""
    text = line[0].text
    for prev, cur in pairwise(line):
        text += (" " if cur.x0 - prev.x1 > WORD_SPACE * cur.size else "") + cur.text
    return " ".join(text.split())


def region_blocks(words: list[Word], median_size: float) -> list[tuple[BlockKind, str]]:
    """Group a leaf region into lines, then into blocks: a bullet line or a font size change starts a block."""
    blocks: list[tuple[BlockKind, str, float]] = []
    for line in group_lines(words):
        text = line_text(line)
        size = max(w.size for w in line)
        bullet = text.startswith(BULLETS) and len(text) > 2 and text[1] == " "
        if blocks and not bullet and abs(blocks[-1][2] - size) < SAME_SIZE:
            kind, previous, _ = blocks[-1]
            blocks[-1] = (kind, previous + "\n" + text, size)
        else:
            kind = "list_item" if bullet else ("heading" if size >= HEADING_RATIO * median_size else "paragraph")
            blocks.append((kind, text, size))
    return [(kind, text) for kind, text, _ in blocks]
