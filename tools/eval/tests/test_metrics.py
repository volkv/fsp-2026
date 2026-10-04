import pytest

from fsp_eval.baselines import NameDictionary, majority, majority_role_and_grade
from fsp_eval.dataset import build, load_manifest
from fsp_eval.gold import Gold, unfamiliar_skills
from fsp_eval.lexicon import fold_spelling
from fsp_eval.metrics import (
    Category,
    MetricTable,
    NormalizationPair,
    Tally,
    categorization_metrics,
    containment_counts,
    exact_counts,
    normalization_metrics,
    predicted_fields,
    primary_category,
    resume_metrics,
)

GRADES = ["intern", "junior", "middle", "senior", "lead", "principal"]


def gold(**overrides) -> Gold:
    values = {
        "profile_id": "p1",
        "skills": ("docker", "python"),
        "periods": ("2021-03/present",),
        "roles": ("backend",),
        "organizations": ("ООО «Северный Код»",),
        "languages": ("en:B2",),
        "education": ("Северо-Восточный институт информатики",),
        "markers": ("mentoring",),
        "role": "backend",
        "role_sufficient": True,
        "grade": "middle",
        "grade_sufficient": True,
        "mentions": (("Python", "python", False),),
    }
    return Gold(**(values | overrides))


def document(**overrides) -> dict:
    """An extracted document in the bridge's answer shape that says exactly what `gold()` labels."""
    values = {
        "id": "p1",
        "ok": True,
        "text": "Python Docker",
        "mode": "rules_only",
        "claims": [
            {
                "kind": "skill_mention",
                "raw_text": "Python",
                "polarity": "asserted",
                "skill_key": "python",
                "value": None,
            },
            {
                "kind": "skill_mention",
                "raw_text": "Docker",
                "polarity": "asserted",
                "skill_key": "docker",
                "value": None,
            },
            {"kind": "skill_mention", "raw_text": "Rust", "polarity": "uncertain", "skill_key": "rust", "value": None},
            {
                "kind": "language_level",
                "raw_text": "Английский",
                "polarity": "asserted",
                "skill_key": None,
                "value": {"level": "B2"},
            },
            {
                "kind": "education",
                "raw_text": "Северо-Восточный институт информатики",
                "polarity": "asserted",
                "skill_key": None,
                "value": None,
            },
            {
                "kind": "responsibility_marker",
                "raw_text": "менторил",
                "polarity": "asserted",
                "skill_key": None,
                "value": {"marker": "mentoring"},
            },
        ],
        "entries": [
            {
                "role_key": "backend",
                "organization_name": "ООО «Северный Код», Москва",
                "period": {
                    "from": "2021-03-01",
                    "from_precision": "month",
                    "to": None,
                    "to_precision": None,
                    "is_current": True,
                    "status": "valid",
                },
            }
        ],
    }
    return values | overrides


def test_tally_is_micro_precision_recall_f1():
    tally = Tally()
    tally.add(*exact_counts(["a", "b", "b"], ["b", "c"]))
    assert (tally.tp, tally.fp, tally.fn) == (1, 1, 2)
    assert tally.precision == 0.5
    assert tally.recall == pytest.approx(1 / 3)
    assert tally.f1 == pytest.approx(0.4)
    assert Tally().f1 is None


def test_containment_matches_one_line_per_label():
    assert containment_counts(["ООО «Север»"], ['ООО "Север", Москва', "ООО Север"]) == (1, 1, 0)
    assert containment_counts(["Север", "Север"], ["ООО Север"]) == (1, 0, 1)


def test_fields_of_an_answer_in_label_shapes():
    fields = predicted_fields(document())
    assert fields == {
        "skills": ["docker", "python"],
        "period": ["2021-03/present"],
        "role": ["backend"],
        "organization": ["ООО «Северный Код», Москва"],
        "language": ["en:B2"],
        "education": ["Северо-Восточный институт информатики"],
        "marker": ["mentoring"],
    }
    year = document(
        entries=[
            {
                "role_key": None,
                "organization_name": None,
                "period": {
                    "from": "2019-01-01",
                    "from_precision": "year",
                    "to": "2021-12-01",
                    "to_precision": "year",
                    "is_current": False,
                    "status": "valid",
                },
            }
        ]
    )
    assert predicted_fields(year)["period"] == ["2019/2021"]
    assert predicted_fields({"id": "p1", "ok": False})["skills"] == []


