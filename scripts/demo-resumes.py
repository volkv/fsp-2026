"""Resume files of the demo heroes: `seeds/resumes/*.pdf|docx`, generated once and kept in the repository.

Runs inside the `docparse` image (`pnpm demo:resumes`): python-docx writes the DOCX, LibreOffice from the same image
turns a DOCX into PDF, pypdf removes what changes from run to run. The output is byte-for-byte the same on every run
with the same image, so a regeneration changes the seed batch only when the content changes. People, phones and
addresses are fictional; the text of each resume agrees with the hero in `seeds/demo.json`.
"""

from __future__ import annotations

import hashlib
import io
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import docx
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from docx.table import _Cell
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject, NameObject

FIXED_TIME = datetime(2026, 9, 1, tzinfo=UTC)
ZIP_TIME = (2026, 9, 1, 0, 0, 0)
ACCENT = RGBColor(0x1F, 0x3A, 0x5F)
MUTED = RGBColor(0x55, 0x5F, 0x6B)
FONT = "DejaVu Sans"


@dataclass(frozen=True)
class Job:
    period: str
    organization: str
    title: str
    points: tuple[str, ...]


# --- Building blocks --------------------------------------------------------------------------------------------------


def new_document() -> docx.Document:
    document = docx.Document()
    section = document.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    section.left_margin = section.right_margin = Cm(1.8)
    section.top_margin = section.bottom_margin = Cm(1.6)
    normal = document.styles["Normal"]
    normal.font.name = FONT
    normal.font.size = Pt(10)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    normal.paragraph_format.space_after = Pt(3)
    for name, size in (("Title", 20), ("Heading 1", 13), ("Heading 2", 11)):
        style = document.styles[name]
        style.font.name = FONT
        style.font.size = Pt(size)
        style.font.color.rgb = ACCENT
        style.font.bold = True
        fonts = style.element.rPr.rFonts
        for attribute in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
            fonts.attrib.pop(qn(attribute), None)
        fonts.set(qn("w:eastAsia"), FONT)
        style.paragraph_format.space_before = Pt(10 if name != "Title" else 0)
        style.paragraph_format.space_after = Pt(4)
    core = document.core_properties
    core.author = core.last_modified_by = ""
    core.title = "Резюме"
    core.created = core.modified = FIXED_TIME
    core.revision = 1
    return document


def paragraph(target, text: str, *, style: str | None = None, bold: bool = False, muted: bool = False, size=None):
    p = target.add_paragraph(style=style)
    run = p.add_run(text)
    run.bold = bold
    if muted:
        run.font.color.rgb = MUTED
    if size is not None:
        run.font.size = Pt(size)
    return p


def bullets(target, points: tuple[str, ...]) -> None:
    """A bullet typed as a character: Word's list bullet is a Symbol-font glyph that a PDF keeps as a private code."""
    for point in points:
        p = paragraph(target, f"•\u00a0{point}")
        p.paragraph_format.left_indent = Cm(0.5)
        p.paragraph_format.first_line_indent = Cm(-0.5)


def clear_borders(table) -> None:
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:val"), "nil")
        borders.append(element)
    table._tbl.tblPr.append(borders)  # noqa: SLF001 — python-docx has no API for table borders


def column_widths(table, widths: tuple[Cm, ...]) -> None:
    """Widths in the table grid and in every cell: LibreOffice lays the table out by the grid."""
    table.autofit = False
    grid = table._tbl.tblGrid  # noqa: SLF001 — python-docx has no API for the grid widths
    for column, width in zip(grid.findall(qn("w:gridCol")), widths, strict=True):
        column.set(qn("w:w"), str(width.twips))
    for row in table.rows:
        for cell, width in zip(row.cells, widths, strict=True):
            cell.width = width


def first_paragraph(cell: _Cell, text: str, **kwargs) -> None:
    """The cell's own empty paragraph takes the first text, so the cell does not start with a blank line."""
    p = cell.paragraphs[0]
    if kwargs.get("style"):
        p.style = kwargs["style"]
    run = p.add_run(text)
    run.bold = kwargs.get("bold", False)


# --- Output -----------------------------------------------------------------------------------------------------------


def docx_bytes(document: docx.Document) -> bytes:
    """The package with fixed member times: python-docx stamps each member with the moment of saving."""
    raw = io.BytesIO()
    document.save(raw)
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw.getvalue())) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            member = zipfile.ZipInfo(info.filename, ZIP_TIME)
            member.compress_type = zipfile.ZIP_DEFLATED
            member.external_attr = 0o644 << 16
            zout.writestr(member, zin.read(info))
    return out.getvalue()


