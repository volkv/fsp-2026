import itertools
import math

import pytest

from fsp_eval.matching import Preferences, Truth, Vacancy
from fsp_eval.metrics import MetricTable
from fsp_eval.selection import (
    Inputs,
    ProductNeed,
    admissible_set_of,
    bm25_order,
    evaluate,
    name_order,
    ndcg,
    precision_at,
    random_ndcg,
    recall_at,
    reciprocal_rank,
)


def test_measures_of_an_order():
    rels = {"a": 3, "b": 0, "c": 1, "d": 2}
    assert ndcg(["a", "d", "c", "b"], rels) == 1.0
    assert 0 < ndcg(["b", "c", "d", "a"], rels) < ndcg(["a", "c", "d", "b"], rels) < 1
    # A shortlist holds only the people of its categories: a shorter order gains nothing for what it lacks.
    assert ndcg(["c"], rels) < ndcg(["c", "a"], rels)
    # Out of ten positions, whatever the length of the order.
    assert precision_at(["a", "d", "c"], rels) == 0.2
    assert precision_at(["a"], rels) == 0.1
    assert recall_at(["a", "b"], rels) == 0.5
    assert reciprocal_rank(["b", "c", "d"], rels) == 1 / 3
    assert reciprocal_rank(["b", "c"], rels) == 0.0
    with pytest.raises(ValueError, match="pool"):
        ndcg(["a", "x"], rels)
    with pytest.raises(ValueError, match="repeats"):
        precision_at(["a", "a"], rels)


def test_the_random_baseline_is_the_mean_over_all_orders():
    rels = {"a": 3, "b": 0, "c": 1, "d": 2}
    orders = list(itertools.permutations(rels))
    assert math.isclose(random_ndcg(rels, k=2), sum(ndcg(o, rels, k=2) for o in orders) / len(orders))


def test_keyword_baselines():
    texts = {
        "p1": "Python, Django, PostgreSQL",
        "p2": "Python-разработчик: Postgres, Docker",
        "p3": None,
        "p4": "Pythonic",
    }
    order = name_order(["Python", "Django", "PostgreSQL"], ["Docker"], texts, seed=1, need_id="n")
    assert order[:2] == ["p1", "p2"]
    assert set(order[2:]) == {"p3", "p4"}
    assert name_order(["Python", "Django", "PostgreSQL"], ["Docker"], texts, seed=1, need_id="n") == order
    # BM25 over the need's own text: the rarer word counts more, an unread resume nothing.
    bm25 = bm25_order("Python-разработчик, Django", texts, seed=1, need_id="n")
    assert bm25[0] == "p1"
    assert bm25[-1] in {"p3", "p4"}


def preferences(**overrides) -> Preferences:
    values = {"formats": ("remote",), "region": None, "relocation": False, "salary_min": 100_000}
    return Preferences(**(values | overrides))


def truth(pid: str, skills: tuple[str, ...], role: str = "backend", inflation: str = "honest") -> Truth:
    return Truth(pid, role, "middle", "middle", skills, inflation, preferences())


def need(**overrides) -> Vacancy:
    values = {
        "id": "n1",
        "split": "dev",
        "role": "backend",
        "grade_min": "middle",
        "grade_max": "middle",
        "required": ("python", "django", "postgresql"),
        "nice": ("docker", "redis"),
        "title": "Python-разработчик",
        "algorithmic": False,
        "work_format": "remote",
        "city": None,
        "salary_min": 100_000,
        "salary_max": 300_000,
        "below_market": False,
    }
    return Vacancy(**(values | overrides))


def inputs(**overrides) -> Inputs:
    truths = {
        "p1": truth("p1", ("python", "django", "postgresql", "docker")),
        "p2": truth("p2", ("python", "django", "postgresql"), inflation="skills"),
        "p3": truth("p3", ("python", "django")),
        "p4": truth("p4", ("docker",), role="devops"),
        "p5": truth("p5", ("python", "django", "postgresql", "redis")),
    }
    names = {"python": "Python", "django": "Django", "postgresql": "PostgreSQL", "docker": "Docker", "redis": "Redis"}
    values = {
        "seed": 1,
        "needs": [need(), need(id="n2", role="devops", required=("docker", "kubernetes", "helm"), nice=())],
        "texts": {"p1": "Python Django PostgreSQL Docker", "p2": "Python Django", "p3": "Python", "p4": "Docker"},
        "truths": truths,
        "categories": {
            "p1": ("backend", "middle"),
            "p2": ("backend", "middle"),
            "p3": ("backend", "middle"),
            "p4": ("qa", "middle"),
        },
        "false_categories": {"p5": ("backend", "middle")},
        "product_needs": {
            "n1": ProductNeed("backend", ("python", "django"), ("docker",), frozenset({("backend", "middle")})),
            "n2": ProductNeed(None, ("docker",), (), frozenset()),
        },
        "product_categories": {
            "p1": [("backend", "middle", frozenset({"python", "sql"}))],
            "p2": [("backend", "middle", frozenset({"python"}))],
            "p3": [("backend", "middle", frozenset({"python"}))],
            "p4": [("qa", "middle", frozenset({"python"}))],
        },
        "rankings": {
            "full": {"n1": ["p1", "p2", "p3"], "n2": []},
            "without_fsp": {"n1": ["p3", "p2", "p1"], "n2": []},
            "false_confirmations": {"n1": ["p5", "p1", "p2", "p3"], "n2": []},
            "sorting": {"n1": ["p1", "p2", "p3"], "n2": []},
        },
        "names": names,
        "semantic_used": False,
        "with_fsp": frozenset({"p1"}),
    }
    return Inputs(**(values | overrides))


