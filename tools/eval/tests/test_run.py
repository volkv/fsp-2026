import dataclasses
import json
import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from fsp_eval import __main__ as main_module
from fsp_eval import run as run_module
from fsp_eval.dataset import build, load_manifest
from fsp_eval.fsp import build_layer, load_layer
from fsp_eval.holdout import JOURNAL, HoldoutError
from fsp_eval.matching import VARIANTS, build_matching, load_matching, relevance
from fsp_eval.run import (
    RunError,
    RunOptions,
    documents_by_mode,
    execute,
    processing_mode,
    summary,
    threshold_failures,
)

MANIFEST = load_manifest("synthetic-resumes-v2")
DATASET = build(MANIFEST)
LAYER = load_layer("fsp-achievements-v2")
RECORDS = build_layer(LAYER, DATASET)
MATCHING = load_matching("synthetic-matching-v1")
WORLD = build_matching(MATCHING, DATASET, LAYER.id, RECORDS)
KEY = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$")
REVISION = "0123456789abcdef0123456789abcdef01234567"


def _period(key: str) -> dict:
    start, end = key.split("/")

    def point(value: str) -> tuple[str, str]:
        return (f"{value}-01-01", "year") if len(value) == 4 else (f"{value}-01", "month")

    from_date, from_precision = point(start)
    current = end == "present"
    to_date, to_precision = (None, None) if current else point(end)
    return {
        "from": from_date,
        "from_precision": from_precision,
        "to": to_date,
        "to_precision": to_precision,
        "is_current": current,
        "status": "valid",
    }


