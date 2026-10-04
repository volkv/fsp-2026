"""Tables: grids of cells whose text is quotable from blocks, in PDF (ruled and aligned) and in Word documents."""

from __future__ import annotations

from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest

import documents
from conftest import Service, fixture_bytes
from docparse import tables
from documents import GridCell, grid_ops, pdf_pages, rows_grid, text_ops, white_rect_ops

XS = [60.0, 110.0, 330.0, 420.0, 520.0]
HEADER = ["Place", "Participant", "Solved", "Penalty"]


def result_rows(first: int, count: int) -> list[list[str]]:
    return [[str(n), f"Participant Number {n}", "5", str(100 + n)] for n in range(first, first + count)]


def cells(table: dict[str, Any]) -> list[list[tuple[int, int, int, str]]]:
    """Rows as (col, rowSpan, colSpan, text)."""
    return [[(c["col"], c.get("rowSpan", 1), c.get("colSpan", 1), c["text"]) for c in row] for row in table["rows"]]


def texts(table: dict[str, Any]) -> list[list[str]]:
    return [[c["text"] for c in row] for row in table["rows"]]


def flat(rows: list[list[str]]) -> list[list[str]]:
    """Cell texts with line breaks as spaces: a narrow column wraps text in PDF that a Word cell holds on one line."""
    return [[" ".join(text.split()) for text in row] for row in rows]


def test_ruled_table_with_merged_cells(service: Service) -> None:
    grid = [
        GridCell(0, 0, "Place", row_span=2),
        GridCell(0, 1, "Participant", row_span=2),
        GridCell(0, 2, "Tasks", col_span=2),
        GridCell(1, 2, "A"),
        GridCell(1, 3, "B"),
        *[GridCell(r + 2, c, text) for r, row in enumerate(result_rows(1, 3)) for c, text in enumerate(row)],
    ]
    body = service.parse_ok(pdf_pages([text_ops(60, 40, "Final results") + grid_ops(XS, 100, 20, grid)]))
    [table] = body["tables"]
    assert table["page"] == 1
    assert table["columnCount"] == 4
    assert table["bbox"] == pytest.approx([60, 100, 520, 200], abs=1)
    assert cells(table)[:2] == [
        [(0, 2, 1, "Place"), (1, 2, 1, "Participant"), (2, 1, 2, "Tasks")],
        [(2, 1, 1, "A"), (3, 1, 1, "B")],
    ]
    assert texts(table)[2:] == result_rows(1, 3)
    # The heading above the table stays a paragraph before the cells.
    first = body["blocks"][0]
    assert body["text"][first["start"] : first["end"]] == "Final results"
    assert first["kind"] == "paragraph"


def test_white_background_does_not_cut_a_cell(service: Service) -> None:
    # Word processors paint cell backgrounds white; an edge of one running through a name must not split the cell.
    rows = [HEADER, *result_rows(1, 3)]
    ops = white_rect_ops(118, 100, 330, 180) + grid_ops(XS, 100, 20, rows_grid(rows))
    body = service.parse_ok(pdf_pages([ops]))
    [table] = body["tables"]
    assert table["columnCount"] == 4
    assert texts(table) == rows


def test_overlapping_cells_keep_the_larger_one() -> None:
    # A box sharing a ruling with a cell (a frame around a value) comes as a second cell inside it: the cell stays
    # whole and the box leaves no grid lines behind.
    left = (330.0, 120.0, 420.0, 140.0)
    cell = (420.0, 120.0, 520.0, 140.0)
    boxed = (420.0, 125.0, 500.0, 135.0)
    xs, ys, placed = tables._grid([boxed, cell, left])
    assert (xs, ys) == ([330.0, 420.0, 520.0], [120.0, 140.0])
    assert [(box, r, c, rs, cs) for box, r, c, rs, cs in placed] == [(left, 0, 0, 1, 1), (cell, 0, 1, 1, 1)]


def test_table_continued_on_the_next_page_with_its_header_repeated(service: Service) -> None:
    first = grid_ops(XS, 600, 20, rows_grid([HEADER, *result_rows(1, 10)]))
    second = grid_ops(XS, 60, 20, rows_grid([HEADER, *result_rows(11, 5)]))
    body = service.parse_ok(pdf_pages([first + text_ops(290, 815, "1"), text_ops(290, 30, "- 2 -") + second]))
    one, two = body["tables"]
    assert (one["id"], two["id"]) == ("p1-t001", "p2-t001")
    assert "continues" not in one
    assert two["continues"] == "p1-t001"
    assert two["repeatedHeaderRows"] == 1
    data = texts(one)[1:] + texts(two)[two["repeatedHeaderRows"] :]
    assert data == result_rows(1, 15)


