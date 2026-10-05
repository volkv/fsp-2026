"""One evaluation run: render the split, run the product over it through the bridge, compare with the labels and the
baselines, compute the evidence of the people with FSP achievements with them (the FSP levels), shortlist the people of
the split for the needs of the matching layer, check the thresholds fixed beforehand, write the report and, when asked,
the `eval_runs` row with the report file. A run on the holdout needs its entry in the holdout journal first
(holdout.py).
"""

import hashlib
import json
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

from fsp_eval.baselines import (
    NameDictionary,
    taxonomy_names,
    taxonomy_spellings,
)
from fsp_eval.dataset import build, load_manifest, write_documents
from fsp_eval.families import Split
from fsp_eval.fsp import FspRecord, build_layer, load_layer
from fsp_eval.gold import unfamiliar_skills
from fsp_eval.holdout import registered_access
from fsp_eval.lexicon import DISTRACTORS, SKILL_SURFACES, fold_spelling
from fsp_eval.matching import (
    NEEDS_MODEL,
    VARIANTS,
    GradeResult,
    World,
    block_sums,
    build_matching,
    load_matching,
    matching_metrics,
    need_text,
    product_pool,
)
from fsp_eval.metrics import (
    FspLevelCase,
    MetricTable,
    NormalizationPair,
    fsp_level_metrics,
    fsp_levels_of,
    normalization_metrics,
    performance_metrics,
    predicted_fields,
    quote_metrics,
    resume_metrics,
)

HARNESS_VERSION = "fsp-eval/3"
THRESHOLDS_FILE = Path(__file__).resolve().parents[2] / "thresholds.json"

Mode = Literal["rules_only", "model"]


class RunError(Exception):
    pass


@dataclass(frozen=True)
class RunOptions:
    repo: Path
    out: Path
    dataset_id: str
    split: Split
    mode: Mode
    # FSP achievements over the dataset: the FSP levels and the matching world; `None` — none.
    fsp_layer: str | None
    # Vacancies and the truth of the people for matching; `None` — no matching.
    matching: str | None
    concurrency: int = 2
    # Address of the administrator the report file of the recorded run belongs to; `None` — the run is not recorded.
    record_owner: str | None = None
    # Semantic similarity in the ranking: the catalog gets vectors from the configured embedder (`EMBED_*`).
    semantic: bool = False


def load_thresholds(path: Path) -> tuple[dict[str, dict[str, float]], str]:
    content = path.read_bytes()
    return json.loads(content)["thresholds"], hashlib.sha256(content).hexdigest()[:12]


def processing_mode(documents: list[dict[str, Any]]) -> str:
    """What produced the extraction: every document by the model, by rules, a mix, or nothing at all."""
    modes = {document["mode"] for document in documents if document["ok"]}
    if not modes:
        return "failed"
    if len(modes) > 1:
        return "partial"
    return modes.pop()


def documents_by_mode(documents: list[dict[str, Any]]) -> dict[str, int]:
    """How many documents each path produced (`failed` — not read at all): what a `partial` run is made of."""
    counts: dict[str, int] = {}
    for document in documents:
        key = document["mode"] if document["ok"] else "failed"
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def normalization_pairs(golds: list[Any], known: set[str]) -> list[NormalizationPair]:
    seen: dict[str, NormalizationPair] = {}
    for gold in golds:
        for surface, key, typo in gold.mentions:
            pair = NormalizationPair(surface, key, "typo" if typo else "variant", fold_spelling(surface) in known)
            seen.setdefault(surface, pair)
    for surface in DISTRACTORS:
        seen.setdefault(surface, NormalizationPair(surface, None, "unknown", fold_spelling(surface) in known))
    return sorted(seen.values(), key=lambda pair: pair.surface)


def threshold_failures(row: dict[str, Any]) -> list[str]:
    """Metrics outside their thresholds; a metric with a threshold the run could not compute fails too."""
    failures = []
    for key, limit in sorted(row["thresholds"].items()):
        value = row["metrics"][key]["value"]
        if value is None:
            failures.append(f"{key}: not computed, threshold {limit}")
        elif value < limit.get("min", float("-inf")) or value > limit.get("max", float("inf")):
            failures.append(f"{key}: {value} outside {limit}")
    return failures