class LabelEcho:
    """A bridge that answers with the labels themselves, optionally with the roles swapped for another one (with FSP
    achievements, `wrong_fsp_role`); it ranks the people by the relevance the rubric gives them, or in the reverse order
    (`reverse_ranking`); the reranker ranks as many vacancies as `reranked` says (all by default), the semantic
    similarity serves a ranking that asks for it on as many as `embedded` says (all by default); it reports the product
    revision `revision`."""

    def __init__(
        self,
        wrong_role: str | None = None,
        wrong_fsp_role: str | None = None,
        *,
        reverse_ranking: bool = False,
        reranked: int | None = None,
        embedded: int | None = None,
        revision: str = REVISION,
    ) -> None:
        self.revision = revision
        self.wrong_role = wrong_role
        self.wrong_fsp_role = wrong_fsp_role
        self.reverse_ranking = reverse_ranking
        self.reranked = reranked
        self.embedded = embedded
        self.requests: list[dict] = []

    def call(self, request: dict) -> dict:
        self.requests.append(request)
        match request["command"]:
            case "info":
                return {"product_revision": self.revision, "versions": {"taxonomy": "test"}}
            case "extract":
                return {"documents": [self._document(d["id"]) for d in request["documents"]]}
            case "normalize":
                keys = {s: k for g in DATASET.golds.values() for s, k, _ in g.mentions}
                return {"results": [{"skill_key": keys.get(s)} for s in request["surfaces"]]}
            case "categorize":
                return {"profiles": [self._category(p["id"], fsp="fsp" in p) for p in request["profiles"]]}
            case "rank":
                return self._rank(request)
            case "record":
                return {"id": "run-1", "metrics": len(request["row"]["metrics"]), "failed": []}
        raise AssertionError(request["command"])

    def _rank(self, request: dict) -> dict:
        vacancies = {v.id: v for v in WORLD.vacancies}
        rankings, top, reranker, semantic = {}, {}, {}, {}
        for ranking in request["rankings"]:
            by_vacancy = {}
            for vacancy in request["vacancies"]:
                rated = vacancies[vacancy["id"]]

                def rel(cid: str, rated=rated) -> int:
                    return relevance(rated, WORLD.truths[cid.split("/", 1)[0]])

                order = sorted(ranking["candidates"], key=lambda cid, rel=rel: (-rel(cid), cid))
                by_vacancy[vacancy["id"]] = order[::-1] if self.reverse_ranking else order
            rankings[ranking["name"]] = by_vacancy
            top[ranking["name"]] = {
                vid: [{"id": cid, "score": 0.5, "components": {"required": 0.5}} for cid in order[:10]]
                for vid, order in by_vacancy.items()
            }
            used = len(request["vacancies"]) if self.reranked is None else self.reranked
            reranker[ranking["name"]] = (
                {"used": used, "unavailable": {}}
                if ranking["reranker"]
                else {"used": 0, "unavailable": {"disabled": 1}}
            )
            embedded = len(request["vacancies"]) if self.embedded is None else self.embedded
            semantic[ranking["name"]] = (
                {"used": embedded, "unavailable": {}}
                if ranking["semantic"]
                else {"used": 0, "unavailable": {"no_active_space": len(request["vacancies"])}}
            )
        return {
            "rankings": rankings,
            "top": top,
            "reranker": reranker,
            "semantic": semantic,
            "models": {"match_ruleset": "3", "reranker": "reranker@test", "embedding_space": "none"},
        }

    def _document(self, profile_id: str) -> dict:
        gold = DATASET.golds[profile_id]
        claims = [
            {"kind": "skill_mention", "raw_text": k, "polarity": "asserted", "skill_key": k, "value": None}
            for k in gold.skills
        ]
        claims += [
            {
                "kind": "language_level",
                "raw_text": "English" if code == "en" else "German",
                "polarity": "asserted",
                "skill_key": None,
                "value": {"level": level},
            }
            for code, level in (value.split(":") for value in gold.languages)
        ]
        claims += [
            {"kind": "education", "raw_text": e, "polarity": "asserted", "skill_key": None, "value": None}
            for e in gold.education
        ]
        claims += [
            {
                "kind": "responsibility_marker",
                "raw_text": m,
                "polarity": "asserted",
                "skill_key": None,
                "value": {"marker": m},
            }
            for m in gold.markers
        ]
        # Each claim quotes itself from a block of its own: the text is the quotes joined.
        text, blocks = "", []
        for index, claim in enumerate(claims):
            quote = claim["raw_text"] + (f" {claim['value']['level']}" if claim["kind"] == "language_level" else "")
            text += "\n\n" if index else ""
            blocks.append({"id": f"b{index}", "start": len(text), "end": len(text) + len(quote)})
            claim["quote"] = {"block_id": f"b{index}", "start": 0, "end": len(quote), "text": quote}
            text += quote
        entries = []
        for index, role in enumerate(gold.roles):
            no_period = {
                "from": None,
                "from_precision": None,
                "to": None,
                "to_precision": None,
                "is_current": False,
                "status": "missing",
            }
            period = _period(gold.periods[index]) if index < len(gold.periods) else no_period
            entries.append({"role_key": role, "organization_name": gold.organizations[index], "period": period})
        return {
            "id": profile_id,
            "ok": True,
            "parse": {"extractor": "docparse@test"},
            "text": text,
            "blocks": blocks,
            "mode": "rules_only",
            "producer": "resume-rules/1",
            "claims": claims,
            "entries": entries,
            "items": len(claims),
            "rejected": {},
            "timing": {"parse_ms": 10, "extract_ms": 2},
            "snapshot": {},
            "evidence": {"fact": {"id": profile_id}, "claims": [], "entries": []},
        }

    def _category(self, profile_id: str, *, fsp: bool) -> dict:
        gold = DATASET.golds[profile_id]
        record = RECORDS[profile_id] if fsp else None
        levels = [{"discipline": d, "level": level} for d, level in record.gold.levels] if record else []
        role = gold.role
        if record is not None:
            role = record.gold.role if gold.role_sufficient or record.gold.role_grounded else None
            role = self.wrong_fsp_role or role
        if role is None:
            return {"id": profile_id, "assignments": [], "fsp_levels": levels}
        grade = gold.grade if gold.grade_sufficient else None
        return {
            "id": profile_id,
            "assignments": [
                {
                    "rank": "primary",
                    "role_status": "established",
                    "role_key": self.wrong_role or role,
                    "grade_status": "established" if grade else "insufficient_data",
                    "grade_min": grade,
                    "grade_max": grade,
                }
            ],
            "fsp_levels": levels,
        }


def journal_entry(**changes: object) -> dict:
    return {
        "dataset_id": MANIFEST.id,
        "mode": "rules_only",
        "product_revision": REVISION[:12],
        "date": datetime.now(UTC).date().isoformat(),
        "by": "tester",
        "purpose": "the final measurement",
        "report": None,
        "seen": None,
        **changes,
    }


