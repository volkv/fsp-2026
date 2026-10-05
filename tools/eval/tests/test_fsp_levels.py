from fsp_eval.fsp import FspGold
from fsp_eval.metrics import FspLevelCase, MetricTable, fsp_level_metrics, fsp_levels_of


def cases() -> list[FspLevelCase]:
    return [
        FspLevelCase(FspGold("p1", "backend", (("product", "L4"),), True), {"product": "L4"}),
        FspLevelCase(FspGold("p2", "backend", (("algorithmic", "L2"),), False), {"algorithmic": "L2"}),
        FspLevelCase(
            FspGold("p3", "qa_manual", (("product", "L1"), ("algorithmic", "L3")), False),
            {"product": "L1", "algorithmic": "L3"},
        ),
    ]


def run(levels: list[FspLevelCase]) -> dict:
    table = MetricTable()
    fsp_level_metrics(table, levels)
    return table.rows


def test_levels_equal_to_the_record_are_exact_and_cover_everyone():
    rows = run(cases())
    assert rows["categorization.fsp_level_accuracy"] == {"value": 1.0, "n": 4}
    assert rows["categorization.fsp_level_coverage"] == {"value": 1.0, "n": 3}


def test_a_wrong_or_missing_level_lowers_the_metrics():
    broken = cases()
    broken[0] = FspLevelCase(broken[0].fsp, {"product": "L3"})
    assert run(broken)["categorization.fsp_level_accuracy"]["value"] == 0.75
    broken[1] = FspLevelCase(broken[1].fsp, {})
    rows = run(broken)
    assert rows["categorization.fsp_level_coverage"]["value"] == 0.6667
    # A level given besides the record is a miss too.
    extra = cases()
    extra[0] = FspLevelCase(extra[0].fsp, {"product": "L4", "robotics": "L1"})
    assert run(extra)["categorization.fsp_level_accuracy"] == {"value": 0.8, "n": 5}


def test_levels_of_an_answer():
    assert fsp_levels_of(None) == {}
    assert fsp_levels_of({"fsp_levels": [{"discipline": "product", "level": "L2"}]}) == {"product": "L2"}