class BridgeLike(Protocol):
    def call(self, request: dict[str, Any]) -> Any: ...


def skill_spellings(taxonomy_dir: Path) -> dict[str, set[str]]:
    """Spellings of each skill the harness knows: its own lexicon and the canonical name of the taxonomy."""
    spellings: dict[str, set[str]] = {key: set(surfaces) for key, surfaces in SKILL_SURFACES.items()}
    for name, key in taxonomy_names(taxonomy_dir).items():
        spellings.setdefault(key, set()).add(name)
    return spellings


def empty_snapshot(profile_id: str) -> dict[str, Any]:
    """The evidence of a person whose resume was not read: nothing but what FSP adds."""
    return {
        "candidateId": f"eval-{profile_id}",
        "revision": 1,
        "desiredRoleKeys": [],
        "facts": [],
        "claims": [],
        "experience": [],
    }


def run_fsp_levels(
    bridge: BridgeLike,
    *,
    as_of: str,
    records: dict[str, FspRecord],
    documents: dict[str, dict[str, Any]],
) -> tuple[list[FspLevelCase], dict[str, Any]]:
    """The evidence of the people of the split with FSP achievements — their resume snapshot (an empty one for a resume
    not read) with the achievements — and the FSP levels it gives, against the labels of the records."""
    people = [profile_id for profile_id in documents if profile_id in records]
    if not people:
        return [], {}
    answered = bridge.call(
        {
            "command": "evidence",
            "as_of": as_of,
            "profiles": [
                {
                    "id": profile_id,
                    "snapshot": documents[profile_id]["snapshot"]
                    if documents[profile_id]["ok"]
                    else empty_snapshot(profile_id),
                    "fsp": records[profile_id].page,
                }
                for profile_id in people
            ],
        }
    )["profiles"]
    answers = {answer["id"]: answer for answer in answered}
    cases = [FspLevelCase(fsp=records[pid].gold, levels=fsp_levels_of(answers[pid])) for pid in people]
    return cases, answers


# Evidence of a candidate in a ranking variant: with FSP achievements or without; the test result is always there.
EVIDENCE: dict[bool, str] = {True: "resume+fsp+tests", False: "resume+tests"}


@dataclass(frozen=True)
class Ranked:
    # Variant → need id → profile ids of the shortlist, best first.
    rankings: dict[str, dict[str, list[str]]]
    semantic_used: bool
    answer: dict[str, Any]


def _semantic_used(answer: dict[str, Any]) -> bool:
    """Whether the full ranking ordered the almost equal by meaning: a need of one candidate has nothing to order
    (`no_query`); any other reason on some needs only is not a measurement."""
    usage = answer["semantic"]["full"]
    failed = {reason: n for reason, n in usage["unavailable"].items() if reason != "no_query"}
    if usage["used"] > 0 and failed:
        raise RunError(f"the semantic similarity served some needs only: {failed}")
    return usage["used"] > 0


def _test_result(
    seed: int, profile_id: str, test: GradeResult, definitions: dict[tuple[str, str], dict[str, Any]], skills: list[str]
) -> dict[str, Any]:
    """A test result as contracts 11.1 has it, with the blocks of a confirmed one drawn by the harness."""
    result: dict[str, Any] = {"specialization": test.specialization, "grade": test.grade, "outcome": test.outcome}
    if test.outcome == "confirmed":
        definition = definitions[(test.specialization, test.grade)]
        result["blocks"] = block_sums(seed, profile_id, test, definition["defining"], skills)
    return result