def write_journal(repo: Path, *entries: dict) -> None:
    path = repo / JOURNAL
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"accesses": list(entries)}), encoding="utf-8")


@pytest.fixture
def options(tmp_path):
    repo = tmp_path / "repo"
    (repo / "taxonomy").mkdir(parents=True)
    taxonomy = Path(__file__).parent / "taxonomy"
    for name in ("skills.json", "grades.json"):
        (repo / "taxonomy" / name).write_text((taxonomy / name).read_text(encoding="utf-8"), encoding="utf-8")
    # The tests run on the holdout: an earlier look at it and the entry of these runs.
    write_journal(repo, journal_entry(date="2026-09-25", report="old.json", seen="F1 0.97"), journal_entry())
    return RunOptions(
        repo=repo,
        out=tmp_path / "out",
        dataset_id=MANIFEST.id,
        split="holdout",
        mode="rules_only",
        fsp_layer=LAYER.id,
        matching=MATCHING.id,
        record_owner="admin@example.com",
    )


def test_answers_equal_to_the_labels_meet_every_threshold(options, monkeypatch, tmp_path):
    thresholds = tmp_path / "thresholds.json"
    thresholds.write_text(json.dumps({"thresholds": {"categorization.role_accuracy": {"min": 0.9}}}))
    monkeypatch.setattr(run_module, "THRESHOLDS_FILE", thresholds)
    bridge = LabelEcho()
    report = execute(options, bridge)
    row = report["row"]
    assert row["dataset_size"] == MANIFEST.splits["holdout"]["profiles"]
    assert row["processing_mode"] == "rules_only"
    assert row["split"] == "holdout-by-profile-and-family"
    assert all(KEY.match(key) for key in row["metrics"])
    values = {key: metric["value"] for key, metric in row["metrics"].items()}
    for key in (
        "resume.skills_f1",
        "resume.fields_f1",
        "skills.normalization_accuracy",
        "categorization.role_accuracy",
        "categorization.grade_in_range",
        "categorization.sufficiency_accuracy.role",
        "categorization.sufficiency_accuracy.grade",
    ):
        assert values[key] == 1.0, key
    assert values["categorization.false_refusal_rate"] == 0.0
    assert values["resume.quote_validity"] == 1.0
    assert values["resume.quote_refusal_rate"] == 0.0
    for key in (
        "categorization.role_accuracy.with_fsp",
        "categorization.fsp_level_accuracy",
        "categorization.grade_in_range.with_fsp",
    ):
        assert values[key] == 1.0, key
    assert values["categorization.role_wrong_rate.with_fsp"] == 0.0
    # People nothing grounds a role for stay unfound even by an answer equal to the labels.
    assert values["categorization.role_found.without_fsp"] < values["categorization.role_found.with_fsp"] < 1.0
    # Both variants of the ablation count the same people.
    for key in (k for k in row["metrics"] if k.endswith(".with_fsp")):
        assert row["metrics"][key]["n"] == row["metrics"][key.replace("with_fsp", "without_fsp")]["n"], key
    assert row["versions"]["fsp_layer"] == LAYER.id
    # Only the holdout split is rendered and sent; achievements go only with the people who have them.
    sent = {d["id"] for d in bridge.requests[1]["documents"]}
    assert sent == {p.id for p in DATASET.split("holdout")}
    with_fsp = next(r for r in bridge.requests if r["command"] == "categorize" and "fsp" in r["profiles"][0])
    assert {p["id"] for p in with_fsp["profiles"]} == sent & set(RECORDS)
    assert len(with_fsp["profiles"]) == LAYER.participants["holdout"]
    assert Path(report["report_path"]).is_file()
    assert "ok {'min': 0.9}" in summary(report)
    assert report["threshold_failures"] == []

    wrong = execute(options, LabelEcho(wrong_role="qa_manual"))
    assert wrong["row"]["metrics"]["categorization.role_accuracy"]["value"] < 0.2
    assert "FAIL" in summary(wrong)
    assert wrong["threshold_failures"] == [
        f"categorization.role_accuracy: {wrong['row']['metrics']['categorization.role_accuracy']['value']} "
        "outside {'min': 0.9}"
    ]
    # A product that FSP achievements lead to another role: the resume metrics hold, the ablation shows the loss.
    misled = execute(options, LabelEcho(wrong_fsp_role="algo_engineer"))["row"]["metrics"]
    assert misled["categorization.role_accuracy"]["value"] == 1.0
    assert misled["categorization.role_found.with_fsp"]["value"] == 0.0
    assert misled["categorization.role_found.with_fsp"]["baseline"] > 0.5
    # The worst order of the pool: every variant falls below the keyword search.
    reversed_rows = execute(options, LabelEcho(reverse_ranking=True))["row"]["metrics"]
    assert reversed_rows["matching.ndcg_at_10"]["value"] < reversed_rows["matching.ndcg_at_10"]["baseline"]


