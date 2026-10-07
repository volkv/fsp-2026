import base64
import json
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

from catalog_fixture import catalog_info
from fsp_eval.jury import JuryError, Need, jury_metrics, jury_run, read_labels, read_needs

EXAMPLE = Path(__file__).resolve().parents[1] / "jury" / "example.jsonl"


class JuryEcho:
    """A bridge that reads every resume as its own text and shortlists in each lane by a fixed order: `as_product` —
    the candidates with a confirmed test, the order of the input, then as the group «грейд не подтверждён» those whose
    tests confirmed nothing; `resume_only` — everyone, reversed."""

    def __init__(self) -> None:
        self.requests: list[dict] = []

    def call(self, request: dict) -> dict:
        self.requests.append(request)
        match request["command"]:
            case "info":
                return {"product_revision": "0123456789ab", **catalog_info(), "versions": {"catalog": "test"}}
            case "extract":
                return {
                    "documents": [
                        {
                            "id": d["id"],
                            "ok": True,
                            "text": Path(d["path"]).read_text(encoding="utf-8"),
                            "evidence": {},
                            "mode": "rules_only",
                            "producer": "resume-rules/test",
                        }
                        for d in request["documents"]
                    ]
                }
            case "rank":
                return self._rank(request)
        raise AssertionError(request["command"])

    def _rank(self, request: dict) -> dict:
        by_id = {c["id"]: c for c in request["candidates"]}

        def confirmed(cid: str) -> bool:
            return any(r["outcome"] == "confirmed" for r in by_id[cid]["test_results"])

        def explained(people: list[str]) -> list[dict]:
            return [
                {"id": cid, "score": 0.5, "components": {}, "reasons": [], "gaps": [], "to_verify": []}
                for cid in people[:10]
            ]

        rankings, top, unconfirmed, declared, declared_top = {}, {}, {}, {}, {}
        for ranking in request["rankings"]:
            lane = ranking["name"]
            for answer in (rankings, top, unconfirmed, declared, declared_top):
                answer[lane] = {}
            for need_id, people in ranking["per_need"].items():
                order = [cid for cid in people if confirmed(cid)] if lane == "as_product" else people[::-1]
                group = (
                    [cid for cid in people if by_id[cid]["test_results"] and not confirmed(cid)]
                    if lane == "as_product"
                    else []
                )
                rankings[lane][need_id] = order
                unconfirmed[lane][need_id] = [cid for cid in people if not confirmed(cid)]
                declared[lane][need_id] = group
                top[lane][need_id] = explained(order)
                declared_top[lane][need_id] = explained(group)
        return {
            "rankings": rankings,
            "top": top,
            "unconfirmed": unconfirmed,
            "declared": declared,
            "declared_top": declared_top,
            "categories": {
                c["id"]: [
                    {"specialization": r["specialization"], "grade": r["grade"], "confirmed_skill_keys": []}
                    for r in c["test_results"]
                    if r["outcome"] == "confirmed"
                ]
                for c in request["candidates"]
                if c["test_results"]
            },
            "needs": {
                n["id"]: {"specialization": "backend", "categories": ["backend:middle", "qa:junior"]}
                for n in request["needs"]
            },
            "models": {"match_ruleset": "14", "embedding_space": "none"},
        }


def test_the_example_is_read_and_run_in_both_lanes(tmp_path):
    needs = read_needs(EXAMPLE)
    bridge = JuryEcho()
    run = jury_run(bridge, needs, tmp_path, mode="rules_only", concurrency=2, as_of=date(2026, 10, 5), seed=1)
    directory = Path(run["directory"])
    results = json.loads((directory / "results.json").read_text(encoding="utf-8"))
    first = results["needs"][0]
    assert first["need_id"] == "python-middle"
    product = first["lanes"]["as_product"]
    assert [r["candidate_id"] for r in product["ranked"]] == ["a", "b", "d"]
    # The group «грейд не подтверждён» follows the shortlist, its positions after it, with the grade it declared.
    assert [(r["candidate_id"], r["position"]) for r in product["grade_not_confirmed"]["ranked"]] == [("f", 4)]
    assert product["grade_not_confirmed"]["ranked"][0]["declared"] == {
        "specialization": "backend",
        "grade": "middle",
        "outcome": "not_confirmed",
    }
    assert product["not_shown"]["no_test"] == ["c"]
    assert first["inputs"] == {
        "candidates": 5,
        "parsed": 5,
        "with_test_results": 4,
        "with_category": 3,
        "labelled": 5,
        "shortlist": 3,
        "grade_not_confirmed": 1,
    }
    assert results["warnings"] == []
    assert [r["candidate_id"] for r in first["lanes"]["resume_only"]["ranked"]] == ["f", "d", "c", "b", "a"]
    assert first["lanes"]["resume_only"]["title"].startswith("эксперимент без теста")
    # Nobody has a category in the lane without a test: it names who the grade hint left out — here nobody.
    assert first["lanes"]["resume_only"]["not_admitted_by_grade_hint"] == []
    assert "grade_not_confirmed" not in first["lanes"]["resume_only"]
    assert set(first["lanes"]["keywords_same_text"]["ranked"][0]) == {"candidate_id", "position"}
    # The resume-only lane goes without tests and is admitted by the grade hint; the product lane by categories.
    rank = next(r for r in bridge.requests if r["command"] == "rank")
    assert {r["name"]: r["admission"] for r in rank["rankings"]} == {
        "as_product": "categories",
        "resume_only": "grade_hint",
    }
    assert all(not c["test_results"] for c in rank["candidates"] if c["id"].endswith("/resume_only"))
    # The blind sheet: the union of the first tens of every system, no position, score or system.
    sheet = [json.loads(line) for line in (directory / "judging.jsonl").read_text(encoding="utf-8").splitlines()]
    assert {(row["need_id"], row["candidate_id"]) for row in sheet} == {("python-middle", cid) for cid in "abcdf"} | {
        ("qa-junior", cid) for cid in "deg"
    }
    assert all(set(row) == {"need_id", "candidate_id", "label"} and row["label"] is None for row in sheet)
    # The example carries labels: the metrics come with the run.
    metrics = run["metrics"]
    assert metrics["rated_needs"] == 2
    # a (3) of a, b, d and d (3) of d: one suitable of ten positions each; c (2) has no test, f (2) is in the group.
    assert metrics["systems"]["as_product"]["precision_at_10"] == 0.1
    # What the employer sees counts the group too: f joins a in the first need.
    assert metrics["systems"]["as_product_shown"]["precision_at_10"] == round((0.2 + 0.1) / 2, 4)
    assert metrics["systems"]["resume_only"]["mrr"] == round((1 + 1 / 3) / 2, 4)
    assert metrics["systems"]["as_product"]["judged_at_10"] == 1.0
    assert set(metrics["deltas"]) == {
        "as_product_minus_keywords_same_text",
        "as_product_shown_minus_keywords_same_text",
        "resume_only_minus_keywords_same_text",
    }
    assert metrics["inputs"]["with_test_results"] == 6


