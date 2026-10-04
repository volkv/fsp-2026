"""Processing limits (contract docparse/v1, section 4.3). Defaults follow the contract; each can be overridden
by an environment variable, which the tests use to exercise the limits on small inputs."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from typing import Self


@dataclass(frozen=True)
class Limits:
    max_file_bytes: int = 10 * 1024 * 1024
    max_unpacked_bytes: int = 50 * 1024 * 1024
    max_archive_entries: int = 5000
    max_pages: int = 30
    timeout_s: float = 30.0
    ocr_timeout_s: float = 90.0
    # Address-space cap of one parse process. The container memory limit (768 MB) is the outer boundary;
    # this cap turns an oversized parse into a controlled `memory_exceeded` before the container runs out.
    worker_memory_mb: int = 640
    # Separate caps for external tools, which map far more address space than they touch.
    converter_memory_mb: int = 2048
    ocr_memory_mb: int = 1024
    max_concurrent: int = 2
    # Raster size cap for OCR (pixels per page); larger pages are rendered at a lower resolution.
    max_raster_pixels: int = 40_000_000
    ocr_dpi: int = 300

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> Self:
        env = os.environ if environ is None else environ
        defaults = cls()
        values: dict[str, int | float] = {}
        for name, default in asdict(defaults).items():
            raw = env.get(f"DOCPARSE_{name.upper()}")
            if raw is None:
                values[name] = default
                continue
            try:
                value: int | float = type(default)(raw)
            except ValueError as e:
                raise ValueError(f"DOCPARSE_{name.upper()} must be a {type(default).__name__}") from e
            if value <= 0:
                raise ValueError(f"DOCPARSE_{name.upper()} must be positive")
            values[name] = value
        return cls(**values)

    def to_json(self) -> dict[str, int | float]:
        return asdict(self)