def run_ranking(
    bridge: BridgeLike,
    *,
    as_of: str,
    split: Split,
    world: World,
    seed: int,
    records: dict[str, FspRecord],
    documents: dict[str, dict[str, Any]],
    categories: list[dict[str, Any]],
    semantic: bool,
) -> Ranked:
    """The people of the split as candidates of a fresh catalog, once with their FSP achievements and once without, and
    the product's shortlist of every need of the split; the semantic similarity is on or off by the variant, and only in
    a run asked for it."""
    definitions = {(c["specialization"], c["grade"]): c for c in categories}
    candidates = []
    for profile_id, document in documents.items():
        resume = (
            {"evidence": document["evidence"], "mode": document["mode"], "producer": document["producer"]}
            if document["ok"]
            else None
        )
        tests = world.tests[profile_id]
        test = (
            _test_result(seed, profile_id, tests[0], definitions, list(world.truths[profile_id].skills))
            if tests
            else None
        )
        for with_fsp, evidence in EVIDENCE.items():
            record = records.get(profile_id) if with_fsp else None
            candidates.append(
                {
                    "id": f"{profile_id}/{evidence}",
                    "resume": resume,
                    "fsp": None if record is None else record.page,
                    "test_result": test,
                }
            )
    needs = world.vacancies_of(split)
    answer = bridge.call(
        {
            "command": "rank",
            "as_of": as_of,
            "candidates": candidates,
            "needs": [{"id": v.id, "text": need_text(v)} for v in needs],
            "rankings": [
                {
                    "name": name,
                    "candidates": [f"{pid}/{EVIDENCE[spec['fsp']]}" for pid in documents],
                    "semantic": spec["semantic"] and semantic,
                }
                for name, spec in VARIANTS.items()
                if semantic or NEEDS_MODEL.get(name) != "semantic"
            ],
        }
    )
    rankings = {
        name: {need_id: [cid.split("/", 1)[0] for cid in order] for need_id, order in by_need.items()}
        for name, by_need in answer["rankings"].items()
    }
    semantic_used = _semantic_used(answer)
    if semantic and not semantic_used:
        reasons = answer["semantic"]["full"]["unavailable"]
        raise RunError(f"the run asked for semantic similarity and the ranking had none: {reasons}")
    return Ranked(rankings, semantic_used, answer)