def test_without_test_results_the_product_shows_nobody_and_says_why(tmp_path):
    needs = read_needs(EXAMPLE)
    untested = [Need(n.need_id, n.text, tuple(replace(c, test_results=[]) for c in n.candidates)) for n in needs]
    run = jury_run(JuryEcho(), untested, tmp_path, mode="rules_only", concurrency=2, as_of=date(2026, 10, 5), seed=1)
    first = run["needs"][0]["lanes"]["as_product"]
    assert first["ranked"] == []
    assert first["grade_not_confirmed"]["ranked"] == []
    assert first["not_shown"]["no_test"] == ["a", "b", "c", "d", "f"]
    assert run["inputs"]["with_test_results"] == 0
    assert run["inputs"]["shortlist"] == 0
    [warning] = run["warnings"]
    assert "нет ни одного решения теста" in warning
    assert run["metrics"]["warnings"] == run["warnings"]
    assert run["metrics"]["systems"]["as_product"]["precision_at_10"] == 0.0


def test_labels_of_the_union_score_both_systems_out_of_ten(tmp_path):
    run = jury_run(
        JuryEcho(), read_needs(EXAMPLE), tmp_path, mode="rules_only", concurrency=2, as_of=date(2026, 10, 5), seed=1
    )
    labels = tmp_path / "labels.jsonl"
    labels.write_text(
        "\n".join(
            json.dumps(row)
            for row in (
                {"need_id": "python-middle", "candidate_id": "c", "label": 3},
                {"need_id": "python-middle", "candidate_id": "a", "label": None},
            )
        ),
        encoding="utf-8",
    )
    metrics = jury_metrics(run, read_labels(labels), seed=1)
    # Only c is suitable: the product shows it in neither group (no test), the reversed lane has it third; unlabelled
    # cards count as not suitable and are seen in judged@10.
    assert metrics["rated_needs"] == 1
    assert metrics["systems"]["as_product"]["precision_at_10"] == 0.0
    assert metrics["systems"]["as_product_shown"]["precision_at_10"] == 0.0
    assert metrics["systems"]["resume_only"]["mrr"] == round(1 / 3, 4)
    assert metrics["systems"]["as_product"]["judged_at_10"] == round((0 + 0) / 2, 4)
    labels.write_text(json.dumps({"need_id": "other", "candidate_id": "x", "label": 1}), encoding="utf-8")
    with pytest.raises(JuryError, match="needs the run has not"):
        jury_metrics(run, read_labels(labels), seed=1)


@pytest.mark.parametrize(
    ("line", "message"),
    [
        ("not json", "not JSON"),
        (json.dumps({"need_id": "n", "need": {"text": "x"}, "candidates": []}), "non-empty list"),
        (
            json.dumps({"need_id": "n", "need": {"text": "x"}, "candidates": [{"candidate_id": "a"}]}),
            "exactly one of resume_text and resume_file",
        ),
        (
            json.dumps(
                {
                    "need_id": "n",
                    "need": {"text": "x"},
                    "candidates": [
                        {
                            "candidate_id": "a",
                            "resume_file": {"name": "cv.exe", "base64": base64.b64encode(b"x").decode()},
                        }
                    ],
                }
            ),
            "resume_file must be one of",
        ),
        (
            json.dumps(
                {
                    "need_id": "n",
                    "need": {"text": "x"},
                    "candidates": [
                        {"candidate_id": "a", "resume_text": "cv"},
                        {"candidate_id": "a", "resume_text": "cv"},
                    ],
                }
            ),
            "repeat within the need",
        ),
        (
            json.dumps(
                {
                    "need_id": "n",
                    "need": {"text": "x"},
                    "candidates": [{"candidate_id": "a", "resume_text": "cv", "label": 5}],
                }
            ),
            "label must be 0–3",
        ),
    ],
)
def test_a_wrong_line_is_refused_with_its_number(tmp_path, line, message):
    path = tmp_path / "needs.jsonl"
    path.write_text("\n" + line + "\n", encoding="utf-8")
    with pytest.raises(JuryError, match=f"line 2: .*{message}"):
        read_needs(path)