def test_the_run_ranks_every_evidence_set_and_records_the_report(options):
    bridge = LabelEcho()
    report = execute(options, bridge)
    row = report["row"]
    values = {key: metric["value"] for key, metric in row["metrics"].items()}
    # A ranking by the rubric's own relevance is ideal in every variant and beats both baselines.
    for name in (name for name in VARIANTS if name != "without_semantic"):
        key = "matching.ndcg_at_10" if name == "full" else f"matching.ndcg_at_10.{name}"
        assert values[key] == 1.0, key
    assert values["matching.ndcg_at_10.random"] < values["matching.ndcg_at_10.keywords"] < 1.0
    assert values["matching.ndcg_at_10.lift_over_keywords"] > 0
    # Without an embedder in the run the variant without it is neither ranked nor computed.
    assert values["matching.ndcg_at_10.without_semantic"] is None
    assert row["metrics"]["matching.ndcg_at_10"]["n"] == report["matching"]["rated_vacancies"]
    assert row["versions"]["matching_layer"] == MATCHING.id
    assert row["versions"]["reranker"] == "reranker@test"
    assert report["recorded"]["id"] == "run-1"
    record = bridge.requests[-1]
    assert record["command"] == "record"
    assert record["row"] == row
    assert record["report"] == {
        "path": report["report_path"],
        "name": f"eval-{Path(report['report_path']).parent.name}.json",
        "owner_email": "admin@example.com",
    }
    assert (Path(report["report_path"]).parent / "recorded.json").is_file()
    brief = json.loads((Path(report["report_path"]).parent / "summary.json").read_text(encoding="utf-8"))
    assert brief["row"] == row
    assert "documents" not in brief
    assert "per_vacancy" not in brief["matching"]
    sent = {p.id for p in DATASET.split("holdout")}
    # Each person enters the catalog once per evidence set; FSP and tests only with the sets that carry them.
    rank = next(r for r in bridge.requests if r["command"] == "rank")
    assert not any(ranking["semantic"] for ranking in rank["rankings"])
    assert "without_semantic" not in {ranking["name"] for ranking in rank["rankings"]}
    assert len(rank["candidates"]) == 4 * len(sent)
    assert {v["id"] for v in rank["vacancies"]} == {v.id for v in WORLD.vacancies_of("holdout")}
    resume_only = [c for c in rank["candidates"] if c["id"].endswith("/resume")]
    assert all(c["fsp"] is None and c["tests"] == [] for c in resume_only)
    full = {c["id"].split("/")[0]: c for c in rank["candidates"] if c["id"].endswith("/resume+fsp+tests")}
    assert all((full[pid]["fsp"] is not None) == (pid in RECORDS) for pid in full)


def test_a_reranker_that_ranked_some_vacancies_stops_the_run(options):
    with pytest.raises(RunError, match="mixed run"):
        execute(options, LabelEcho(reranked=3))
    # Without a reranker at all the variant without it is not computed.
    row = execute(options, LabelEcho(reranked=0))["row"]
    assert row["metrics"]["matching.ndcg_at_10.without_reranker"] == {"value": None, "n": 0, "baseline": 1.0}