def test_the_three_checks():
    table = MetricTable()
    report = evaluate(table, inputs())
    rows = table.rows
    # (b) the need nobody in the pool fits is not rated and is counted apart.
    assert report["rated_needs"] == 1
    assert rows["shortlist.needs_without_suitable"] == {"value": 0.5, "n": 2}
    assert report["without_suitable"]["by_kind"] == {"role_without_test.empty_shortlist": 1}
    assert rows["shortlist.ndcg_at_10"]["value"] == 1.0
    assert rows["shortlist.ndcg_at_10"]["baseline"] == rows["shortlist.ndcg_at_10.keywords_same_text"]["value"]
    assert rows["shortlist.ndcg_at_10.without_fsp"]["value"] < 1.0
    assert rows["shortlist.ndcg_at_10.without_semantic"] == {"value": None, "n": 0, "baseline": 1.0}
    assert rows["shortlist.precision_at_10"]["value"] == 0.2
    assert rows["shortlist.recall_at_10"]["value"] == 1.0
    assert rows["shortlist.mrr"]["value"] == 1.0
    assert rows["shortlist.precision_at_10.ceiling"]["value"] == 0.2
    assert rows["shortlist.recall_at_10.admitted"]["value"] == 1.0
    # One need: every bootstrap sample is the same difference.
    lift = report["deltas"]["ndcg_at_10"]["keywords_same_text"]
    assert rows["shortlist.ndcg_at_10.lift_over_keywords_same_text"]["value"] == round(lift["ci95"][0], 4)
    # One inflated person of three in the product's ten.
    assert rows["shortlist.inflated_share_top10"]["value"] == round(1 / 3, 4)
    # (a) every position holds a confirmed category the need admits; the product confirmed SQL p1 lacks and Python
    # the DevOps engineer of the QA category lacks.
    assert rows["shortlist.tz.uncategorized_positions"]["value"] == 0
    assert rows["shortlist.tz.category_mismatch"]["value"] == 0
    assert rows["shortlist.tz.outside_need_categories"]["value"] == 0
    assert rows["shortlist.tz.confirmation_consistency"] == {"value": 0.6, "n": 5}
    assert report["conformance"]["confirmed_not_held"] == {"python": 1, "sql": 1}
    # (c) the sorting of the admissible set.
    assert rows["shortlist.sorting.ndcg_at_10"]["value"] == 1.0
    assert rows["shortlist.sorting.ndcg_at_10"]["n"] == 1
    # The scenario: the falsely confirmed comes first in the product's ten, not in the search by the text.
    assert rows["shortlist.false_confirmed.share_top10"]["value"] == 0.25
    assert report["slices"]["format"]["remote"]["n"] == 1


def test_conformance_counts_what_breaks_the_rules():
    broken = inputs(
        rankings={
            "full": {"n1": ["p1", "p4", "p5"], "n2": ["p1"]},
            "without_fsp": {"n1": ["p1"], "n2": []},
            "false_confirmations": {"n1": [], "n2": []},
            "sorting": {"n1": ["p1", "p2", "p3"], "n2": []},
        },
        product_categories={"p1": [("backend", "senior", frozenset())]},
        product_needs={
            "n1": ProductNeed("backend", ("python",), (), frozenset({("backend", "middle"), ("qa", "middle")})),
            "n2": ProductNeed("backend", ("docker",), (), frozenset({("backend", "middle")})),
        },
    )
    table = MetricTable()
    report = evaluate(table, broken)
    rows = table.rows
    # p5 has no honest category; p1's category is not the one its decisions give, and p2–p4 lost theirs.
    assert rows["shortlist.tz.uncategorized_positions"]["value"] == 1
    assert rows["shortlist.tz.category_mismatch"]["value"] == 4
    # p4 (QA) and p5 (none) on n1, p1 on a need of a role without a test.
    assert rows["shortlist.tz.outside_need_categories"]["value"] == round(3 / 4, 4)
    assert [n["need"] for n in report["conformance"]["needs_with_extra_categories"]] == ["n1", "n2"]


def test_the_sorting_ranks_exactly_the_admissible_set():
    assert admissible_set_of(need(), inputs().categories) == ["p1", "p2", "p3"]
    wrong = inputs(
        rankings={**inputs().rankings, "sorting": {"n1": ["p1", "p2"], "n2": []}},
    )
    with pytest.raises(ValueError, match="admissible set"):
        evaluate(MetricTable(), wrong)


def test_a_run_with_semantic_similarity_ranks_the_variant_without_it():
    with pytest.raises(ValueError, match="semantic"):
        evaluate(MetricTable(), inputs(semantic_used=True))
