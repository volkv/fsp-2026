"""Offsets are Unicode code points into NFC text: characters outside the BMP count as one."""

from __future__ import annotations

import unicodedata

import documents
from conftest import Service, fixture_bytes
from docparse.document import normalize_text

PARAGRAPHS = [
    "Навыки 🚀 Python",
    "Команда 👩\u200d💻 и 𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
    "Кафе\u0301 на углу",  # combining acute accent: NFC turns "е" + U+0301 into one code point where one exists
    "Cafe\u0301 corner",
    "после эмодзи",
]


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def test_offsets_count_code_points(service: Service) -> None:
    body = service.parse_ok(documents.text_docx(PARAGRAPHS))
    text = body["text"]
    # The document must actually exercise the difference between code points and UTF-16 units.
    assert _utf16_length(text) > len(text)
    slices = [text[b["start"] : b["end"]] for b in body["blocks"]]
    assert slices == [unicodedata.normalize("NFC", p) for p in PARAGRAPHS]
    last = body["blocks"][-1]
    assert (last["start"], last["end"]) == (len(text) - len("после эмодзи"), len(text))


def test_text_is_nfc(service: Service) -> None:
    text = service.parse_ok(documents.text_docx(PARAGRAPHS))["text"]
    assert unicodedata.is_normalized("NFC", text)
    assert "Café corner" in text


def test_fixture_emoji_block_is_addressable(service: Service) -> None:
    body = service.parse_ok(fixture_bytes("table.docx"))
    blocks_after = [b for b in body["blocks"] if b["start"] > body["text"].index("🚀")]
    assert blocks_after
    for block in blocks_after:
        assert body["text"][block["start"] : block["end"]].strip()
    about = next(b for b in body["blocks"] if "🚀" in body["text"][b["start"] : b["end"]])
    assert body["text"][about["start"] : about["end"]].startswith("Люблю TypeScript 🚀")


def test_normalize_text() -> None:
    assert normalize_text("a\ud800b") == "a\ufffdb"
    assert normalize_text("x\r\ny\rz") == "x\ny\nz"
    assert normalize_text("a\x00b\x07c\u200bd") == "abc\u200bd"
    assert normalize_text("  много   \t пробелов \u00a0 ") == "много пробелов"
    assert normalize_text("\n\n  \n") == ""
    assert normalize_text("e\u0301") == "\u00e9"
