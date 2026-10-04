"""OCR with Tesseract (Russian and English models) over grayscale rasters.

PDF pages are rendered by pdftoppm to PGM: an uncompressed raster, because PNG compression alone costs
seconds per 300 dpi page. Tesseract's TSV output gives paragraphs, which become blocks.
"""

from __future__ import annotations

import math
import statistics
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from docparse.context import ParseContext
from docparse.document import DocumentBuilder
from docparse.errors import ErrorCode, ParseFailure
from docparse.tools import run_tool

LANGUAGES = "rus+eng"
LOW_CONFIDENCE = 60.0  # mean word confidence (0-100) below which OCR text is flagged as unreliable
_POINTS_PER_INCH = 72.0


class OcrSession:
    """OCR runs within one parse; announces the first run so the supervisor can extend the deadline."""

    def __init__(self, ctx: ParseContext, builder: DocumentBuilder) -> None:
        self._ctx = ctx
        self._builder = builder
        self._started = False
        self._confidences: list[float] = []

    def _start(self) -> None:
        if not self._started:
            self._started = True
            self._ctx.on_ocr_start()

    def pdf_page(self, pdf: Path, page_no: int, width_pt: float, height_pt: float) -> None:
        self._start()
        dpi = self._ctx.limits.ocr_dpi
        area_in2 = (width_pt / _POINTS_PER_INCH) * (height_pt / _POINTS_PER_INCH)
        if area_in2 * dpi * dpi > self._ctx.limits.max_raster_pixels:
            dpi = max(1, math.floor(math.sqrt(self._ctx.limits.max_raster_pixels / area_in2)))
        stem = self._ctx.workdir / f"page-{page_no}"
        run_tool(
            [
                "pdftoppm",
                "-r",
                str(dpi),
                "-gray",
                "-singlefile",
                "-f",
                str(page_no),
                "-l",
                str(page_no),
                str(pdf),
                str(stem),
            ],
            memory_mb=self._ctx.limits.ocr_memory_mb,
            env=self._ctx.tool_env(),
            cwd=self._ctx.workdir,
            failure="PDF page could not be rendered",
        )
        raster = stem.with_suffix(".pgm")
        try:
            self._recognize(raster, page_no)
        finally:
            raster.unlink(missing_ok=True)

    def image(self, path: Path) -> None:
        try:
            with Image.open(path) as img:
                width, height = img.size
        except Image.DecompressionBombError as e:
            raise ParseFailure(ErrorCode.UNPACKED_TOO_LARGE, "Image resolution exceeds limit") from e
        except (UnidentifiedImageError, OSError) as e:
            raise ParseFailure(ErrorCode.CORRUPT, "Image cannot be decoded") from e
        if width * height > self._ctx.limits.max_raster_pixels:
            raise ParseFailure(ErrorCode.UNPACKED_TOO_LARGE, "Image resolution exceeds limit")
        self._start()
        self._recognize(path, 1)

    def _recognize(self, raster: Path, page_no: int) -> None:
        tsv = run_tool(
            ["tesseract", str(raster), "stdout", "-l", LANGUAGES, "--psm", "3", "tsv"],
            memory_mb=self._ctx.limits.ocr_memory_mb,
            env=self._ctx.tool_env(),
            cwd=self._ctx.workdir,
            failure="Text recognition failed",
        ).decode("utf-8")
        paragraphs: dict[tuple[int, int], dict[int, list[str]]] = {}
        for row in tsv.splitlines()[1:]:
            cells = row.split("\t")
            # Level 5 rows are words: level, page, block, paragraph, line, word, left, top, width, height, conf, text.
            if len(cells) < 12 or cells[0] != "5" or not cells[11].strip():
                continue
            key = (int(cells[2]), int(cells[3]))
            paragraphs.setdefault(key, {}).setdefault(int(cells[4]), []).append(cells[11])
            self._confidences.append(float(cells[10]))
        for key in sorted(paragraphs):
            lines = paragraphs[key]
            self._builder.add("\n".join(" ".join(lines[n]) for n in sorted(lines)), "paragraph", page_no)
        self._builder.ocr_pages.append(page_no)

    def finish(self) -> None:
        if self._confidences and statistics.mean(self._confidences) < LOW_CONFIDENCE:
            self._builder.mark_incomplete("ocr_low_confidence")
