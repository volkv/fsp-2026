import dataclasses
import json
import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from catalog_fixture import BLOCKS, catalog_info
from fsp_eval import __main__ as main_module
from fsp_eval import run as run_module
from fsp_eval.dataset import DocumentFile, build, load_manifest
from fsp_eval.fsp import build_layer, load_layer
from fsp_eval.holdout import JOURNAL, HoldoutError
from fsp_eval.matching import (
    CATALOG_GRADES,
    TEST_SPECIALIZATION,
    VOCABULARY,
    admissible_categories,
    build_matching,
    load_matching,
    relevance,
)
from fsp_eval.run import (
    RunError,
    RunOptions,
    documents_by_mode,
    execute,
    processing_mode,
    summary,
    threshold_failures,
)

MANIFEST = load_manifest("synthetic-resumes-v3")
DATASET = build(MANIFEST)
LAYER = load_layer("fsp-achievements-v3")
RECORDS = build_layer(LAYER, DATASET)
MATCHING = load_matching("synthetic-matching-v3")
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


def best_category(results: list[dict]) -> tuple[str, str] | None:
    confirmed = [r for r in results if r["outcome"] == "confirmed"]
    if not confirmed:
        return None
    best = max(confirmed, key=lambda r: CATALOG_GRADES.index(r["grade"]))
    return best["specialization"], best["grade"]


