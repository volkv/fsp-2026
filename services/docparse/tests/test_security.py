"""Hostile documents: no entity expansion, no outgoing requests, nothing executed."""

from __future__ import annotations

import documents
from conftest import HitRecorder, Service, assert_error, fixture_bytes


def test_docx_with_external_entities_is_rejected(service: Service, http_trap: HitRecorder) -> None:
    response = service.parse(documents.xxe_docx(http_trap.base_url))
    assert_error(response, "corrupt", 422, retryable=False)
    assert http_trap.paths == []


def test_docx_with_entity_expansion_bomb_is_rejected(service: Service) -> None:
    assert_error(service.parse(documents.entity_bomb_docx()), "corrupt", 422, retryable=False)


def test_doctype_is_found_in_utf16_parts(service: Service) -> None:
    assert_error(service.parse(documents.utf16_doctype_docx()), "corrupt", 422, retryable=False)


def test_docx_external_relationships_are_reported_not_fetched(service: Service, http_trap: HitRecorder) -> None:
    body = service.parse_ok(documents.remote_docx(http_trap.base_url))
    assert body["flags"]["externalResourcesIgnored"] is True
    assert http_trap.paths == []


def test_plain_docx_has_no_external_resources(service: Service) -> None:
    assert service.parse_ok(fixture_bytes("table.docx"))["flags"]["externalResourcesIgnored"] is False


def test_odt_linked_image_is_not_fetched(service: Service, http_trap: HitRecorder) -> None:
    body = service.parse_ok(documents.odt(linked_image_url=f"{http_trap.base_url}/photo.png"))
    assert body["flags"]["externalResourcesIgnored"] is True
    assert http_trap.paths == []


def test_rtf_linked_picture_is_not_fetched(service: Service, http_trap: HitRecorder) -> None:
    body = service.parse_ok(documents.rtf_with_linked_picture(http_trap.base_url))
    assert body["flags"]["externalResourcesIgnored"] is True
    assert http_trap.paths == []


def test_pdf_active_content_is_reported_not_run(service: Service) -> None:
    body = service.parse_ok(fixture_bytes("active-content.pdf"))
    assert body["flags"]["externalResourcesIgnored"] is True
    assert "Примеров Алексей Игоревич" in body["text"]


def test_plain_pdf_has_no_active_content(service: Service) -> None:
    assert service.parse_ok(fixture_bytes("hh-export.pdf"))["flags"]["externalResourcesIgnored"] is False
