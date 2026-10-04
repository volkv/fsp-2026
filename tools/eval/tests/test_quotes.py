import pytest

from fsp_eval.metrics import MetricTable, check_quotes, performance_metrics, quote_metrics

# Blocks joined by blank lines; the emoji is one code point and two UTF-16 units.
BLOCKS = ["🚀 Опыт работы", "Март 2021 — настоящее время", "Python, Postgres, Docker", "Английский — B2"]
SPELLINGS = {"postgresql": {"PostgreSQL", "Postgres"}, "python": {"Python"}, "docker": {"Docker"}}


def parsed_document() -> dict:
    text, blocks = "", []
    for index, body in enumerate(BLOCKS):
        if index:
            text += "\n\n"
        blocks.append({"id": f"b{index}", "start": len(text), "end": len(text) + len(body)})
        text += body
    return {"id": "p1", "ok": True, "text": text, "blocks": blocks, "claims": [], "items": 0, "rejected": {}}


def claim(kind: str, raw_text: str, block: int, quote: str, *, skill_key=None, value=None) -> dict:
    start = BLOCKS[block].index(quote)
    return {
        "kind": kind,
        "raw_text": raw_text,
        "skill_key": skill_key,
        "value": value,
        "quote": {"block_id": f"b{block}", "start": start, "end": start + len(quote), "text": quote},
    }


def document(**overrides) -> dict:
    values = parsed_document()
    values["claims"] = [
        claim("role_title", "Опыт работы", 0, "Опыт работы"),
        claim(
            "experience_period",
            "Март 2021 — настоящее время",
            1,
            "Март 2021 — настоящее время",
            value={"from": "2021-03-01", "to": None, "is_current": True},
        ),
        claim("skill_mention", "Python", 2, "Python", skill_key="python"),
        # The product read «Postgres» as PostgreSQL: a spelling of the skill stands in the quote.
        claim("skill_mention", "PostgreSQL", 2, "Postgres", skill_key="postgresql"),
        claim("language_level", "Английский", 3, "Английский — B2", value={"level": "B2"}),
    ]
    values["items"] = 6
    values["rejected"] = {"schema_violation": 1}
    return values | overrides


def rows(documents: list[dict]) -> dict:
    table = MetricTable()
    quote_metrics(table, documents, SPELLINGS)
    return table.rows


def test_quotes_standing_at_their_offsets_and_saying_the_value_are_valid():
    values = rows([document(), {"id": "p2", "ok": False}])
    assert values["resume.quote_validity"] == {"value": 1.0, "n": 5}
    assert values["resume.quote_validity.offsets"] == {"value": 1.0, "n": 5}
    assert values["resume.quote_refusal_rate"] == {"value": 0.0, "n": 6}


def test_a_quote_off_its_offsets_is_invalid():
    broken = document()
    broken["claims"][2]["quote"]["start"] += 1
    values = rows([broken])
    assert values["resume.quote_validity.offsets"]["value"] == 0.8
    assert values["resume.quote_validity"]["value"] == 0.8


def test_offsets_are_code_points():
    # The emoji before the quote is one code point: the quote addressed in UTF-16 units lands one character too far.
    located = document()
    assert located["claims"][0]["quote"]["start"] == 2
    assert check_quotes(located, SPELLINGS)[0].located
    utf16 = document()
    utf16["claims"][0]["quote"] |= {"start": 3, "end": 14}
    assert not check_quotes(utf16, SPELLINGS)[0].located


@pytest.mark.parametrize(
    ("index", "change"),
    [
        # A skill the quote does not name.
        (2, {"skill_key": "docker", "raw_text": "Docker"}),
        # A period whose year the quote does not hold.
        (1, {"value": {"from": "2020-03-01", "to": None, "is_current": True}}),
        # A period the product could not date: nothing to support.
        (1, {"value": {"from": None, "to": None, "is_current": False}}),
        # A language level the quote does not state.
        (4, {"value": {"level": "C1"}}),
        # A role title the quote does not hold.
        (0, {"raw_text": "Разработчик"}),
    ],
)
def test_a_quote_that_does_not_say_the_value_is_invalid(index, change):
    broken = document()
    broken["claims"][index] |= change
    values = rows([broken])
    assert values["resume.quote_validity"]["value"] == 0.8
    assert values["resume.quote_validity.offsets"]["value"] == 1.0


def test_quote_refusals_are_counted_among_all_items():
    refused = document(items=10, rejected={"quote_not_found": 1, "quote_not_supporting": 1, "schema_violation": 3})
    assert rows([refused])["resume.quote_refusal_rate"] == {"value": 0.2, "n": 10}


def test_time_per_document_is_a_nearest_rank_percentile():
    documents = [{"ok": True, "timing": {"extract_ms": ms}} for ms in (40, 10, 30, 20)] + [{"ok": False}]
    table = MetricTable()
    performance_metrics(table, documents)
    assert table.rows["performance.extract_ms.p50"] == {"value": 20, "n": 4}
    assert table.rows["performance.extract_ms.p95"] == {"value": 40, "n": 4}