def run_resume(golds, documents, baseline=None, unfamiliar=None):
    table = MetricTable()
    resume_metrics(table, golds, documents, baseline or [set() for _ in golds], unfamiliar or [set() for _ in golds])
    return table.rows


def test_perfect_reading_scores_one_and_a_wrong_label_lowers_it():
    rows = run_resume([gold()], [document()])
    assert rows["resume.skills_f1"] == {"value": 1.0, "n": 1, "baseline": 0.0}
    assert rows["resume.fields_f1"]["value"] == 1.0
    for name in ("period", "role", "organization", "language", "education", "marker"):
        assert rows[f"resume.fields_f1.{name}"]["value"] == 1.0

    # The same answer against a label it contradicts: the metric follows the labels, not the answer.
    broken = run_resume([gold(skills=("docker", "java"), roles=("frontend",))], [document()])
    assert broken["resume.skills_f1"]["value"] == 0.5
    assert broken["resume.fields_f1.role"]["value"] == 0.0
    assert broken["resume.fields_f1"]["value"] < 1.0

    # And a broken answer against the right label.
    wrong = document(entries=[], claims=[])
    assert run_resume([gold()], [wrong])["resume.fields_f1"]["value"] == 0.0


def test_a_failed_parse_counts_as_reading_nothing():
    rows = run_resume([gold(), gold()], [document(), {"id": "p2", "ok": False}])
    assert rows["resume.parse_success_rate"]["value"] == 0.5
    assert rows["resume.skills_recall"]["value"] == 0.5


def test_the_skills_baseline_is_computed_on_the_same_documents():
    dictionary = NameDictionary({"python": "python", "spring boot": "spring_boot", "spring framework": "spring"})
    assert dictionary.skills_in("Python, Spring Boot и Pythonic") == {"python", "spring_boot"}
    assert dictionary.normalize(" PYTHON ") == "python"
    assert dictionary.normalize("Postgres") is None
    rows = run_resume([gold()], [document()], [dictionary.skills_in("Python")])
    assert rows["resume.skills_recall"]["baseline"] == 0.5


def test_normalization_accuracy_by_variant():
    pairs = [
        NormalizationPair("Postgres", "postgresql", "variant", known=True),
        NormalizationPair("Кубер", "kubernetes", "variant", known=False),
        NormalizationPair("Kuberentes", "kubernetes", "typo", known=False),
        NormalizationPair("Trello", None, "unknown", known=False),
    ]
    table = MetricTable()
    normalization_metrics(table, pairs, ["postgresql", None, None, "jira"], ["postgresql", None, None, None])
    assert table.rows["skills.normalization_accuracy"] == {"value": 0.25, "n": 4, "baseline": 0.5}
    assert table.rows["skills.normalization_accuracy.variant"] == {"value": 0.5, "n": 2, "baseline": 0.5}
    # The spelling the taxonomy does not know is a slice of its own: here the product misses it.
    assert table.rows["skills.normalization_accuracy.unfamiliar"] == {"value": 0.0, "n": 1, "baseline": 0.0}
    assert table.rows["skills.normalization_accuracy.typo"]["value"] == 0.0
    assert table.rows["skills.normalization_accuracy.unknown"] == {"value": 0.0, "n": 1, "baseline": 1.0}
    assert table.rows["skills.lexicon_overlap"] == {"value": 0.5, "n": 2}


def test_recall_of_skills_written_only_in_unfamiliar_spellings():
    # The document asserts python and docker; docker is written only as «Докер», which the taxonomy does not know.
    rows = run_resume([gold()], [document()], [{"python"}], [{"docker"}])
    assert rows["resume.skills_recall.unfamiliar"] == {"value": 1.0, "n": 1, "baseline": 0.0}
    missed = document(claims=[c for c in document()["claims"] if c.get("skill_key") != "docker"])
    assert run_resume([gold()], [missed], None, [{"docker"}])["resume.skills_recall.unfamiliar"]["value"] == 0.0


