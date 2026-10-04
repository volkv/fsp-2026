import dataclasses

import pytest

from fsp_eval.fsp import FspGold
from fsp_eval.gold import Gold
from fsp_eval.metrics import ABLATION_METRICS, AblationCase, Category, MetricTable, ablation_metrics, fsp_levels_of

GRADES = ["intern", "junior", "middle", "senior", "lead"]


def gold(profile_id: str, role: str | None, grade: str | None) -> Gold:
    return Gold(
        profile_id=profile_id,
        skills=(),
        periods=(),
        roles=(),
        organizations=(),
        languages=(),
        education=(),
        markers=(),
        role=role,
        role_sufficient=role is not None,
        grade=grade,
        grade_sufficient=grade is not None,
        mentions=(),
    )


def cases() -> list[AblationCase]:
    """A student FSP names a role for, a middle backend with an olympiad rank, a senior analyst who took part once."""
    return [
        AblationCase(
            gold=gold("p1", None, None),
            fsp=FspGold("p1", "backend", (("product", "L2"),), role_grounded=True),
            without=Category(None, None, None),
            with_fsp=Category("backend", None, None),
            with_levels={"product": "L2"},
        ),
        AblationCase(
            gold=gold("p2", "backend", "middle"),
            fsp=FspGold("p2", "backend", (("algorithmic", "L3"),), role_grounded=False),
            without=Category("backend", "junior", "middle"),
            with_fsp=Category("backend", "junior", "middle"),
            with_levels={"algorithmic": "L3"},
        ),
        AblationCase(
            gold=gold("p3", "data_analyst", "senior"),
            fsp=FspGold("p3", "data_analyst", (("algorithmic", "L1"),), role_grounded=False),
            without=Category("data_analyst", "senior", "lead"),
            with_fsp=Category("data_analyst", "senior", "lead"),
            with_levels={"algorithmic": "L1"},
        ),
    ]


def run(ablation: list[AblationCase]) -> dict:
    table = MetricTable()
    ablation_metrics(table, ablation, grade_order=GRADES)
    return table.rows


def test_both_variants_and_the_difference():
    rows = run(cases())
    ablated = {key.rsplit(".", 1)[0].removeprefix("categorization.") for key in rows if key.endswith("_fsp")}
    assert ablated == set(ABLATION_METRICS)
    value = {key: row["value"] for key, row in rows.items()}
    # Without FSP the student is a refusal the resume grounds; with FSP the product names the role FSP grounds.
    assert value["categorization.role_established.without_fsp"] == 0.6667
    assert value["categorization.role_established.with_fsp"] == 1.0
    # The same people in both variants: the role only the record grounds counts against the variant without it.
    assert rows["categorization.role_accuracy.without_fsp"] == {"value": 0.6667, "n": 3}
    assert rows["categorization.role_accuracy.with_fsp"] == {"value": 1.0, "n": 3, "baseline": 0.6667}
    assert value["categorization.role_found.without_fsp"] == 0.6667
    assert value["categorization.role_found.with_fsp"] == 1.0
    assert value["categorization.role_wrong_rate.with_fsp"] == 0.0
    assert value["categorization.refusal_rate.without_fsp"] == 0.3333
    assert value["categorization.refusal_rate.with_fsp"] == 0.0
    # FSP does not set a grade: the same grade in both variants.
    assert value["categorization.grade_in_range.without_fsp"] == value["categorization.grade_in_range.with_fsp"] == 1
    # The level is measured on its own, not as a gain over a variant that cannot have it.
    assert rows["categorization.fsp_level_accuracy"] == {"value": 1.0, "n": 3}
    assert rows["categorization.fsp_level_coverage"] == {"value": 1.0, "n": 3}
    assert not any("fsp_level" in key and key.endswith("_fsp") for key in rows)
    # The baseline of the variant with FSP is the variant without, counted on the same people.
    for name in ABLATION_METRICS:
        without = rows[f"categorization.{name}.without_fsp"]
        assert "baseline" not in without
        assert rows[f"categorization.{name}.with_fsp"]["baseline"] == without["value"]
        assert rows[f"categorization.{name}.with_fsp"]["n"] == without["n"]


def _with(index: int, **change):
    def apply(ablation: list[AblationCase]) -> None:
        ablation[index] = dataclasses.replace(ablation[index], **change)

    return apply


# Each metric of the ablation against a broken answer with FSP data: the value moves the wrong way.
BROKEN_ANSWERS = {
    "role_established": (_with(0, with_fsp=Category(None, None, None)), -1),
    "role_found": (_with(2, with_fsp=Category("algo_engineer", None, None)), -1),
    "role_accuracy": (_with(1, with_fsp=Category("algo_engineer", None, None)), -1),
    "role_wrong_rate": (_with(1, with_fsp=Category("algo_engineer", None, None)), 1),
    "refusal_rate": (_with(0, with_fsp=Category(None, None, None)), 1),
    "grade_established": (_with(1, with_fsp=Category("backend", None, None)), -1),
    "grade_in_range": (_with(1, with_fsp=Category("backend", "senior", "lead")), -1),
}


@pytest.mark.parametrize("name", ABLATION_METRICS)
def test_each_metric_follows_a_broken_answer(name):
    key = f"categorization.{name}.with_fsp"
    right = run(cases())[key]["value"]
    broken = cases()
    corrupt, direction = BROKEN_ANSWERS[name]
    corrupt(broken)
    assert (run(broken)[key]["value"] - right) * direction > 0


def test_the_level_metrics_follow_a_broken_answer():
    broken = cases()
    _with(0, with_levels={"product": "L3"})(broken)
    assert run(broken)["categorization.fsp_level_accuracy"]["value"] < 1.0
    _with(0, with_levels={})(broken)
    assert run(broken)["categorization.fsp_level_coverage"]["value"] == 0.6667


def test_the_metrics_follow_the_labels():
    # The same answers against labels they contradict.
    ablation = cases()
    ablation[0] = dataclasses.replace(ablation[0], fsp=FspGold("p1", "frontend", (("product", "L4"),), False))
    rows = run(ablation)
    assert rows["categorization.role_found.with_fsp"]["value"] == 0.6667
    assert rows["categorization.role_wrong_rate.with_fsp"]["value"] == 0.3333
    assert rows["categorization.fsp_level_accuracy"]["value"] == 0.6667
    # Nothing grounds the student's role any more: the role accuracy counts the two others, in both variants.
    assert (
        rows["categorization.role_accuracy.with_fsp"]["n"] == rows["categorization.role_accuracy.without_fsp"]["n"] == 2
    )


def test_levels_of_an_answer():
    assert fsp_levels_of(None) == {}
    assert fsp_levels_of({"fsp_levels": [{"discipline": "product", "level": "L2"}]}) == {"product": "L2"}