def test_a_run_with_semantic_similarity_ranks_every_variant_with_it_but_one(options):
    semantic = dataclasses.replace(options, semantic=True)
    bridge = LabelEcho()
    report = execute(semantic, bridge)
    rank = next(r for r in bridge.requests if r["command"] == "rank")
    assert {r["name"]: r["semantic"] for r in rank["rankings"]} == {
        name: name != "without_semantic" for name in VARIANTS
    }
    assert report["row"]["metrics"]["matching.ndcg_at_10.without_semantic"] == {
        "value": 1.0,
        "n": report["matching"]["rated_vacancies"],
        "baseline": 1.0,
    }
    # Asked for and absent, or served for some vacancies only: no measurement of the product as configured.
    with pytest.raises(RunError, match="had none"):
        execute(semantic, LabelEcho(embedded=0))
    with pytest.raises(RunError, match="mixed run"):
        execute(semantic, LabelEcho(embedded=5))


def test_a_product_worse_than_the_keyword_search_fails_the_relative_threshold(options):
    # The absolute floor alone let such a product pass: the relative threshold is committed next to it.
    thresholds, _ = run_module.load_thresholds(run_module.THRESHOLDS_FILE)
    assert thresholds["matching.ndcg_at_10.lift_over_keywords"] == {"min": 0}
    report = execute(options, LabelEcho(reverse_ranking=True))
    lift = report["row"]["metrics"]["matching.ndcg_at_10.lift_over_keywords"]
    assert lift["value"] == round(report["matching"]["deltas"]["full_minus_keywords"]["ci95"][0], 4) < 0
    assert any(f.startswith("matching.ndcg_at_10.lift_over_keywords:") for f in report["threshold_failures"])
    passed = execute(options, LabelEcho())["threshold_failures"]
    assert not any(f.startswith("matching.ndcg_at_10.lift_over_keywords:") for f in passed)


def test_a_run_on_the_holdout_needs_its_entry_in_the_journal(options, monkeypatch, tmp_path):
    report = execute(options, LabelEcho())
    assert report["holdout_access"] == {
        "journal_entry": 1,
        "by": "tester",
        "purpose": "the final measurement",
        "looks_at_dataset": 2,
    }
    assert "HOLDOUT look 2" in summary(report)
    # An entry of another day, mode or revision, or without who and why, is not this run's.
    for entry in (
        journal_entry(date="2026-09-25"),
        journal_entry(mode="model"),
        journal_entry(product_revision="fedcba987654"),
        journal_entry(product_revision=REVISION[:8]),
        journal_entry(by=""),
        journal_entry(purpose=None),
    ):
        write_journal(options.repo, entry)
        with pytest.raises(HoldoutError, match="no entry for this run"):
            execute(options, LabelEcho())
    # A bridge built with uncommitted changes is refused even when the journal holds an entry of its commit; a dev run
    # of it goes on and its report names the revision as the bridge gave it.
    write_journal(options.repo, journal_entry())
    for revision in (f"{REVISION[:12]}-dirty", f"{REVISION}-dirty", "v1.2.3-release"):
        with pytest.raises(HoldoutError, match="not a commit"):
            execute(options, LabelEcho(revision=revision))
    dirty = execute(dataclasses.replace(options, split="dev"), LabelEcho(revision=f"{REVISION[:12]}-dirty"))
    assert dirty["product_revision"] == f"{REVISION[:12]}-dirty"
    assert f"revision {REVISION[:12]}-dirty" in summary(dirty)
    (options.repo / JOURNAL).unlink()
    with pytest.raises(HoldoutError, match="no holdout journal"):
        execute(options, LabelEcho())
    # A dev run needs no entry.
    dev = execute(dataclasses.replace(options, split="dev"), LabelEcho())
    assert dev["holdout_access"] is None

    # The command line has no default split: a bare run is refused before it looks at anything.
    monkeypatch.setattr(main_module, "Bridge", lambda repo, env: LabelEcho())
    with pytest.raises(SystemExit):
        main_module.main(["run", "--repo", str(options.repo), "--out", str(tmp_path / "cli")])


