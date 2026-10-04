"""Template families: how one synthetic profile is laid out as a resume file.

Families differ in what defeats a reader — file format, language, date notation, layout (one column, a sidebar, a table,
an hh.ru-like export). A family belongs to dev, to holdout or to both: holdout keeps a family never seen while tuning
(`pdf_hh`), and the English table layout is in both, so its problems are found and fixed on dev and then measured on
holdout profiles nobody looked at.
"""

from dataclasses import dataclass
from typing import Literal

DateStyle = Literal["month_word_ru", "numeric", "year", "month_word_en"]
Split = Literal["dev", "holdout"]


@dataclass(frozen=True)
class Family:
    key: str
    file_format: Literal["pdf", "docx"]
    language: Literal["ru", "en"]
    date_style: DateStyle
    splits: tuple[Split, ...]


FAMILIES: tuple[Family, ...] = (
    Family("pdf_classic", "pdf", "ru", "month_word_ru", ("dev",)),
    Family("docx_headings", "docx", "ru", "numeric", ("dev",)),
    Family("pdf_sidebar", "pdf", "ru", "year", ("dev",)),
    Family("docx_table", "docx", "en", "month_word_en", ("dev", "holdout")),
    Family("pdf_hh", "pdf", "ru", "month_word_ru", ("holdout",)),
)

FAMILY_BY_KEY: dict[str, Family] = {family.key: family for family in FAMILIES}


def families_of(split: Split) -> tuple[Family, ...]:
    return tuple(family for family in FAMILIES if split in family.splits)
