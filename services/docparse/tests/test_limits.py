"""Limits and failure modes of contract section 4.3-4.4: every failure is a controlled error, never empty text."""

from __future__ import annotations

import io
import os
import threading
import time
import zipfile
from collections.abc import Callable
from pathlib import Path

import documents
from conftest import Service, assert_error, fixture_bytes


def _processes_named(name: str) -> list[int]:
    found = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                comm = (entry / "comm").read_text().strip()
            except (FileNotFoundError, ProcessLookupError):
                continue  # the process exited while being listed
            if comm.startswith(name):
                found.append(int(entry.name))
    return found


def test_file_over_size_limit(service_factory: Callable[..., Service]) -> None:
    service = service_factory(max_file_bytes=1000)
    assert_error(service.parse(b"x" * 1001), "too_large", 413, retryable=False)


def test_body_far_over_size_limit_is_refused_before_parsing(service_factory: Callable[..., Service]) -> None:
    service = service_factory(max_file_bytes=1000)
    assert_error(service.parse(b"x" * 200_000), "too_large", 413, retryable=False)


def test_default_size_limit_is_ten_megabytes(service: Service) -> None:
    assert_error(service.parse(b"%PDF-1.7\n" + b"0" * (10 * 1024 * 1024)), "too_large", 413, retryable=False)


def test_page_limit_parses_first_pages_only(service: Service) -> None:
    body = service.parse_ok(fixture_bytes("pages-120.pdf"))
    assert body["status"] == "partial"
    assert body["flags"]["incompleteReasons"] == ["page_limit"]
    assert body["input"]["pageCount"] == 120
    assert max(b["page"] for b in body["blocks"]) == 30
    assert "Page 30 lorem ipsum" in body["text"]
    assert "Page 31 lorem ipsum" not in body["text"]


def test_zip_bomb_by_declared_size(service: Service) -> None:
    assert_error(service.parse(documents.filler_docx(60)), "unpacked_too_large", 422, retryable=False)


def test_zip_bomb_with_lying_sizes(service: Service) -> None:
    bomb = documents.lie_about_size(documents.filler_docx(60), "word/document.xml", 4096)
    assert_error(service.parse(bomb), "corrupt", 422, retryable=False)


def test_too_many_archive_entries(service_factory: Callable[..., Service]) -> None:
    service = service_factory(max_archive_entries=100)
    assert_error(service.parse(documents.many_entries_zip(150)), "unpacked_too_large", 422, retryable=False)


def test_memory_cap_turns_into_memory_exceeded(service: Service) -> None:
    # 40 MB of empty paragraphs is inside the unpacked-size limit, but the parsed tree needs far more memory.
    response = service.parse(documents.paragraphs_docx(7_000_000))
    assert_error(response, "memory_exceeded", 507, retryable=False)
    # The service keeps working after a failed parse.
    service.parse_ok(fixture_bytes("table.docx"))


def test_timeout_kills_converter(service_factory: Callable[..., Service]) -> None:
    service = service_factory(timeout_s=0.2)
    before = set(_processes_named("soffice"))
    assert_error(service.parse(fixture_bytes("hh-export.rtf")), "timeout", 504, retryable=True)
    assert set(_processes_named("soffice")) <= before


def test_ocr_switches_to_ocr_deadline(service_factory: Callable[..., Service]) -> None:
    # With an OCR budget shorter than the usual one, only a document that reached OCR can run out of time.
    service = service_factory(timeout_s=60, ocr_timeout_s=0.05)
    assert_error(service.parse(fixture_bytes("scan.pdf")), "timeout", 504, retryable=True)
    service.parse_ok(fixture_bytes("hh-export.pdf"))


def test_busy_when_all_slots_taken(service_factory: Callable[..., Service]) -> None:
    service = service_factory(max_concurrent=1)
    results: list[int] = []
    slow = threading.Thread(target=lambda: results.append(service.parse(fixture_bytes("scan.pdf")).status_code))
    slow.start()
    time.sleep(0.3)
    assert_error(service.parse(fixture_bytes("table.docx")), "busy", 503, retryable=True)
    slow.join()
    assert results == [200]


def test_encrypted_pdf(service: Service) -> None:
    assert_error(service.parse(fixture_bytes("encrypted.pdf")), "encrypted", 422, retryable=False)


def test_encrypted_office_document(service: Service) -> None:
    assert_error(service.parse(documents.encrypted_ooxml()), "encrypted", 422, retryable=False)


def test_truncated_pdf_is_corrupt(service: Service) -> None:
    assert_error(service.parse(fixture_bytes("hh-export.pdf")[:2000]), "corrupt", 422, retryable=False)


def test_pdf_without_text_is_an_error_not_empty_text(service: Service) -> None:
    assert_error(service.parse(documents.blank_pdf()), "no_text", 422, retryable=False)


def test_docx_without_text_is_an_error_not_empty_text(service: Service) -> None:
    assert_error(service.parse(documents.text_docx([""])), "no_text", 422, retryable=False)


def test_image_without_recognizable_text_is_an_error_after_ocr(service: Service) -> None:
    assert_error(service.parse(documents.blank_png()), "no_text", 422, retryable=False)


def test_whitespace_only_text_file_is_an_error(service: Service) -> None:
    assert_error(service.parse(b"  \n\t\n   \n"), "no_text", 422, retryable=False)


def test_zip_that_is_not_a_document(service: Service) -> None:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as spreadsheet:
        spreadsheet.writestr("[Content_Types].xml", "<Types/>")
        spreadsheet.writestr("xl/workbook.xml", "<workbook/>")
    assert_error(service.parse(archive.getvalue()), "unsupported_format", 415, retryable=False)


def test_binary_garbage_is_unsupported(service: Service) -> None:
    assert_error(service.parse(os.urandom(4096)), "unsupported_format", 415, retryable=False)


def test_request_without_file(service: Service) -> None:
    response = service.client.post("/v1/parse", data={"request_id": "x"})
    assert_error(response, "bad_request", 400, retryable=False)


def test_unknown_route_has_error_body(service: Service) -> None:
    assert_error(service.client.get("/v2/parse"), "bad_request", 404, retryable=False)