def test_a_failed_threshold_or_a_metric_not_computed_at_one_fails_the_command(options, monkeypatch, tmp_path):
    row = {
        "thresholds": {"a.b": {"min": 0.5}, "a.c": {"max": 2}, "a.d": {"min": 0.1}},
        "metrics": {"a.b": {"value": 0.4}, "a.c": {"value": None}, "a.d": {"value": 0.1}},
    }
    assert threshold_failures(row) == ["a.b: 0.4 outside {'min': 0.5}", "a.c: not computed, threshold {'max': 2}"]

    def command(bridge: LabelEcho) -> int:
        monkeypatch.setattr(main_module, "Bridge", lambda repo, env: bridge)
        return main_module.main(
            ["run", "--repo", str(options.repo), "--out", str(tmp_path / "cli"), "--split", "holdout"]
        )

    thresholds = tmp_path / "thresholds.json"
    thresholds.write_text(json.dumps({"thresholds": {"categorization.role_accuracy": {"min": 0.9}}}))
    monkeypatch.setattr(run_module, "THRESHOLDS_FILE", thresholds)
    assert command(LabelEcho()) == 0
    assert command(LabelEcho(wrong_role="qa_manual")) == 1
    # A threshold on a variant the run could not compute is a failure too, not a pass.
    thresholds.write_text(json.dumps({"thresholds": {"matching.ndcg_at_10.without_reranker": {"min": 0.1}}}))
    assert command(LabelEcho(reranked=0)) == 1


def test_a_run_without_the_fsp_layer_has_no_ablation(options, monkeypatch, tmp_path):
    bare = dataclasses.replace(options, fsp_layer=None, matching=None)
    # The committed thresholds include matching: a run without it is refused, not passed.
    with pytest.raises(RunError, match=r"matching\.ndcg_at_10"):
        execute(bare, LabelEcho())
    thresholds = tmp_path / "thresholds.json"
    thresholds.write_text(json.dumps({"thresholds": {"categorization.role_accuracy": {"min": 0.9}}}))
    monkeypatch.setattr(run_module, "THRESHOLDS_FILE", thresholds)
    row = execute(bare, LabelEcho())["row"]
    assert not any(key.endswith(("with_fsp", "without_fsp")) for key in row["metrics"])
    assert not any(key.startswith("matching.") for key in row["metrics"])
    assert "fsp_layer" not in row["versions"]


def test_a_threshold_of_a_metric_the_run_lacks_stops_the_run(options, monkeypatch, tmp_path):
    thresholds = tmp_path / "thresholds.json"
    thresholds.write_text(json.dumps({"thresholds": {"matching.ndcg_at_10": {"min": 0.5}}}))
    monkeypatch.setattr(run_module, "THRESHOLDS_FILE", thresholds)
    with pytest.raises(RunError, match=r"matching\.ndcg_at_10"):
        execute(dataclasses.replace(options, matching=None), LabelEcho())


def test_the_committed_thresholds_name_only_computed_metrics(options):
    # Every committed threshold names a metric a run computes (the run refuses otherwise).
    report = execute(options, LabelEcho())
    assert set(report["row"]["thresholds"]) <= set(report["row"]["metrics"])
    assert report["row"]["thresholds"]


def test_load_thresholds_reads_the_committed_quote_validity_floor():
    thresholds, _ = run_module.load_thresholds(run_module.THRESHOLDS_FILE)
    assert thresholds["resume.quote_validity"] == {"min": 0.98}


def test_processing_mode_of_a_run():
    assert processing_mode([{"ok": True, "mode": "rules_only"}]) == "rules_only"
    assert processing_mode([{"ok": True, "mode": "model"}, {"ok": True, "mode": "rules_only"}]) == "partial"
    assert processing_mode([{"ok": True, "mode": "model"}, {"ok": False}]) == "model"
    assert processing_mode([{"ok": False}]) == "failed"
    # What a partial run is made of, written into its report.
    mixed = [{"ok": True, "mode": "model"}, {"ok": True, "mode": "rules_only"}, {"ok": True, "mode": "model"}]
    assert documents_by_mode([*mixed, {"ok": False}]) == {"failed": 1, "model": 2, "rules_only": 1}


def test_the_report_counts_the_documents_of_each_processing_mode(options):
    report = execute(options, LabelEcho())
    size = report["row"]["dataset_size"]
    assert report["documents_by_mode"] == {"rules_only": size}
    assert f"{size} documents (rules_only {size})" in summary(report)
