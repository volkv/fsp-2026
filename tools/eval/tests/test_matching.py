import dataclasses
import json
from collections import Counter

import pytest

from catalog_fixture import catalog_info
from fsp_eval.dataset import DATASETS_DIR, DatasetError, build, load_manifest
from fsp_eval.fsp import build_layer, load_layer
from fsp_eval.lexicon import GRADES
from fsp_eval.matching import (
    CATALOG_GRADES,
    NEEDS_PER_ROLE,
    TEST_GRADE,
    TEST_SPECIALIZATION,
    VOCABULARY,
    Catalog,
    Preferences,
    Truth,
    Vacancy,
    admissible_categories,
    build_matching,
    category_of,
    decide,
    decide_falsely,
    format_fits,
    load_matching,
    need_text,
    new_matching_manifest,
    relevance,
)

DATASET = build(load_manifest("synthetic-resumes-v3"))
LAYER = load_layer("fsp-achievements-v3")
RECORDS = build_layer(LAYER, DATASET)
MATCHING = load_matching("synthetic-matching-v3")
WORLD = build_matching(MATCHING, DATASET, LAYER.id, RECORDS)


CATALOG = Catalog.of(catalog_info())


def preferences(**overrides) -> Preferences:
    values = {"formats": ("remote", "hybrid"), "region": "RU-MOW", "relocation": False, "salary_min": 200_000}
    return Preferences(**(values | overrides))


def vacancy(**overrides) -> Vacancy:
    values = {
        "id": "v1",
        "split": "dev",
        "role": "backend",
        "grade_min": "middle",
        "grade_max": "senior",
        "required": ("python", "django", "postgresql"),
        "nice": ("docker", "redis"),
        "title": "Python-разработчик",
        "algorithmic": False,
        "work_format": "remote",
        "city": None,
        "salary_min": 200_000,
        "salary_max": 300_000,
        "below_market": False,
    }
    return Vacancy(**(values | overrides))


def truth(role: str | None = "backend", grade: str = "middle", skills: tuple[str, ...] = (), **overrides) -> Truth:
    values = {
        "profile_id": "p",
        "role": role,
        "grade": grade,
        "claimed_grade": grade,
        "skills": skills,
        "inflation": "honest",
        "preferences": preferences(),
    }
    return Truth(**(values | overrides))


def test_the_committed_manifest_is_reproduced():
    committed = json.loads((DATASETS_DIR / MATCHING.id / "manifest.json").read_text(encoding="utf-8"))
    assert new_matching_manifest(MATCHING.id, MATCHING.seed, DATASET, fsp_layer=LAYER.id, records=RECORDS) == committed
    with pytest.raises(DatasetError, match="new layer id"):
        build_matching(dataclasses.replace(MATCHING, labels_sha256="0" * 64), DATASET, LAYER.id, RECORDS)
    with pytest.raises(DatasetError, match="FSP layer"):
        build_matching(MATCHING, DATASET, None, {})


def test_rubric_v3_zeroes_what_the_employer_does_not_need():
    held = ("python", "django", "postgresql")
    assert relevance(vacancy(), truth(skills=(*held, "docker"))) == 3
    assert relevance(vacancy(), truth(skills=held)) == 2
    assert relevance(vacancy(), truth(skills=held[:2])) == 1
    assert relevance(vacancy(), truth(skills=held[:1])) == 0
    # Another role, a grade outside the range, a format or place the person would not take, a higher expectation:
    # whatever the skills, the employer does not need them.
    assert relevance(vacancy(), truth(role="devops", skills=held)) == 0
    assert relevance(vacancy(), truth(role=None, grade="intern", skills=held)) == 0
    assert relevance(vacancy(), truth(grade="junior", skills=held)) == 0
    assert relevance(vacancy(work_format="office", city="Казань"), truth(skills=held)) == 0
    assert relevance(vacancy(), truth(skills=held, preferences=preferences(salary_min=310_000))) == 0
    assert relevance(vacancy(grade_max="lead"), truth(grade="lead", skills=held)) == 2


def test_format_and_place():
    office = vacancy(work_format="office", city="Москва")
    assert not format_fits(office, preferences())
    assert format_fits(vacancy(work_format="hybrid", city="Москва"), preferences())
    assert not format_fits(vacancy(work_format="hybrid", city="Казань"), preferences())
    assert format_fits(vacancy(work_format="hybrid", city="Казань"), preferences(relocation=True))
    assert not format_fits(vacancy(), preferences(formats=("office",)))


def test_admissible_categories_follow_the_need_with_a_lead_as_a_senior():
    assert admissible_categories(vacancy()) == {("backend", "middle"), ("backend", "senior")}
    assert admissible_categories(vacancy(grade_min="senior", grade_max="lead")) == {("backend", "senior")}
    assert admissible_categories(vacancy(role="fullstack", grade_min="intern", grade_max="intern")) == {
        ("backend", "intern")
    }
    assert admissible_categories(vacancy(role="devops")) == frozenset()


