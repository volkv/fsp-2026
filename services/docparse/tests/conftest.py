from __future__ import annotations

import http.server
import json
import os
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import httpx2
import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from starlette.testclient import TestClient

from docparse.app import create_app
from docparse.limits import Limits

FIXTURES = Path(__file__).parent / "fixtures"


def _load_schema() -> dict[str, Any]:
    path = os.environ.get("DOCPARSE_SCHEMA_PATH")
    if not path:
        raise RuntimeError("DOCPARSE_SCHEMA_PATH must point to contracts/docparse/v1.schema.json")
    schema: dict[str, Any] = json.loads(Path(path).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return schema


SCHEMA = _load_schema()
_REGISTRY = Registry().with_resource("urn:docparse:v1", Resource.from_contents(SCHEMA))


def validator_for(definition: str) -> Draft202012Validator:
    return Draft202012Validator({"$ref": f"urn:docparse:v1#/$defs/{definition}"}, registry=_REGISTRY)


PARSE_RESPONSE = validator_for("ParseResponse")
ERROR_RESPONSE = validator_for("ErrorResponse")
HEALTH_RESPONSE = validator_for("HealthResponse")


def assert_parse_response(body: dict[str, Any]) -> None:
    """Schema plus the invariants a schema cannot express (contract section 4.2)."""
    PARSE_RESPONSE.validate(body)
    text: str = body["text"]
    previous_end = 0
    ids = set()
    for block in body["blocks"]:
        assert block["start"] >= previous_end, f"block {block['id']} overlaps or is out of order"
        assert block["end"] > block["start"], f"block {block['id']} is empty"
        assert block["end"] <= len(text)
        assert text[block["start"] : block["end"]].strip(), f"block {block['id']} has no text"
        assert block["id"] not in ids
        ids.add(block["id"])
        if block["page"] is None:
            assert block["id"].startswith("d-")
        else:
            assert block["id"].startswith(f"p{block['page']}-")
        previous_end = block["end"]
    page_count = body["input"]["pageCount"]
    for page in body["flags"]["ocrPages"]:
        assert page_count is not None
        assert page <= page_count
    assert_tables(body)


def assert_tables(body: dict[str, Any]) -> None:
    """Table invariants a schema cannot express: cells lie on the grid without overlapping, their text is the text of
    their blocks, a block belongs to one cell, a continuation follows the table it continues."""
    text: str = body["text"]
    blocks = {b["id"]: b for b in body["blocks"]}
    claimed: set[str] = set()
    tables: dict[str, dict[str, Any]] = {}
    for table in body["tables"]:
        assert table["id"] not in tables
        prefix = "d" if table["page"] is None else f"p{table['page']}"
        assert table["id"].startswith(f"{prefix}-t")
        assert (table["bbox"] is None) == (table["page"] is None)
        covered: set[tuple[int, int]] = set()
        for r, row in enumerate(table["rows"]):
            assert [c["col"] for c in row] == sorted(c["col"] for c in row)
            for cell in row:
                positions = {
                    (rr, cc)
                    for rr in range(r, r + cell.get("rowSpan", 1))
                    for cc in range(cell["col"], cell["col"] + cell.get("colSpan", 1))
                }
                assert all(rr < len(table["rows"]) and cc < table["columnCount"] for rr, cc in positions)
                assert not positions & covered, f"cells of {table['id']} overlap"
                covered |= positions
                texts = []
                for block_id in cell["blockIds"]:
                    block = blocks[block_id]
                    assert block["kind"] == "table_cell"
                    assert block["page"] == table["page"]
                    assert block_id not in claimed, f"block {block_id} is in two cells"
                    claimed.add(block_id)
                    texts.append(text[block["start"] : block["end"]])
                assert cell["text"] == "\n".join(texts)
        if "continues" in table:
            before = tables[table["continues"]]
            assert before["page"] == table["page"] - 1
            assert before["columnCount"] == table["columnCount"]
        assert "repeatedHeaderRows" not in table or table["repeatedHeaderRows"] < len(table["rows"])
        tables[table["id"]] = table


def assert_error(response: httpx2.Response, code: str, status: int, *, retryable: bool) -> None:
    assert response.status_code == status, response.text
    body = response.json()
    ERROR_RESPONSE.validate(body)
    assert body["error"]["code"] == code, body
    assert body["error"]["retryable"] is retryable


@dataclass
class Service:
    client: TestClient
    scratch: Path

    def parse(self, content: bytes, name: str = "resume", **fields: str) -> httpx2.Response:
        return self.client.post(
            "/v1/parse",
            files={"file": (name, content, "application/octet-stream")},
            data={"declared_name": name, "request_id": "test", **fields},
        )

    def parse_ok(self, content: bytes, name: str = "resume") -> dict[str, Any]:
        response = self.parse(content, name)
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        assert_parse_response(body)
        return body


@pytest.fixture
def service_factory(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Callable[..., Service]]:
    clients: list[TestClient] = []
    services: list[Service] = []

    def make(**overrides: Any) -> Service:
        scratch = tmp_path_factory.mktemp("scratch")
        limits = replace(Limits(), **overrides)
        client = TestClient(create_app(limits, scratch_root=scratch), raise_server_exceptions=False)
        client.__enter__()
        clients.append(client)
        service = Service(client, scratch)
        services.append(service)
        return service

    yield make
    for client in clients:
        client.__exit__(None, None, None)
    for service in services:
        # Every request removes its scratch directory, whatever the outcome.
        assert list(service.scratch.iterdir()) == []


@pytest.fixture
def service(service_factory: Callable[..., Service]) -> Service:
    return service_factory()


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


@dataclass
class HitRecorder:
    """A local HTTP server that records every request: documents under test point their links at it."""

    base_url: str
    paths: list[str] = field(default_factory=list)


@pytest.fixture
def http_trap() -> Iterator[HitRecorder]:
    recorder = HitRecorder(base_url="")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            recorder.paths.append(self.path)
            self.send_response(404)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    recorder.base_url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield recorder
    server.shutdown()
    server.server_close()
