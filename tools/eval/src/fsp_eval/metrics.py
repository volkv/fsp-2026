"""Metrics of a run: predictions of the product against the labels, each with its baseline and the items counted.

Keys follow the format the quality panel reads (`<group>.<metric>[.<variant>]`): `resume.*` — reading a resume and
the quotes of what was read, `skills.*` — skill normalization, `categorization.fsp_level_*` — the FSP level the
evidence calculation gives by discipline, `performance.*` — time per document. The product assigns no category from a
resume (only a test does, domain 12.4), so role and grade are not read from a resume and not measured here. The
matching group (matching.py) extends the same table: the shortlist of a need, its baselines and its variants.
"""

import math
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from fsp_eval.fsp import FspGold
from fsp_eval.gold import Gold

# Language names the product may print in a claim → the code of the label.
LANGUAGE_CODES: dict[str, str] = {"английский": "en", "english": "en", "немецкий": "de", "german": "de"}


@dataclass
class Tally:
    """Counts of one field summed over documents: micro precision, recall and F1."""

    tp: int = 0
    fp: int = 0
    fn: int = 0

    def add(self, tp: int, fp: int, fn: int) -> None:
        self.tp += tp
        self.fp += fp
        self.fn += fn

    def __iadd__(self, other: "Tally") -> "Tally":
        self.add(other.tp, other.fp, other.fn)
        return self

    @property
    def precision(self) -> float | None:
        return self.tp / (self.tp + self.fp) if self.tp + self.fp else None

    @property
    def recall(self) -> float | None:
        return self.tp / (self.tp + self.fn) if self.tp + self.fn else None

    @property
    def f1(self) -> float | None:
        total = 2 * self.tp + self.fp + self.fn
        return 2 * self.tp / total if total else None


def exact_counts(gold: Iterable[str], predicted: Iterable[str]) -> tuple[int, int, int]:
    """Multiset match: each predicted value used once."""
    expected, found = Counter(gold), Counter(predicted)
    tp = sum((expected & found).values())
    return tp, sum(found.values()) - tp, sum(expected.values()) - tp


def _fold(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[«»\"'“”]", "", text.casefold().replace("ё", "е"))).strip()


def containment_counts(gold: Sequence[str], predicted: Sequence[str]) -> tuple[int, int, int]:
    """A predicted line matches a label it contains (a line may carry more: a city, a year); one to one."""
    unused = [_fold(value) for value in predicted]
    tp = 0
    for value in gold:
        target = _fold(value)
        hit = next((i for i, line in enumerate(unused) if target and target in line), None)
        if hit is not None:
            unused.pop(hit)
            tp += 1
    return tp, len(unused), len(gold) - tp


# --- What a product answer says ---------------------------------------------------------------------------------------


def _point(value: str | None, precision: str | None) -> str | None:
    if value is None:
        return None
    return value[:4] if precision == "year" else value[:7]


def predicted_fields(document: dict[str, Any]) -> dict[str, list[str]]:
    """Fields of an extracted document in the label shapes of gold.py; a failed parse gives nothing."""
    if not document["ok"]:
        return {name: [] for name in FIELD_NAMES} | {"skills": []}
    claims, entries = document["claims"], document["entries"]
    periods = []
    for entry in entries:
        period = entry["period"]
        start = _point(period["from"], period["from_precision"])
        if start is None:
            continue
        end = "present" if period["is_current"] else _point(period["to"], period["to_precision"]) or "?"
        periods.append(f"{start}/{end}")
    languages = []
    for claim in claims:
        if claim["kind"] != "language_level":
            continue
        code = LANGUAGE_CODES.get(claim["raw_text"].casefold(), "?")
        level = (claim["value"] or {}).get("level")
        languages.append(f"{code}:{str(level).upper()}")
    return {
        "skills": sorted(
            {
                claim["skill_key"]
                for claim in claims
                if claim["kind"] == "skill_mention" and claim["polarity"] == "asserted" and claim["skill_key"]
            }
        ),
        "period": periods,
        "role": [entry["role_key"] for entry in entries if entry["role_key"]],
        "organization": [entry["organization_name"] for entry in entries if entry["organization_name"]],
        "language": languages,
        "education": [claim["raw_text"] for claim in claims if claim["kind"] == "education"],
        "marker": [
            claim["value"]["marker"]
            for claim in claims
            if claim["kind"] == "responsibility_marker" and claim["value"] and "marker" in claim["value"]
        ],
    }


FIELD_NAMES = ("period", "role", "organization", "language", "education", "marker")
_CONTAINMENT_FIELDS = {"organization", "education"}


def gold_fields(gold: Gold) -> dict[str, list[str]]:
    return {
        "period": list(gold.periods),
        "role": list(gold.roles),
        "organization": list(gold.organizations),
        "language": list(gold.languages),
        "education": list(gold.education),
        "marker": list(gold.markers),
    }


# --- Metric table -----------------------------------------------------------------------------------------------------