def test_a_skill_is_unfamiliar_only_when_every_mention_of_it_is():
    profile = next(p for p in build(load_manifest("synthetic-resumes-v2")).profiles if p.kind == "full")
    mentions = [*profile.skills, *(m for job in profile.jobs for line in job.lines for m in line.mentions)]
    titled = {key for job in profile.jobs for key in job.title_skills}
    key = next(m.key for m in mentions if m.key not in titled and not any(o.typo for o in mentions if o.key == m.key))
    everything = {fold_spelling(m.surface) for m in mentions}
    assert unfamiliar_skills(profile, everything) == set()
    theirs = {fold_spelling(m.surface) for m in mentions if m.key == key}
    assert unfamiliar_skills(profile, everything - theirs) == {key}
    # A skill a title names is never in the slice: the title writes it in its own way.
    assert not unfamiliar_skills(profile, set()) & titled


def answer(role=None, grade=None):
    assignments = []
    if role or grade:
        assignments.append(
            {
                "rank": "primary",
                "role_status": "established" if role else "insufficient_data",
                "role_key": role,
                "grade_status": "established" if grade else "insufficient_data",
                "grade_min": grade[0] if grade else None,
                "grade_max": grade[1] if grade else None,
            }
        )
    return {"assignments": assignments}


def test_primary_category_of_an_answer():
    assert primary_category(answer("backend", ("junior", "middle"))) == Category("backend", "junior", "middle")
    assert primary_category(answer(None, ("junior", "junior"))) == Category(None, "junior", "junior")
    assert primary_category(answer("backend")) == Category("backend", None, None)
    assert primary_category(answer()) == Category(None, None, None)
    assert primary_category(None) == Category(None, None, None)


def run_categorization(golds, categories):
    table = MetricTable()
    categorization_metrics(
        table, golds, categories, grade_order=GRADES, majority_role="backend", majority_grade="middle"
    )
    return {key: row["value"] for key, row in table.rows.items()}, table.rows


def test_categorization_against_role_grade_and_sufficiency():
    golds = [
        gold(),
        gold(profile_id="p2", role="frontend", grade="senior"),
        gold(profile_id="p3", role=None, role_sufficient=False, grade=None, grade_sufficient=False),
    ]
    right = [
        Category("backend", "junior", "middle"),
        Category("frontend", "senior", "senior"),
        Category(None, None, None),
    ]
    values, rows = run_categorization(golds, right)
    assert values["categorization.role_accuracy"] == 1.0
    assert values["categorization.grade_in_range"] == 1.0
    assert values["categorization.grade_range_width"] == 1.5
    assert values["categorization.sufficiency_accuracy.role"] == 1.0
    assert values["categorization.sufficiency_accuracy.grade"] == 1.0
    assert values["categorization.refusal_rate"] == 0.3333
    assert values["categorization.false_refusal_rate"] == 0.0
    # Baselines: the majority role and grade of dev, never refusing.
    assert rows["categorization.role_accuracy"]["baseline"] == 0.5
    assert rows["categorization.grade_in_range"]["baseline"] == 0.5
    assert rows["categorization.sufficiency_accuracy.role"]["baseline"] == 0.6667

    wrong = [
        Category("frontend", "senior", "lead"),
        Category(None, None, None),
        Category("qa_manual", "junior", "junior"),
    ]
    values, _ = run_categorization(golds, wrong)
    assert values["categorization.role_accuracy"] == 0.0
    assert values["categorization.grade_in_range"] == 0.0
    assert values["categorization.sufficiency_accuracy.role"] == pytest.approx(0.3333)
    assert values["categorization.false_refusal_rate"] == 0.5


def test_majority_baselines_are_deterministic():
    assert majority(["b", "a", "b", "a"]) == "a"
    golds = [gold(), gold(role="frontend"), gold(role="frontend", grade="senior")]
    assert majority_role_and_grade(golds) == ("frontend", "middle")