def execute(options: RunOptions, bridge: BridgeLike) -> dict[str, Any]:
    manifest = load_manifest(options.dataset_id)
    dataset = build(manifest)
    taxonomy_dir = options.repo / "taxonomy"
    info = bridge.call({"command": "info"})
    access = (
        registered_access(
            options.repo,
            dataset_id=manifest.id,
            mode=options.mode,
            revision=info["product_revision"],
            today=datetime.now(UTC).date(),
        )
        if options.split == "holdout"
        else None
    )

    profiles = dataset.split(options.split)
    golds = [dataset.golds[profile.id] for profile in profiles]
    files = write_documents(dataset, options.split, options.out / "datasets" / manifest.id / options.split)
    layer = load_layer(options.fsp_layer) if options.fsp_layer is not None else None
    records = build_layer(layer, dataset) if layer is not None else {}
    matching = load_matching(options.matching) if options.matching is not None else None
    world = build_matching(matching, dataset, options.fsp_layer, records) if matching is not None else None
    started = time.monotonic()
    extracted = bridge.call(
        {
            "command": "extract",
            "mode": options.mode,
            "as_of": manifest.as_of,
            "concurrency": options.concurrency,
            "documents": [{"id": f.profile_id, "path": str(f.path), "declared_name": f.declared_name} for f in files],
        }
    )["documents"]
    extract_seconds = time.monotonic() - started
    by_id = {document["id"]: document for document in extracted}
    documents = [by_id[profile.id] for profile in profiles]

    known = taxonomy_spellings(taxonomy_dir)
    pairs = normalization_pairs(golds, known)
    normalized = bridge.call({"command": "normalize", "surfaces": [pair.surface for pair in pairs]})["results"]

    parsed = [document for document in documents if document["ok"]]
    by_profile = {profile.id: document for profile, document in zip(profiles, documents, strict=True)}
    fsp_cases, fsp_answers = run_fsp_levels(bridge, as_of=manifest.as_of, records=records, documents=by_profile)
    ranked = (
        run_ranking(
            bridge,
            as_of=manifest.as_of,
            split=options.split,
            world=world,
            seed=matching.seed,
            records=records,
            documents=by_profile,
            categories=info["categories"],
            semantic=options.semantic,
        )
        if world is not None and matching is not None
        else None
    )

    dictionary = NameDictionary(taxonomy_names(taxonomy_dir))
    table = MetricTable()
    resume_metrics(
        table,
        golds,
        documents,
        [dictionary.skills_in(document["text"]) if document["ok"] else set() for document in documents],
        [unfamiliar_skills(profile, known) for profile in profiles],
    )
    normalization_metrics(
        table,
        pairs,
        [result["skill_key"] for result in normalized],
        [dictionary.normalize(pair.surface) for pair in pairs],
    )
    if layer is not None:
        fsp_level_metrics(table, fsp_cases)
    matching_report = None
    if world is not None and ranked is not None and matching is not None:
        pool = product_pool(world, [profile.id for profile in profiles])
        matching_report = matching_metrics(
            table,
            seed=matching.seed,
            vacancies=world.vacancies_of(options.split),
            truths=world.truths,
            pool=pool,
            texts={pid: by_profile[pid]["text"] if by_profile[pid]["ok"] else None for pid in pool},
            rankings=ranked.rankings,
            top=ranked.answer["top"],
            semantic_used=ranked.semantic_used,
            with_fsp=frozenset(records),
        )
        # The same shortlists against rubric v2, side by side, under keys of their own (`matching_v2.*`).
        second = matching_metrics(
            table,
            seed=matching.seed,
            vacancies=world.vacancies_of(options.split),
            truths=world.truths,
            pool=pool,
            texts={pid: by_profile[pid]["text"] if by_profile[pid]["ok"] else None for pid in pool},
            rankings=ranked.rankings,
            top=ranked.answer["top"],
            semantic_used=ranked.semantic_used,
            with_fsp=frozenset(records),
            rubric="v2",
        )
        matching_report["rubric_v2"] = {key: value for key, value in second.items() if key != "per_vacancy"}
        matching_report["bridge"] = {
            key: value for key, value in ranked.answer.items() if key not in {"rankings", "top"}
        }
    quotes = quote_metrics(table, documents, skill_spellings(taxonomy_dir))
    performance_metrics(table, documents)

    thresholds, thresholds_sha = load_thresholds(THRESHOLDS_FILE)
    missing = sorted(set(thresholds) - set(table.rows))
    if missing:
        raise RunError(f"thresholds name metrics the run does not compute: {', '.join(missing)}")
    versions: dict[str, Any] = {
        **info["versions"],
        "docparse": ", ".join(sorted({d["parse"]["extractor"] for d in parsed})) or "none",
        "extract_producer": ", ".join(sorted({d["producer"] for d in parsed})) or "none",
        "dataset_generator": manifest.generator,
        "dataset_labels_sha256": manifest.labels_sha256,
        **({"fsp_layer": layer.id, "fsp_layer_labels_sha256": layer.labels_sha256} if layer is not None else {}),
        **(
            {"matching_layer": matching.id, "matching_layer_labels_sha256": matching.labels_sha256}
            if matching is not None
            else {}
        ),
        **(ranked.answer["models"] if ranked is not None else {}),
        "harness": HARNESS_VERSION,
        "thresholds_sha256": thresholds_sha,
    }
    row = {
        "dataset_id": manifest.id,
        "dataset_size": len(profiles),
        "dataset_provenance": manifest.provenance,
        "split": f"{options.split}-by-profile-and-family",
        "versions": versions,
        "processing_mode": processing_mode(documents),
        "thresholds": thresholds,
        "metrics": table.rows,
    }
    report = {
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "product_revision": info["product_revision"],
        "requested_mode": options.mode,
        "documents_by_mode": documents_by_mode(documents),
        "holdout_access": None if access is None else access.to_json(),
        "timing": {
            "extract_seconds": round(extract_seconds, 1),
            "seconds_per_document": round(extract_seconds / len(profiles), 3),
            "concurrency": options.concurrency,
        },
        "row": row,
        "threshold_failures": threshold_failures(row),
        "matching": matching_report,
        "documents": [
            {
                "profile_id": profile.id,
                "family": profile.family,
                "kind": profile.kind,
                "file_sha256": file.sha256,
                "parse": document["parse"] if document["ok"] else document["error"],
                "model_failure": document.get("model_failure"),
                "gold": gold.to_json(),
                "predicted": predicted_fields(document),
                "quote_failures": [asdict(check) for check in checks if not check.supports],
                "fsp": _fsp_report(records.get(profile.id), fsp_answers.get(profile.id)),
            }
            for profile, file, document, gold, checks in zip(profiles, files, documents, golds, quotes, strict=True)
        ],
    }
    return _write(options, f"{manifest.id}-{options.split}-{options.mode}", report, bridge)


