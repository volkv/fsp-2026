import dataclasses
import itertools
import json
import math
from collections import Counter

import pytest

from fsp_eval.dataset import DATASETS_DIR, DatasetError, build, load_manifest
from fsp_eval.fsp import build_layer, load_layer
from fsp_eval.lexicon import GRADES
from fsp_eval.matching import (
    CODE_TASKS,
    QUIZZES,
    TESTABLE,
    Truth,
    Vacancy,
    build_matching,
    keyword_order,
    load_matching,
    matching_metrics,
    ndcg,
    new_matching_manifest,
    random_ndcg,
    relevance,
)
from fsp_eval.metrics import MetricTable

DATASET = build(load_manifest("synthetic-resumes-v2"))
LAYER = load_layer("fsp-achievements-v2")
RECORDS = build_layer(LAYER, DATASET)
MATCHING = load_matching("synthetic-matching-v1")
WORLD = build_matching(MATCHING, DATASET, LAYER.id, RECORDS)


def vacancy(**overrides) -> Vacancy:
    values = {
        "id": "v1",
        "split": "dev",
        "role": "backend",
        "grade_min": "middle",
        "grade_max": "senior",
        "required": ("python", "django", "postgresql", "algorithms"),
        "nice": ("docker",),
        "title": "Middle Python-разработчик",
        "description": "Требования: Python, Django, PostgreSQL, Алгоритмы и структуры данных. Будет плюсом: Docker.",
        "algorithmic": True,
    }
    return Vacancy(**(values | overrides))


def truth(role: str | None = "backend", grade: str = "middle", skills: tuple[str, ...] = ()) -> Truth:
    return Truth("p", role, grade, skills)


def test_the_committed_manifest_is_reproduced():
    committed = json.loads((DATASETS_DIR / MATCHING.id / "manifest.json").read_text(encoding="utf-8"))
    assert (
        new_matching_manifest(MATCHING.id, MATCHING.seed, DATASET, fsp_layer=LAYER.id, records=RECORDS, vacancies=40)
        == committed
    )
    with pytest.raises(DatasetError, match="new layer id"):
        build_matching(dataclasses.replace(MATCHING, labels_sha256="0" * 64), DATASET, LAYER.id, RECORDS)
    with pytest.raises(DatasetError, match="FSP layer"):
        build_matching(MATCHING, DATASET, None, {})


def test_the_rubric_grades_relevance_from_the_truth():
    held = ("python", "django", "postgresql", "algorithms")
    assert relevance(vacancy(), truth(skills=held)) == 3
    assert relevance(vacancy(), truth(grade="junior", skills=held)) == 2
    assert relevance(vacancy(), truth(skills=held[:2])) == 2
    assert relevance(vacancy(), truth(skills=held[:1])) == 0
    # Another role is at most partly relevant, whatever it holds.
    assert relevance(vacancy(), truth(role="devops", skills=held)) == 1
    assert relevance(vacancy(), truth(role=None, grade="intern", skills=held)) == 1
    assert relevance(vacancy(), truth(role="devops", skills=held), role_matters=False) == 3


def test_the_truth_follows_the_resume_the_record_and_the_rubric():
    for profile in DATASET.profiles:
        real = set(WORLD.truths[profile.id].skills)
        used = {m.key for job in profile.jobs for line in job.lines for m in line.mentions}
        assert used <= real
        assert not real & {m.key for m in profile.negated}
    listed_only = Counter()
    for profile in DATASET.profiles:
        used = {m.key for job in profile.jobs for line in job.lines for m in line.mentions}
        used |= {key for job in profile.jobs for key in job.title_skills}
        for key in {m.key for m in profile.skills} - used:
            listed_only[key in WORLD.truths[profile.id].skills] += 1
    # About 0.7 of the skills only listed are real.
    assert 0.6 < listed_only[True] / listed_only.total() < 0.8
    strong = [
        p
        for p in DATASET.profiles
        if p.id in RECORDS and dict(RECORDS[p.id].gold.levels).get("algorithmic", "L1") != "L1"
    ]
    assert strong
    assert all("algorithms" in WORLD.truths[p.id].skills for p in strong)


def test_tests_are_of_the_bank_and_mostly_of_real_skills():
    results = [(pid, test) for pid, tests in WORLD.tests.items() for test in tests]
    assert results
    real = 0
    for pid, test in results:
        assert test.skill in TESTABLE
        assert test.assessment in {*QUIZZES.values(), *(t for tasks in CODE_TASKS.values() for t in tasks.values())}
        real += test.skill in WORLD.truths[pid].skills
    assert real / len(results) > 0.9


