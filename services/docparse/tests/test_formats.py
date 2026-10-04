"""The five resume formats and the other supported inputs produce addressable, correctly ordered text."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

import pytest

import documents
import expected
from conftest import FIXTURES, HEALTH_RESPONSE, Service, fixture_bytes


def locate(body: dict[str, Any], fact: str) -> tuple[int, dict[str, Any]]:
    """Offset of a fact (whitespace between words may be any whitespace) and the single block that contains it."""
    pattern = r"\s+".join(re.escape(word) for word in fact.split())
    match = re.search(pattern, body["text"])
    assert match, f"fact not found: {fact!r}"
    for block in body["blocks"]:
        if block["start"] <= match.start() and match.end() <= block["end"]:
            return match.start(), block
    pytest.fail(f"fact {fact!r} spans several blocks")


def assert_facts(body: dict[str, Any], groups: dict[str, list[str]]) -> None:
    """Every fact is quotable from one block, and groups do not interleave in reading order."""
    spans = {group: [locate(body, fact)[0] for fact in facts] for group, facts in groups.items()}
    for group, offsets in spans.items():
        low, high = min(offsets), max(offsets)
        for other, other_offsets in spans.items():
            if other != group:
                intruders = [o for o in other_offsets if low < o < high]
                assert not intruders, f"group {other!r} interleaves with {group!r}"


def block_index(body: dict[str, Any], fact: str) -> int:
    _, block = locate(body, fact)
    return body["blocks"].index(block)


def test_hh_export_pdf(service: Service) -> None:
    body = service.parse_ok(fixture_bytes("hh-export.pdf"), "resume.pdf")
    assert body["input"]["detectedFormat"] == "pdf"
    assert body["input"]["pageCount"] == 2
    assert body["status"] == "complete"
    assert body["flags"]["ocrUsed"] is False
    assert_facts(body, expected.HH_EXPORT_FACTS)
    for dates, company in expected.HH_EXPORT_DATE_COMPANY:
        assert abs(block_index(body, dates) - block_index(body, company)) == 1
    assert {b["page"] for b in body["blocks"]} == {1, 2}
    assert body["blocks"][0]["id"] == "p1-b001"


@pytest.mark.parametrize("fixture", ["two-column.pdf", "two-column-interleaved.pdf"])
def test_two_column_pdf_keeps_columns_apart(service: Service, fixture: str) -> None:
    body = service.parse_ok(fixture_bytes(fixture), fixture)
    sidebar = [locate(body, fact) for fact in expected.TWO_COLUMN_SIDEBAR]
    main = [locate(body, fact) for fact in expected.TWO_COLUMN_MAIN]
    assert {block["column"] for _, block in sidebar} == {1}
    assert {block["column"] for _, block in main} == {2}
    assert max(offset for offset, _ in sidebar) < min(offset for offset, _ in main)


def test_two_column_variants_read_identically(service: Service) -> None:
    straight = service.parse_ok(fixture_bytes("two-column.pdf"))
    interleaved = service.parse_ok(fixture_bytes("two-column-interleaved.pdf"))
    assert straight["text"] == interleaved["text"]
    assert straight["blocks"] == interleaved["blocks"]


def test_docx_reads_tables_headers_and_emoji(service: Service) -> None:
    body = service.parse_ok(fixture_bytes("table.docx"), "resume.docx")
    assert body["input"]["detectedFormat"] == "docx"
    assert body["input"]["pageCount"] is None
    assert_facts(body, expected.TABLE_DOCX_FACTS)
    # Contacts live in the page header part, experience in a table.
    assert locate(body, "+7 (900) 000-00-02")[0] < locate(body, "Образцова Марина Сергеевна")[0]
    assert locate(body, "ООО «Интерфейс Пример»")[1]["kind"] == "table_cell"
    [table] = body["tables"]
    assert [cell["text"] for cell in table["rows"][0]] == ["Период", "Компания", "Должность и обязанности"]
    assert table["rows"][1][1]["text"] == "ООО «Интерфейс Пример»"
    assert all(b["page"] is None and b["column"] is None for b in body["blocks"])
    assert {b["kind"] for b in body["blocks"]} >= {"heading", "list_item", "table_cell"}


def test_docx_text_box_is_read_once(service: Service) -> None:
    body = service.parse_ok(documents.text_box_docx("Основной текст", "Контакты в рамке"))
    assert body["text"].count("Контакты в рамке") == 1
    assert body["text"].index("Основной текст") < body["text"].index("Контакты в рамке")


def test_rtf_via_converter(service: Service) -> None:
    body = service.parse_ok(fixture_bytes("hh-export.rtf"), "resume.rtf")
    assert body["input"]["detectedFormat"] == "rtf"
    assert body["input"]["pageCount"] is None
    assert body["flags"]["externalResourcesIgnored"] is False
    assert_facts(body, expected.RTF_FACTS)


def test_odt_via_converter(service: Service) -> None:
    body = service.parse_ok(documents.odt(), "resume.odt")
    assert body["input"]["detectedFormat"] == "odt"
    assert locate(body, "Тестов Иван Петрович")[1]["kind"] == "heading"
    assert "Инженер по данным, Казань" in body["text"]


def test_scanned_pdf_uses_ocr(service: Service) -> None:
    body = service.parse_ok(fixture_bytes("scan.pdf"), "scan.pdf")
    assert body["input"]["detectedFormat"] == "pdf"
    assert body["flags"]["ocrUsed"] is True
    assert body["flags"]["ocrPages"] == [1]
    assert_facts(body, expected.SCAN_FACTS)
    assert body["tables"] == []


def test_png_image_uses_ocr(service: Service, tmp_path: Path) -> None:
    subprocess.run(
        ["pdftoppm", "-r", "150", "-gray", "-png", "-singlefile", str(FIXTURES / "scan.pdf"), str(tmp_path / "scan")],
        check=True,
    )
    body = service.parse_ok((tmp_path / "scan.png").read_bytes(), "scan.png")
    assert body["input"]["detectedFormat"] == "png"
    assert body["input"]["pageCount"] == 1
    assert body["flags"]["ocrPages"] == [1]
    assert "Макетов Денис Андреевич" in body["text"]


@pytest.mark.parametrize("encoding", ["utf-8", "cp1251"])
def test_plain_text(service: Service, encoding: str) -> None:
    text = "Проверкин Олег\nАналитик\n\nОпыт: ООО «Пример», 2020–2024\n"
    body = service.parse_ok(text.encode(encoding), "resume.txt")
    assert body["input"]["detectedFormat"] == "txt"
    assert [body["text"][b["start"] : b["end"]] for b in body["blocks"]] == [
        "Проверкин Олег\nАналитик",
        "Опыт: ООО «Пример», 2020–2024",
    ]


def test_result_is_deterministic(service: Service) -> None:
    first = service.parse_ok(fixture_bytes("hh-export.pdf"))
    second = service.parse_ok(fixture_bytes("hh-export.pdf"))
    first.pop("stats")
    second.pop("stats")
    assert first == second


def test_health(service: Service) -> None:
    response = service.client.get("/v1/health")
    assert response.status_code == 200
    body = response.json()
    HEALTH_RESPONSE.validate(body)
    assert set(body["formats"]) == {"pdf", "docx", "doc", "rtf", "odt", "txt", "png", "jpeg"}
    assert re.fullmatch(r"\d+\.\d+\.\d+\+[0-9a-f]{12}", body["extractor"]["version"])