def _write(options: RunOptions, name: str, report: dict[str, Any], bridge: BridgeLike) -> dict[str, Any]:
    """The report into its run directory and, when asked, the row with the report file into `eval_runs`."""
    row = report["row"]
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    directory = options.out / "runs" / f"{stamp}-{name}"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    report["report_path"] = str(path)
    # The numbers without the documents and the per-vacancy detail: small enough to keep with the code.
    brief = {key: value for key, value in report.items() if key not in {"documents", "report_path"}}
    if brief["matching"] is not None:
        brief["matching"] = {key: value for key, value in brief["matching"].items() if key != "per_vacancy"}
    (directory / "summary.json").write_text(json.dumps(brief, ensure_ascii=False, indent="\t") + "\n", encoding="utf-8")
    if options.record_owner is not None:
        # The report file goes with the row: the panel links the run to it.
        recorded = bridge.call(
            {
                "command": "record",
                "row": row,
                "report": {
                    "path": str(path),
                    "name": f"eval-{directory.name}.json",
                    "owner_email": options.record_owner,
                },
            }
        )
        (directory / "recorded.json").write_text(json.dumps(recorded, ensure_ascii=False, indent=1), encoding="utf-8")
        report["recorded"] = recorded
    return report


def _fsp_report(record: FspRecord | None, answer: dict[str, Any] | None) -> dict[str, Any] | None:
    if record is None:
        return None
    return {"gold": record.gold.to_json(), "with_fsp_levels": fsp_levels_of(answer)}


def summary(report: dict[str, Any]) -> str:
    row = report["row"]
    by_mode = ", ".join(f"{mode} {count}" for mode, count in report["documents_by_mode"].items())
    lines = [
        f"{row['dataset_id']} / {row['split']} / {row['processing_mode']} — {row['dataset_size']} documents"
        f" ({by_mode}), revision {report['product_revision']}",
    ]
    access = report["holdout_access"]
    if access is not None:
        lines.append(
            f"HOLDOUT look {access['looks_at_dataset']} at {row['dataset_id']} (journal entry"
            f" {access['journal_entry']}, {access['by']}): write the report and what it showed into the journal"
        )
    lines.append(f"{'metric':52} {'value':>8} {'baseline':>9} {'n':>6}  threshold")
    for key, metric in row["metrics"].items():
        limit = row["thresholds"].get(key)
        value = metric["value"]
        verdict = ""
        if limit is not None and value is None:
            verdict = f"FAIL not computed {limit}"
        elif limit is not None:
            ok = value >= limit.get("min", float("-inf")) and value <= limit.get("max", float("inf"))
            verdict = f"{'ok' if ok else 'FAIL'} {limit}"
        base = metric.get("baseline")
        lines.append(
            f"{key:52} {'—' if value is None else f'{value:.4f}':>8} "
            f"{'' if base is None else f'{base:.4f}':>9} {metric['n']:>6}  {verdict}"
        )
    timing = report["timing"]
    lines.append(
        f"extraction: {timing['extract_seconds']} s, {timing['seconds_per_document']} s per document"
        f" at concurrency {timing['concurrency']}"
    )
    if report["matching"] is not None:
        for rubric, deltas in (
            ("v1", report["matching"]["deltas"]),
            ("v2", report["matching"].get("rubric_v2", {}).get("deltas", {})),
        ):
            for name, delta in deltas.items():
                low, high = delta["ci95"]
                lines.append(
                    f"{rubric} {name:49} {delta['mean']:+.4f}  95% CI [{low:+.4f}, {high:+.4f}]  n={delta['n']}"
                )
    if "recorded" in report:
        lines.append(f"eval_runs row {report['recorded']['id']}: {report['recorded']}")
    lines.append(f"report: {report['report_path']}")
    for failure in report["threshold_failures"]:
        lines.append(f"THRESHOLD FAILED {failure}")
    return "\n".join(lines)
