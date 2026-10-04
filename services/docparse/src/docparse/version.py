"""Extractor identity. The version combines the service version with a digest of everything that shapes the result
(parser code, locked Python dependencies, converter and OCR packages), computed when the image is built."""

from __future__ import annotations

import tomllib
from functools import cache
from pathlib import Path

EXTRACTOR_NAME = "fsp-docparse"
_APP_ROOT = Path(__file__).resolve().parents[2]


@cache
def extractor() -> dict[str, str]:
    with (_APP_ROOT / "pyproject.toml").open("rb") as f:
        service_version = tomllib.load(f)["project"]["version"]
    digest_file = _APP_ROOT / "build-digest"
    digest = digest_file.read_text(encoding="ascii").strip()
    if not digest:
        raise RuntimeError(f"{digest_file} is empty")
    return {"name": EXTRACTOR_NAME, "version": f"{service_version}+{digest}"}