@dataclass
class MetricTable:
    rows: dict[str, dict[str, float | int | None]] = field(default_factory=dict)

    def put(self, key: str, value: float | None, n: int, baseline: float | None = None, *, with_baseline: bool) -> None:
        row: dict[str, float | int | None] = {"value": None if value is None else round(value, 4), "n": n}
        if with_baseline:
            row["baseline"] = None if baseline is None else round(baseline, 4)
        self.rows[key] = row


def _share(hits: Sequence[bool]) -> float | None:
    return sum(hits) / len(hits) if hits else None


def _percentile(values: Sequence[float], share: float) -> float | None:
    """Nearest rank: the smallest value with at least `share` of the values at or below it."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


def resume_metrics(
    table: MetricTable,
    golds: Sequence[Gold],
    documents: Sequence[dict[str, Any]],
    baseline_skills: Sequence[set[str]],
    unfamiliar_skills: Sequence[set[str]],
) -> None:
    """Skills and fields of the documents against the labels. `unfamiliar_skills` — per document, the skills it writes
    only in spellings the taxonomy does not know: `resume.skills_recall.unfamiliar` is the share of them found."""
    skills, skills_base = Tally(), Tally()
    unfamiliar: list[bool] = []
    unfamiliar_base: list[bool] = []
    fields = {name: Tally() for name in FIELD_NAMES}
    for gold, document, base, hidden in zip(golds, documents, baseline_skills, unfamiliar_skills, strict=True):
        predicted = predicted_fields(document)
        skills.add(*exact_counts(gold.skills, predicted["skills"]))
        skills_base.add(*exact_counts(gold.skills, sorted(base)))
        unfamiliar.extend(key in predicted["skills"] for key in sorted(hidden))
        unfamiliar_base.extend(key in base for key in sorted(hidden))
        expected = gold_fields(gold)
        for name in FIELD_NAMES:
            count = containment_counts if name in _CONTAINMENT_FIELDS else exact_counts
            fields[name].add(*count(expected[name], predicted[name]))
    n = len(golds)
    table.put("resume.parse_success_rate", _share([d["ok"] for d in documents]), n, with_baseline=False)
    table.put("resume.skills_f1", skills.f1, n, skills_base.f1, with_baseline=True)
    table.put("resume.skills_precision", skills.precision, n, skills_base.precision, with_baseline=True)
    table.put("resume.skills_recall", skills.recall, n, skills_base.recall, with_baseline=True)
    table.put(
        "resume.skills_recall.unfamiliar",
        _share(unfamiliar),
        len(unfamiliar),
        _share(unfamiliar_base),
        with_baseline=True,
    )
    overall = Tally()
    for tally in fields.values():
        overall += tally
    table.put("resume.fields_f1", overall.f1, n, with_baseline=False)
    for name, tally in fields.items():
        table.put(f"resume.fields_f1.{name}", tally.f1, tally.tp + tally.fn, with_baseline=False)


@dataclass(frozen=True)
class NormalizationPair:
    surface: str
    # `None` — not a skill of the taxonomy.
    key: str | None
    variant: str  # "variant", "typo" or "unknown"
    # The spelling is a canonical name or an alias of the taxonomy.
    known: bool


def normalization_metrics(
    table: MetricTable,
    pairs: Sequence[NormalizationPair],
    predicted: Sequence[str | None],
    baseline: Sequence[str | None],
) -> None:
    """Accuracy over all pairs and by slice: `variant` — spellings of skills, `unfamiliar` — those of them the taxonomy
    does not know (neither a name nor an alias), `typo`, `unknown` — tools outside the taxonomy. `lexicon_overlap` is
    the share of the spellings of skills the taxonomy knows: how much of `variant` the taxonomy could be fitted to."""

    def accuracy(chosen: list[int]) -> tuple[float | None, float | None, int]:
        return (
            _share([predicted[i] == pairs[i].key for i in chosen]),
            _share([baseline[i] == pairs[i].key for i in chosen]),
            len(chosen),
        )

    slices = {
        None: list(range(len(pairs))),
        "variant": [i for i, pair in enumerate(pairs) if pair.variant == "variant"],
        "unfamiliar": [i for i, pair in enumerate(pairs) if pair.variant == "variant" and not pair.known],
        "typo": [i for i, pair in enumerate(pairs) if pair.variant == "typo"],
        "unknown": [i for i, pair in enumerate(pairs) if pair.variant == "unknown"],
    }
    for name, chosen in slices.items():
        value, base, n = accuracy(chosen)
        key = "skills.normalization_accuracy" if name is None else f"skills.normalization_accuracy.{name}"
        table.put(key, value, n, base, with_baseline=True)
    spellings = slices["variant"]
    table.put(
        "skills.lexicon_overlap", _share([pairs[i].known for i in spellings]), len(spellings), with_baseline=False
    )


# --- Quotes -----------------------------------------------------------------------------------------------------------

# Refusals of an extracted item because its quote does not stand in the document or does not say what the item says.
QUOTE_REFUSALS = frozenset({"block_not_found", "quote_not_found", "quote_not_supporting", "quote_is_instruction"})
_YEAR = re.compile(r"(?<!\d)(?:19|20)\d{2}(?!\d)")


@dataclass(frozen=True)
class QuoteCheck:
    kind: str
    raw_text: str
    quote: str
    # The quote stands at its offsets: the document text between them is the quote.
    located: bool
    # The quote says what the item says.
    supports: bool


def _years(value: Any) -> set[str]:
    return set(_YEAR.findall(value)) if isinstance(value, str) else set()


def quote_supports(claim: dict[str, Any], spellings: dict[str, set[str]]) -> bool:
    """The quote states the value of the claim, read by the harness's rules, not the product's:
    a skill — its own text or a spelling of the skill found in the quote; a period — every year of the parsed period
    in the quote; a language — the language and the level; anything else — its text in the quote."""
    quote = _fold(claim["quote"]["text"])
    raw = _fold(claim["raw_text"])
    value = claim["value"] or {}
    match claim["kind"]:
        case "skill_mention":
            names = {raw} | {_fold(s) for s in spellings.get(claim["skill_key"] or "", set())}
            return any(name and name in quote for name in names)
        case "experience_period":
            stated = set(_YEAR.findall(quote))
            wanted = _years(value.get("from")) | _years(value.get("to"))
            return bool(stated) and bool(wanted) and wanted <= stated
        case "language_level":
            level = value.get("level")
            return bool(raw) and raw in quote and (level is None or _fold(str(level)) in quote)
        case _:
            return bool(raw) and raw in quote


def check_quotes(document: dict[str, Any], spellings: dict[str, set[str]]) -> list[QuoteCheck]:
    """Every claim of a parsed document: its quote cut from the document text by code point offsets (a Python string is
    indexed by code points) and read against the claim."""
    blocks = {block["id"]: block for block in document["blocks"]}
    text = document["text"]
    checks = []
    for claim in document["claims"]:
        quote = claim["quote"]
        block = blocks.get(quote["block_id"])
        located = (
            block is not None
            and 0 <= quote["start"] < quote["end"] <= block["end"] - block["start"]
            and text[block["start"] + quote["start"] : block["start"] + quote["end"]] == quote["text"]
        )
        checks.append(
            QuoteCheck(
                claim["kind"], claim["raw_text"], quote["text"], located, located and quote_supports(claim, spellings)
            )
        )
    return checks


def quote_metrics(
    table: MetricTable, documents: Sequence[dict[str, Any]], spellings: dict[str, set[str]]
) -> list[list[QuoteCheck]]:
    """Quote validity over the claims of parsed documents and the share of items refused for their quote; the checks of
    each document are returned for the report."""
    checks = [check_quotes(d, spellings) if d["ok"] else [] for d in documents]
    flat = [check for document in checks for check in document]
    table.put("resume.quote_validity", _share([c.supports for c in flat]), len(flat), with_baseline=False)
    table.put("resume.quote_validity.offsets", _share([c.located for c in flat]), len(flat), with_baseline=False)
    parsed = [d for d in documents if d["ok"]]
    items = sum(d["items"] for d in parsed)
    refused = sum(n for d in parsed for reason, n in d["rejected"].items() if reason in QUOTE_REFUSALS)
    table.put("resume.quote_refusal_rate", refused / items if items else None, items, with_baseline=False)
    return checks


# --- Time -------------------------------------------------------------------------------------------------------------


def performance_metrics(table: MetricTable, documents: Sequence[dict[str, Any]]) -> None:
    """Time of the extraction step per parsed document (model or rules with the quote checks), milliseconds."""
    times = [d["timing"]["extract_ms"] for d in documents if d["ok"]]
    for name, share in (("p50", 0.5), ("p95", 0.95)):
        table.put(f"performance.extract_ms.{name}", _percentile(times, share), len(times), with_baseline=False)


# --- FSP levels -------------------------------------------------------------------------------------------------------


def fsp_levels_of(answer: dict[str, Any] | None) -> dict[str, str]:
    return {} if answer is None else {level["discipline"]: level["level"] for level in answer["fsp_levels"]}


@dataclass(frozen=True)
class FspLevelCase:
    """One person with FSP achievements: the labels of the record and the levels the evidence calculation gave."""

    fsp: FspGold
    levels: dict[str, str]


def fsp_level_metrics(table: MetricTable, cases: Sequence[FspLevelCase]) -> None:
    """The FSP level of the evidence calculation, on the people with a record: `categorization.fsp_level_accuracy` — the
    person's level in each discipline of the record (and each level given besides) equal to the product's;
    `categorization.fsp_level_coverage` — share of the people with a record who got a level at all."""
    level_pairs = [
        (dict(c.fsp.levels).get(discipline), c.levels.get(discipline))
        for c in cases
        for discipline in sorted(set(dict(c.fsp.levels)) | set(c.levels))
    ]
    table.put(
        "categorization.fsp_level_accuracy",
        _share([g is not None and g == p for g, p in level_pairs]),
        len(level_pairs),
        with_baseline=False,
    )
    table.put(
        "categorization.fsp_level_coverage",
        _share([bool(c.levels) for c in cases]),
        len(cases),
        with_baseline=False,
    )