def test_vacancies_of_both_splits():
    for split in ("dev", "holdout"):
        vacancies = WORLD.vacancies_of(split)
        assert len(vacancies) == MATCHING.vacancies[split]
        assert all(GRADES.index(v.grade_min) <= GRADES.index(v.grade_max) for v in vacancies)
        assert any(v.algorithmic for v in vacancies)
        assert all(("algorithms" in v.required) == v.algorithmic for v in vacancies)


def test_ndcg_of_an_order():
    rels = {"a": 3, "b": 0, "c": 1}
    assert ndcg(["a", "c", "b"], rels) == 1.0
    worst = ndcg(["b", "c", "a"], rels)
    assert 0 < worst < ndcg(["c", "a", "b"], rels) < 1
    with pytest.raises(ValueError, match="pool"):
        ndcg(["a", "b"], rels)


def test_the_random_baseline_is_the_mean_over_all_orders():
    rels = {"a": 3, "b": 0, "c": 1, "d": 2}
    orders = list(itertools.permutations(rels))
    mean = sum(ndcg(order, rels, k=2) for order in orders) / len(orders)
    assert math.isclose(random_ndcg(rels, k=2), mean)


def test_the_keyword_baseline_searches_the_printed_names():
    v = vacancy()
    texts = {
        "p1": "Python, Django, PostgreSQL",
        "p2": "Python-разработчик: Postgres, Docker",
        "p3": None,
        "p4": "Pythonic Djangonaut",
    }
    order = keyword_order(v, texts, seed=1)
    assert order[0] == "p1"
    assert order[1] == "p2"
    assert set(order[2:]) == {"p3", "p4"}
    assert keyword_order(v, texts, seed=1) == order


def test_metrics_compare_the_variants_on_the_same_vacancies():
    v = vacancy()
    truths = {
        "p1": truth(skills=("python", "django", "postgresql", "algorithms")),
        "p2": truth(skills=("python", "django")),
        "p3": truth(role="devops", skills=("docker",)),
    }
    good, bad = ["p1", "p2", "p3"], ["p3", "p2", "p1"]
    rankings = {
        name: {"v1": good if name != "without_fsp" else bad}
        for name in ("full", "without_fsp", "without_tests", "resume_only", "without_reranker", "without_semantic")
    }
    table = MetricTable()
    report = matching_metrics(
        table,
        seed=1,
        vacancies=[v, vacancy(id="v2", required=("swift", "uikit"))],
        truths=truths,
        pool=list(truths),
        texts={"p1": "Python", "p2": None, "p3": "Docker"},
        rankings=rankings,
        top={name: {"v1": [{"id": "p1/x", "score": 0.9, "components": {}}]} for name in rankings},
        reranker_used=True,
        semantic_used=True,
    )
    rows = table.rows
    # The vacancy nobody in the pool fits is not rated.
    assert report["rated_vacancies"] == 1
    assert rows["matching.ndcg_at_10"] == {
        "value": 1.0,
        "n": 1,
        "baseline": rows["matching.ndcg_at_10.keywords"]["value"],
    }
    assert rows["matching.ndcg_at_10.without_fsp"]["value"] < 1.0
    assert rows["matching.ndcg_at_10.without_fsp"]["baseline"] == 1.0
    assert rows["matching.ndcg_at_10.without_semantic"] == {"value": 1.0, "n": 1, "baseline": 1.0}
    # One vacancy: every bootstrap sample is the same difference.
    lift = report["deltas"]["full_minus_keywords"]
    assert rows["matching.ndcg_at_10.lift_over_keywords"] == {"value": round(lift["ci95"][0], 4), "n": 1}
    assert lift["ci95"][0] == lift["mean"] > 0
    assert report["deltas"]["full_minus_without_fsp"]["mean"] > 0
    assert report["per_vacancy"]["v1"]["top10"]["full"][0]["relevance"] == 3

    off = MetricTable()
    matching_metrics(
        off,
        seed=1,
        vacancies=[v],
        truths=truths,
        pool=list(truths),
        texts={"p1": "Python", "p2": None, "p3": "Docker"},
        rankings=rankings,
        top={},
        reranker_used=False,
        semantic_used=False,
    )
    assert off.rows["matching.ndcg_at_10.without_reranker"] == {"value": None, "n": 0, "baseline": 1.0}
    assert off.rows["matching.ndcg_at_10.without_semantic"] == {"value": None, "n": 0, "baseline": 1.0}