def pdf_bytes(document: docx.Document, name: str) -> bytes:
    """LibreOffice renders the DOCX; the dates, the XMP packet and the file id it writes are replaced by fixed ones."""
    with tempfile.TemporaryDirectory() as work:
        source = Path(work) / f"{name}.docx"
        source.write_bytes(docx_bytes(document))
        profile = Path(work) / "lo-profile"
        subprocess.run(  # noqa: S603 — fixed arguments, a converter of the same image
            [  # noqa: S607
                "soffice",
                f"-env:UserInstallation={profile.as_uri()}",
                "--headless",
                "--nologo",
                "--norestore",
                "--nolockcheck",
                "--convert-to",
                "pdf",
                "--outdir",
                work,
                str(source),
            ],
            check=True,
            capture_output=True,
            env={"HOME": work, "TMPDIR": work, "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
        )
        reader = PdfReader(Path(work) / f"{name}.pdf")
        writer = PdfWriter(clone_from=reader)
    writer._root_object.pop(NameObject("/Metadata"), None)  # noqa: SLF001 — the XMP packet repeats the dates
    writer.metadata = None
    writer.add_metadata({"/Title": "Резюме", "/Producer": "LibreOffice"})
    digest = hashlib.sha256(name.encode()).digest()[:16]
    writer._ID = ArrayObject([ByteStringObject(digest), ByteStringObject(digest)])  # noqa: SLF001 — no public setter
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


# --- Heroes -----------------------------------------------------------------------------------------------------------


def k1_rodionov() -> docx.Document:
    """Two columns down the whole page: a sidebar of contacts, skills, languages and education next to the name and
    the experience."""
    document = new_document()
    table = document.add_table(rows=1, cols=3)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    clear_borders(table)
    column_widths(table, (Cm(6.2), Cm(1.0), Cm(10.2)))
    side, _, main = table.rows[0].cells

    first_paragraph(side, "Контакты", style="Heading 1")
    for line in ("stepan.rodionov@fsp-career.example", "+7 900 000-01-17", "github.com/srodionov-dev", "Казань"):
        paragraph(side, line, size=8.5)
    paragraph(side, "Навыки", style="Heading 1")
    for line in ("Go", "PostgreSQL", "Docker", "Git", "Linux", "REST", "gRPC", "Prometheus"):
        paragraph(side, line)
    paragraph(side, "Знание языков", style="Heading 1")
    paragraph(side, "Английский — B2")
    paragraph(side, "Образование", style="Heading 1")
    paragraph(side, "Казанский федеральный университет")
    paragraph(side, "Бакалавр, прикладная информатика, 2021", muted=True)

    first_paragraph(main, "Родионов Степан Викторович", style="Title")
    paragraph(main, "Готов к гибридному и удалённому формату, полная занятость", muted=True)
    paragraph(main, "Желаемая должность", style="Heading 1")
    paragraph(main, "Backend-разработчик (Go)")
    paragraph(main, "Опыт работы", style="Heading 1")
    paragraph(main, "Февраль 2026 — июль 2026", muted=True)
    paragraph(main, "ООО «Цифровая мастерская»", bold=True)
    paragraph(main, "Стажёр backend-разработчика")
    bullets(
        main,
        (
            "Сервис уведомлений на Go и PostgreSQL: очередь задач, повторы с паузой, метрики Prometheus.",
            "Интеграционные тесты в Docker, код-ревью в команде из пяти человек.",
        ),
    )
    paragraph(main, "О себе", style="Heading 1")
    paragraph(
        main,
        "Капитан команды чемпиона России по продуктовому программированию 2025 года, в команде отвечал за backend: "
        "API на Go, схема данных в PostgreSQL, развёртывание в Docker.",
    )
    return document


K2_JOBS = (
    Job(
        "Март 2021 — настоящее время",
        "ООО «Балтийские платёжные системы»",
        "Ведущий Go-разработчик",
        (
            "Процессинг платежей на Go: PostgreSQL, Kafka, gRPC, 12 тысяч операций в секунду в пике.",
            "Перевёл монолит на микросервисы в Kubernetes, настроил CI/CD в GitLab.",
        ),
    ),
    Job(
        "Январь 2023 — декабрь 2024",
        "ООО «Невский маркетплейс»",
        "Go-разработчик (частичная занятость)",
        ("Сервис каталога товаров на Go и PostgreSQL, поиск в Elasticsearch.",),
    ),
    Job(
        "Август 2019 — февраль 2021",
        "ООО «Дельта Софт»",
        "Backend-разработчик",
        ("Внутренние сервисы на Python и Go, Redis, Docker.",),
    ),
)


def k2_orlov() -> docx.Document:
    """The experience as a table: period, place and position, what was done."""
    document = new_document()
    paragraph(document, "Орлов Дмитрий Андреевич", style="Title")
    paragraph(document, "Санкт-Петербург · dmitry.orlov@fsp-career.example · +7 900 000-03-14", muted=True)
    paragraph(document, "Желаемая должность", style="Heading 1")
    paragraph(document, "Senior Go-разработчик")
    paragraph(document, "Опыт работы — 5 лет 7 месяцев", style="Heading 1")
    table = document.add_table(rows=1, cols=3)
    table.style = document.styles["Table Grid"]
    for cell, title in zip(table.rows[0].cells, ("Период", "Место работы", "Задачи и результаты"), strict=True):
        first_paragraph(cell, title, bold=True)
    for job in K2_JOBS:
        period, place, work = table.add_row().cells
        first_paragraph(period, job.period)
        first_paragraph(place, job.organization, bold=True)
        paragraph(place, job.title)
        first_paragraph(work, job.points[0])
        for point in job.points[1:]:
            paragraph(work, point)
    column_widths(table, (Cm(3.6), Cm(4.6), Cm(9.2)))
    paragraph(document, "Навыки", style="Heading 1")
    paragraph(document, "Go, PostgreSQL, Kafka, gRPC, Kubernetes, Docker, Redis, Elasticsearch, Python, GitLab CI")
    paragraph(document, "Образование", style="Heading 1")
    paragraph(document, "Санкт-Петербургский политехнический университет, программная инженерия, 2019")
    paragraph(document, "Знание языков", style="Heading 1")
    paragraph(document, "Английский — C1")
    return document


K5_JOBS = (
    Job(
        "Сентябрь 2018 — настоящее время",
        "ООО «Логистические решения»",
        "Ведущий Python-разработчик",
        (
            "Платформа планирования доставки на Python: FastAPI, PostgreSQL, Celery, RabbitMQ.",
            "Руководил группой из шести разработчиков, проводил архитектурные ревью.",
        ),
    ),
    Job(
        "Сентябрь 2015 — август 2018",
        "ООО «Городские сервисы»",
        "Python-разработчик",
        ("Бэкенд личного кабинета на Django и PostgreSQL, интеграции по REST.",),
    ),
    Job(
        "Июль 2014 — август 2015",
        "ООО «Первый интегратор»",
        "Младший разработчик",
        ("Скрипты обработки данных на Python, отчёты в Excel.",),
    ),
)


def k5_petrov() -> docx.Document:
    """One column with headed sections, as most exported resumes are."""
    document = new_document()
    paragraph(document, "Петров Олег Игоревич", style="Title")
    paragraph(document, "Москва · oleg.petrov@fsp-career.example · +7 900 000-11-03", muted=True)
    paragraph(document, "Желаемая должность", style="Heading 1")
    paragraph(document, "Senior Python-разработчик")
    paragraph(document, "Опыт работы — 11 лет", style="Heading 1")
    for job in K5_JOBS:
        paragraph(document, job.period, muted=True).paragraph_format.space_before = Pt(8)
        paragraph(document, job.organization, bold=True)
        paragraph(document, job.title)
        bullets(document, job.points)
    paragraph(document, "Навыки", style="Heading 1")
    paragraph(document, "Python, FastAPI, Django, PostgreSQL, Celery, RabbitMQ, Docker, Linux, Redis")
    paragraph(document, "Образование", style="Heading 1")
    paragraph(document, "МГТУ им. Н. Э. Баумана, информатика и вычислительная техника, 2014")
    paragraph(document, "Знание языков", style="Heading 1")
    paragraph(document, "Английский — B2")
    return document


def main(out: Path) -> None:
    files = {
        "k1.pdf": pdf_bytes(k1_rodionov(), "k1"),
        "k2.docx": docx_bytes(k2_orlov()),
        "k5.pdf": pdf_bytes(k5_petrov(), "k5"),
    }
    for name, data in files.items():
        (out / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()[:16]}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