class LabelEcho:
    """A bridge that answers with the labels themselves, optionally with every FSP level one step off (`wrong_levels`).
    It reads every need right (the need's own requirements and the categories it admits), holds the category the test
    decisions give with the skills of its defining blocks, and shortlists for a need the holders of a category it
    admits by the relevance the rubric gives them — or in the reverse order (`reverse_ranking`), or every holder of any
    category (`everyone`); the semantic similarity serves a ranking that asks for it on as many needs as `embedded` says
    (all by default); it reports the product revision `revision`."""

    def __init__(
        self,
        *,
        wrong_levels: bool = False,
        reverse_ranking: bool = False,
        everyone: bool = False,
        embedded: int | None = None,
        revision: str = REVISION,
    ) -> None:
        self.revision = revision
        self.wrong_levels = wrong_levels
        self.reverse_ranking = reverse_ranking
        self.everyone = everyone
        self.embedded = embedded
        self.requests: list[dict] = []

    def call(self, request: dict) -> dict:
        self.requests.append(request)
        match request["command"]:
            case "info":
                return {
                    "product_revision": self.revision,
                    **catalog_info(),
                    "versions": {"taxonomy": "test", "catalog": "test"},
                }
            case "extract":
                return {"documents": [self._document(d["id"]) for d in request["documents"]]}
            case "normalize":
                keys = {s: k for g in DATASET.golds.values() for s, k, _ in g.mentions}
                return {"results": [{"skill_key": keys.get(s)} for s in request["surfaces"]]}
            case "evidence":
                return {"profiles": [self._evidence(p["id"]) for p in request["profiles"]]}
            case "rank":
                return self._rank(request)
            case "record":
                return {"id": "run-1", "metrics": len(request["row"]["metrics"]), "failed": []}
        raise AssertionError(request["command"])

    def _rank(self, request: dict) -> dict:
        needs = {v.id: v for v in WORLD.vacancies}
        held = {c["id"]: best_category(c["test_results"]) for c in request["candidates"]}
        rankings, top, semantic = {}, {}, {}
        for ranking in request["rankings"]:
            by_need = {}
            for need in request["needs"]:
                rated = needs[need["id"]]

                def rel(cid: str, rated=rated) -> int:
                    return relevance(rated, WORLD.truths[cid.split("/", 1)[0]])

                considered = ranking.get("per_need", {}).get(need["id"], ranking["candidates"])
                if ranking["admission"] == "given":
                    admitted = list(considered)
                else:
                    admissible = admissible_categories(rated)
                    admitted = [
                        cid
                        for cid in considered
                        if held[cid] is not None and (self.everyone or held[cid] in admissible)
                    ]
                order = sorted(admitted, key=lambda cid, rel=rel: (-rel(cid), cid))
                by_need[need["id"]] = order[::-1] if self.reverse_ranking else order
            rankings[ranking["name"]] = by_need
            top[ranking["name"]] = {
                nid: [{"id": cid, "score": 0.5, "components": {"required": 0.5}} for cid in order[:10]]
                for nid, order in by_need.items()
            }
            embedded = len(request["needs"]) if self.embedded is None else self.embedded
            semantic[ranking["name"]] = (
                {"used": embedded, "unavailable": {} if embedded == len(request["needs"]) else {"timeout": 1}}
                if ranking["semantic"]
                else {"used": 0, "unavailable": {"no_query": len(request["needs"])}}
            )
        categories = {}
        for cid, category in held.items():
            if not any(c["id"] == cid and c["test_results"] for c in request["candidates"]):
                continue
            categories[cid] = (
                []
                if category is None
                else [
                    {
                        "specialization": category[0],
                        "grade": category[1],
                        "confirmed_skill_keys": sorted(
                            {k for _, skills in BLOCKS[category[0]] for k in skills if k in VOCABULARY}
                        ),
                    }
                ]
            )
        return {
            "rankings": rankings,
            "top": top,
            "semantic": semantic,
            "categories": categories,
            "unconfirmed": {name: {nid: [] for nid in by_need} for name, by_need in rankings.items()},
            "declared": {name: {nid: [] for nid in by_need} for name, by_need in rankings.items()},
            "needs": {
                v.id: {
                    "specialization": TEST_SPECIALIZATION.get(v.role),
                    "grade": None,
                    "skill_keys": list(v.required),
                    "nice_skill_keys": list(v.nice),
                    "categories": [f"{s}:{g}" for s, g in sorted(admissible_categories(v))],
                }
                for v in (needs[n["id"]] for n in request["needs"])
            },
            "models": {"match_ruleset": "11", "embedding_space": "none"},
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

    def _evidence(self, profile_id: str) -> dict:
        levels = RECORDS[profile_id].gold.levels
        step = {"L1": "L2", "L2": "L3", "L3": "L4", "L4": "L5", "L5": "L1"}
        return {
            "id": profile_id,
            "fsp_levels": [
                {"discipline": d, "level": step[level] if self.wrong_levels else level} for d, level in levels
            ],
            "skills": [],
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
def options(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    (repo / "taxonomy").mkdir(parents=True)
    taxonomy = Path(__file__).parent / "taxonomy"
    for name in ("skills.json", "grades.json"):
        (repo / "taxonomy" / name).write_text((taxonomy / name).read_text(encoding="utf-8"), encoding="utf-8")
    # The tests run on the holdout: a look at another dataset and the entry of these runs.
    write_journal(
        repo, journal_entry(dataset_id="synthetic-resumes-v2", date="2026-09-25", report="old.json"), journal_entry()
    )

    # The bridge here reads the labels, not the files: the documents are not rendered.
    def documents(dataset, split, directory):
        directory.mkdir(parents=True, exist_ok=True)
        files = []
        for profile in dataset.split(split):
            path = directory / f"{profile.id}.pdf"
            path.write_bytes(b"")
            files.append(DocumentFile(profile.id, path, f"resume-{profile.id}.pdf", "0" * 64))
        return files

    monkeypatch.setattr(run_module, "write_documents", documents)
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
    thresholds.write_text(json.dumps({"thresholds": {"categorization.fsp_level_accuracy": {"min": 0.9}}}))
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
        "categorization.fsp_level_accuracy",
    ):
        assert values[key] == 1.0, key
    # Coverage is the share of records with a level at all: an answer equal to the labels gives exactly that.
    holdout = [RECORDS[p.id] for p in DATASET.split("holdout") if p.id in RECORDS]
    assert values["categorization.fsp_level_coverage"] == round(
        sum(bool(r.gold.levels) for r in holdout) / len(holdout), 4
    )
    assert values["resume.quote_validity"] == 1.0
    assert values["resume.quote_refusal_rate"] == 0.0
    # The product reads no role or grade from a resume: nothing of the kind is measured.
    assert not any(key.startswith("categorization.role") for key in row["metrics"])
    assert row["versions"]["fsp_layer"] == LAYER.id
    # Only the holdout split is sent; achievements go only with the people who have them.
    sent = {d["id"] for d in bridge.requests[1]["documents"]}
    assert sent == {p.id for p in DATASET.split("holdout")}
    evidence = next(r for r in bridge.requests if r["command"] == "evidence")
    assert {p["id"] for p in evidence["profiles"]} == sent & set(RECORDS)
    assert len(evidence["profiles"]) == LAYER.participants["holdout"]
    assert Path(report["report_path"]).is_file()
    assert "ok {'min': 0.9}" in summary(report)
    assert report["threshold_failures"] == []

    wrong = execute(options, LabelEcho(wrong_levels=True))
    accuracy = wrong["row"]["metrics"]["categorization.fsp_level_accuracy"]["value"]
    assert accuracy == 0.0
    assert "FAIL" in summary(wrong)
    assert wrong["threshold_failures"] == [f"categorization.fsp_level_accuracy: {accuracy} outside {{'min': 0.9}}"]
    # The worst order of the same shortlists is worse.
    reversed_rows = execute(options, LabelEcho(reverse_ranking=True))["row"]["metrics"]
    assert reversed_rows["shortlist.ndcg_at_10"]["value"] < values["shortlist.ndcg_at_10"]


def test_the_run_ranks_every_evidence_set_and_checks_the_three_questions(options):
    bridge = LabelEcho()
    report = execute(options, bridge)
    row = report["row"]
    values = {key: metric["value"] for key, metric in row["metrics"].items()}
    # Shortlists of the holders of an admitted category, by the rubric's own relevance: with and without FSP the same,
    # and short of the pool (a person confirmed below their grade is outside the need's categories), so not ideal.
    assert values["shortlist.ndcg_at_10"] == values["shortlist.ndcg_at_10.without_fsp"]
    assert 0 < values["shortlist.ndcg_at_10"] <= values["shortlist.ndcg_at_10.ceiling_admitted"] <= 1.0
    assert values["shortlist.ndcg_at_10.random"] < values["shortlist.ndcg_at_10.keywords_same_text"]
    for measure in ("precision_at_10", "recall_at_10", "mrr"):
        assert 0 <= values[f"shortlist.{measure}"] <= 1
    assert values["shortlist.precision_at_10"] <= values["shortlist.precision_at_10.ceiling"]
    assert 0 < values["shortlist.needs_without_suitable"] < 1
    assert values["shortlist.without_fsp_share_top10"] is not None
    # (a) the echo keeps every rule of the task.
    assert values["shortlist.tz.uncategorized_positions"] == 0
    assert values["shortlist.tz.category_mismatch"] == 0
    assert values["shortlist.tz.outside_need_categories"] == 0
    assert values["shortlist.tz.confirmation_consistency"] == 1.0
    # (c) the sorting of the admissible set by the relevance itself is ideal.
    assert values["shortlist.sorting.ndcg_at_10"] == 1.0
    assert values["shortlist.sorting.ndcg_at_10"] >= values["shortlist.sorting.ndcg_at_10.keywords_same_requirements"]
    # The scenario of false confirmations ranks the falsely confirmed: the echo puts nobody of them first.
    assert values["shortlist.false_confirmed.share_top10"] is not None
    # Without an embedder in the run the variant without it is neither ranked nor computed.
    assert values["shortlist.ndcg_at_10.without_semantic"] is None
    assert row["metrics"]["shortlist.ndcg_at_10"]["n"] == report["matching"]["rated_needs"]
    assert row["versions"]["matching_layer"] == MATCHING.id
    assert row["versions"]["matching_methodology"] == "v3"
    assert row["versions"]["match_ruleset"] == "11"
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
    assert "per_need" not in brief["matching"]
    assert "slices" in brief["matching"]


def test_the_catalog_holds_every_evidence_set_and_the_scenario(options):
    bridge = LabelEcho()
    execute(options, bridge)
    sent = {p.id for p in DATASET.split("holdout")}
    # Each person enters the catalog with FSP achievements and without; a person the scenario of false confirmations
    # confirms — a third time, with its decisions.
    rank = next(r for r in bridge.requests if r["command"] == "rank")
    assert {r["name"]: r["admission"] for r in rank["rankings"]} == {
        "full": "categories",
        "without_fsp": "categories",
        "false_confirmations": "categories",
        "sorting": "given",
    }
    assert not any(ranking["semantic"] for ranking in rank["rankings"])
    false = [c for c in rank["candidates"] if c["id"].endswith("/false-confirmation")]
    assert false
    assert len(rank["candidates"]) == 2 * len(sent) + len(false)
    assert {n["id"] for n in rank["needs"]} == {v.id for v in WORLD.vacancies_of("holdout")}
    assert rank["open_specializations"] == ["backend", "data_ml", "frontend", "qa"]
    without = [c for c in rank["candidates"] if c["id"].endswith("/resume+tests")]
    assert all(c["fsp"] is None for c in without)
    full = {c["id"].split("/")[0]: c for c in rank["candidates"] if c["id"].endswith("/resume+fsp+tests")}
    assert all((full[pid]["fsp"] is not None) == (pid in RECORDS) for pid in full)
    assert all(c["preferences"]["work_formats"] for c in full.values())
    # Every decision carries its blocks; a confirmation of a practice program names its language, a QA one (cases a
    # harness runs) never does.
    decisions = [d for c in full.values() for d in c["test_results"]]
    assert {d["specialization"] for d in decisions if d["outcome"] == "confirmed"} >= {"backend", "qa"}
    for decision in decisions:
        assert decision["blocks"]
        program = decision["outcome"] == "confirmed" and decision["specialization"] != "qa"
        assert ("practice_language" in decision) == program
    # The sorting ranks, for every need, the holders of a category it admits.
    sorting = next(r for r in rank["rankings"] if r["name"] == "sorting")
    assert set(sorting["per_need"]) == {v.id for v in WORLD.vacancies_of("holdout")}


def test_a_run_with_semantic_similarity_ranks_every_variant_with_it_but_one(options):
    semantic = dataclasses.replace(options, semantic=True)
    bridge = LabelEcho()
    report = execute(semantic, bridge)
    rank = next(r for r in bridge.requests if r["command"] == "rank")
    assert {r["name"]: r["semantic"] for r in rank["rankings"]} == {
        "full": True,
        "without_fsp": True,
        "false_confirmations": True,
        "sorting": True,
        "without_semantic": False,
    }
    metrics = report["row"]["metrics"]
    assert metrics["shortlist.ndcg_at_10.without_semantic"] == {
        "value": metrics["shortlist.ndcg_at_10"]["value"],
        "n": report["matching"]["rated_needs"],
        "baseline": metrics["shortlist.ndcg_at_10"]["value"],
    }
    # Asked for and absent, or served for some needs only: no measurement of the product as configured.
    with pytest.raises(RunError, match="had none"):
        execute(semantic, LabelEcho(embedded=0))
    with pytest.raises(RunError, match="some needs only"):
        execute(semantic, LabelEcho(embedded=5))


def test_a_product_worse_than_the_same_text_search_fails_the_relative_threshold(options):
    thresholds, _ = run_module.load_thresholds(run_module.THRESHOLDS_FILE)
    assert thresholds["shortlist.ndcg_at_10.lift_over_keywords_same_text"] == {"min": 0}
    report = execute(options, LabelEcho(reverse_ranking=True))
    lift = report["row"]["metrics"]["shortlist.ndcg_at_10.lift_over_keywords_same_text"]
    assert lift["value"] == round(report["matching"]["deltas"]["ndcg_at_10"]["keywords_same_text"]["ci95"][0], 4) < 0
    assert any(f.startswith("shortlist.ndcg_at_10.lift_over_keywords_same_text:") for f in report["threshold_failures"])
    # The rubric's own order of the admitted holders beats the search by the text.
    passed = execute(options, LabelEcho())["threshold_failures"]
    assert not any(f.startswith("shortlist.ndcg_at_10.lift_over_keywords_same_text:") for f in passed)


def test_a_shortlist_breaking_the_rules_of_the_task_fails_them(options):
    # Every holder of any category in every shortlist: positions outside the categories the need admits.
    report = execute(options, LabelEcho(everyone=True))
    assert report["row"]["metrics"]["shortlist.tz.outside_need_categories"]["value"] > 0
    assert any(f.startswith("shortlist.tz.outside_need_categories:") for f in report["threshold_failures"])


def test_a_run_on_the_holdout_needs_its_entry_in_the_journal(options, monkeypatch, tmp_path):
    report = execute(options, LabelEcho())
    assert report["holdout_access"] == {
        "journal_entry": 1,
        "by": "tester",
        "purpose": "the final measurement",
        "looks_at_dataset": 1,
    }
    assert "HOLDOUT look 1" in summary(report)
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
    # The holdout is opened once: a second look in the mode, a look at another revision, a dataset already seen.
    write_journal(options.repo, journal_entry(date="2026-10-01"), journal_entry())
    with pytest.raises(HoldoutError, match="opened once"):
        execute(options, LabelEcho())
    write_journal(options.repo, journal_entry(mode="model", product_revision="fedcba987654"), journal_entry())
    with pytest.raises(HoldoutError, match="one revision"):
        execute(options, LabelEcho())
    write_journal(options.repo, journal_entry(mode="model"), journal_entry())
    assert execute(options, LabelEcho())["holdout_access"]["looks_at_dataset"] == 2
    path = options.repo / JOURNAL
    path.write_text(
        json.dumps({"status": {MANIFEST.id: "просмотрен"}, "accesses": [journal_entry()]}), encoding="utf-8"
    )
    with pytest.raises(HoldoutError, match="no independent measure"):
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
    thresholds.write_text(json.dumps({"thresholds": {"categorization.fsp_level_accuracy": {"min": 0.9}}}))
    monkeypatch.setattr(run_module, "THRESHOLDS_FILE", thresholds)
    assert command(LabelEcho()) == 0
    assert command(LabelEcho(wrong_levels=True)) == 1
    # A threshold on a variant the run could not compute is a failure too, not a pass.
    thresholds.write_text(json.dumps({"thresholds": {"shortlist.ndcg_at_10.without_semantic": {"min": 0.1}}}))
    assert command(LabelEcho()) == 1


def test_a_run_without_the_fsp_layer_has_no_fsp_levels(options, monkeypatch, tmp_path):
    bare = dataclasses.replace(options, fsp_layer=None, matching=None)
    # The committed thresholds include matching: a run without it is refused, not passed.
    with pytest.raises(RunError, match=r"shortlist\.ndcg_at_10"):
        execute(bare, LabelEcho())
    thresholds = tmp_path / "thresholds.json"
    thresholds.write_text(json.dumps({"thresholds": {"resume.skills_f1": {"min": 0.9}}}))
    monkeypatch.setattr(run_module, "THRESHOLDS_FILE", thresholds)
    row = execute(bare, LabelEcho())["row"]
    assert not any(key.startswith("categorization.fsp_level") for key in row["metrics"])
    assert not any(key.startswith("shortlist.") for key in row["metrics"])
    assert "fsp_layer" not in row["versions"]


def test_a_threshold_of_a_metric_the_run_lacks_stops_the_run(options, monkeypatch, tmp_path):
    thresholds = tmp_path / "thresholds.json"
    thresholds.write_text(json.dumps({"thresholds": {"shortlist.ndcg_at_10": {"min": 0.5}}}))
    monkeypatch.setattr(run_module, "THRESHOLDS_FILE", thresholds)
    with pytest.raises(RunError, match=r"shortlist\.ndcg_at_10"):
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