@pytest.mark.parametrize(
    "second_page",
    [
        pytest.param(text_ops(60, 40, "Juniors") + grid_ops(XS, 60, 20, rows_grid(result_rows(11, 3))), id="text"),
        pytest.param(grid_ops([60, 200, 520], 60, 20, rows_grid([["11", "Participant"]] * 3)), id="columns"),
    ],
)
def test_a_table_does_not_continue_across_text_or_other_columns(service: Service, second_page: str) -> None:
    first = grid_ops(XS, 600, 20, rows_grid([HEADER, *result_rows(1, 10)]))
    body = service.parse_ok(pdf_pages([first, second_page]))
    assert len(body["tables"]) == 2
    assert all("continues" not in t for t in body["tables"])


def test_table_aligned_without_rulings(service: Service) -> None:
    ops = text_ops(60, 40, "Final results of the qualifying round")
    ops += text_ops(60, 60, "Held online, the scores are final.")
    lines = [HEADER, *result_rows(1, 4)]
    for n, row in enumerate(lines):
        for x, value in zip(XS, row, strict=False):
            ops += text_ops(x, 100 + 14 * n, value)
    # A long name wrapped onto a second line of the participant column.
    ops += text_ops(XS[1], 100 + 14 * len(lines), "Second Line")
    ops += text_ops(60, 200, "Chief judge of the competition")
    body = service.parse_ok(pdf_pages([ops]))
    [table] = body["tables"]
    assert table["columnCount"] == 4
    expected = [HEADER, *result_rows(1, 4)]
    expected[-1][1] += "\nSecond Line"
    assert texts(table) == expected
    outside = [body["text"][b["start"] : b["end"]] for b in body["blocks"] if b["kind"] != "table_cell"]
    assert outside == [
        "Final results of the qualifying round",
        "Held online, the scores are final.",
        "Chief judge of the competition",
    ]


@pytest.mark.parametrize("fixture", ["hh-export.pdf", "two-column.pdf", "two-column-interleaved.pdf"])
def test_resume_layouts_are_not_tables(service: Service, fixture: str) -> None:
    # Dates beside companies and two layout columns line up too, but only in two columns.
    assert service.parse_ok(fixture_bytes(fixture))["tables"] == []


def test_docx_table_spans_and_nested_table(service: Service) -> None:
    body = service.parse_ok(documents.spans_docx())
    table, nested = body["tables"]
    assert (table["id"], table["page"], table["bbox"]) == ("d-t001", None, None)
    assert table["columnCount"] == 3
    assert cells(table) == [
        [(0, 1, 2, "Шапка на две колонки"), (2, 2, 1, "На две строки\nи продолжение")],
        [(0, 1, 1, "Левая"), (1, 1, 1, "Средняя")],
        [(1, 1, 1, "После пропуска"), (2, 1, 1, "")],
    ]
    assert texts(nested) == [["Вложенная 1", "Вложенная 2"]]
    # The vertically merged cell is read once; the text its continuation holds is a second block of it.
    assert body["text"].count("На две строки") == 1
    assert len(table["rows"][0][1]["blockIds"]) == 2


def test_docx_table_converted_to_pdf_reads_as_the_same_grid(service: Service, tmp_path: Path) -> None:
    source = documents.results_docx(70)
    word = service.parse_ok(source)["tables"]
    [table] = word
    assert cells(table)[:2] == [
        [(0, 2, 1, "Место"), (1, 2, 1, "Участник"), (2, 1, 2, "Задачи"), (4, 2, 1, "Решено")],
        [(2, 1, 1, "A"), (3, 1, 1, "B")],
    ]
    expected = texts(table)[2:]

    pdf = service.parse_ok(documents.docx_to_pdf(source, tmp_path))
    pages = pdf["tables"]
    assert len(pages) >= 2
    assert cells(pages[0])[:2] == cells(table)[:2]
    data = texts(pages[0])[2:]
    for previous, page in pairwise(pages):
        assert page["continues"] == previous["id"]
        assert page["repeatedHeaderRows"] == 2
        data += texts(page)[2:]
    assert flat(data) == expected


def test_borderless_table_converted_to_pdf_is_read_by_alignment(service: Service, tmp_path: Path) -> None:
    pdf = service.parse_ok(documents.docx_to_pdf(documents.results_docx(70, borders=False), tmp_path))
    pages = pdf["tables"]
    assert len(pages) >= 2
    rows = [row for page in pages for row in texts(page) if row and row[0].isdigit()]
    assert [row[0] for row in rows] == [str(n) for n in range(1, 71)]
    assert all(page["continues"] == previous["id"] for previous, page in pairwise(pages))