def test_the_truth_follows_the_resume_the_record_and_the_inflation():
    listed_only = Counter()
    for profile in DATASET.profiles:
        t = WORLD.truths[profile.id]
        real = set(t.skills)
        used = {m.key for job in profile.jobs for line in job.lines for m in line.mentions}
        assert not real & {m.key for m in profile.negated}
        if t.inflation == "honest":
            assert used <= real
            assert t.grade == t.claimed_grade
            listed = {m.key for m in profile.skills} - used - {k for job in profile.jobs for k in job.title_skills}
            for key in listed:
                listed_only[key in real] += 1
        elif t.inflation == "skills_and_grade" and t.claimed_grade != "intern":
            assert GRADES.index(t.grade) == GRADES.index(t.claimed_grade) - 1
    assert 0.6 < listed_only[True] / listed_only.total() < 0.85
    shares = Counter(t.inflation for t in WORLD.truths.values() if t.role is not None)
    assert 0.6 < shares["honest"] / shares.total() < 0.8
    strong = [
        p
        for p in DATASET.profiles
        if p.id in RECORDS and dict(RECORDS[p.id].gold.levels).get("algorithmic", "L1") != "L1"
    ]
    assert strong
    assert all("algorithms" in WORLD.truths[p.id].skills for p in strong)


def test_plans_are_of_the_specialization_of_the_role_on_the_grade_the_resume_shows():
    planned = [(pid, plan) for pid, plan in WORLD.plans.items() if plan is not None]
    tested = [pid for pid, t in WORLD.truths.items() if t.role in TEST_SPECIALIZATION]
    assert 0.7 < len(planned) / len(tested) < 0.9
    for pid, plan in planned:
        t = WORLD.truths[pid]
        assert plan.specialization == TEST_SPECIALIZATION[t.role]
        assert plan.grade == TEST_GRADE[t.claimed_grade]
    assert all(WORLD.plans[pid] is None for pid, t in WORLD.truths.items() if t.role not in TEST_SPECIALIZATION)


def test_an_honest_confirmation_never_claims_what_the_person_lacks():
    blocks = {(c["specialization"], c["grade"]): c["defining"] for c in catalog_info()["categories"]}
    languages = {
        s["key"]: {x["key"]: x["skill"] for x in s["practice_languages"]} for s in catalog_info()["specializations"]
    }
    confirmed = retaken = 0
    for pid, plan in WORLD.plans.items():
        t = WORLD.truths[pid]
        decisions = decide(MATCHING.seed, t, plan, CATALOG)
        assert decisions == decide(MATCHING.seed, t, plan, CATALOG)
        for d in decisions:
            passed = all(b["score"] >= b["cut"] for b in d.blocks)
            assert d.outcome == "not_confirmed" or passed
            if d.outcome != "confirmed":
                continue
            confirmed += 1
            assert CATALOG_GRADES.index(d.grade) <= CATALOG_GRADES.index(TEST_GRADE[t.grade])
            for block in blocks[(d.specialization, d.grade)]:
                assert {k for k in block["skill_keys"] if k in VOCABULARY} <= set(t.skills)
            if d.specialization == "qa":
                # Cases a harness runs, not a program: no language to confirm.
                assert d.practice_language is None
            else:
                assert languages[d.specialization][d.practice_language] in t.skills
        if len(decisions) == 2:
            retaken += 1
            assert decisions[0].outcome == "not_confirmed"
            assert CATALOG_GRADES.index(decisions[1].grade) == CATALOG_GRADES.index(decisions[0].grade) - 1
    assert confirmed > 100
    assert retaken > 20


def test_the_scenario_confirms_only_people_without_an_honest_confirmation():
    confirmed = 0
    for pid, plan in WORLD.plans.items():
        t = WORLD.truths[pid]
        false = decide_falsely(MATCHING.seed, t, plan, CATALOG)
        if false is None:
            continue
        confirmed += 1
        assert category_of(decide(MATCHING.seed, t, plan, CATALOG)) is None
        assert category_of(false) == (plan.specialization, plan.grade)
    assert confirmed > 20


def test_needs_cover_every_role_and_grade_and_are_written_as_employers_write_them():
    for split in ("dev", "holdout"):
        needs = WORLD.vacancies_of(split)
        assert len(needs) == MATCHING.vacancies[split] == sum(NEEDS_PER_ROLE.values())
        assert Counter(n.role for n in needs) == Counter(NEEDS_PER_ROLE)
        assert {n.grade_min for n in needs} == set(GRADES)
        assert {n.grade_min for n in needs if n.role == "frontend"} == set(GRADES)
        assert {n.work_format for n in needs} == {"remote", "hybrid", "office"}
        assert any(n.below_market for n in needs)
        assert any(n.algorithmic for n in needs)
        assert all(("algorithms" in n.required) == n.algorithmic for n in needs)
        assert all((n.city is None) == (n.work_format == "remote") for n in needs)
    text = need_text(vacancy(work_format="hybrid", city="Казань"))
    assert text.startswith("Middle/Senior Python-разработчик\n")
    assert "Формат работы: гибрид, Казань." in text
    assert "Зарплата: от 200 000 до 300 000 ₽ на руки." in text
    assert need_text(vacancy(grade_max="middle")).startswith("Middle Python-разработчик\n")
    assert need_text(vacancy(grade_min="intern", grade_max="intern")).startswith("Стажёр Python-разработчик\n")
