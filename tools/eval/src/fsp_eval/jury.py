"""The jury's mode (docs/contracts.md 10.1): needs and candidates of the jury in a JSONL file → the product's shortlist
of every need in two lanes — `as_product` (a category only from a confirmed test, the product's path) and `resume_only`
(the experiment without a test: a category from the grade hint of the resume, unconfirmed) — next to the search by the
same text of the need over the same candidates, a blind sheet of the union of their first tens, and, by the jury's
labels, Precision@10, nDCG@10, MRR and judged@10 with paired bootstrap intervals.

The product shows two groups for a need (domain 13.10): the shortlist — the candidates holding a category of it from a
confirmed test — and after it the group «грейд не подтверждён» — no category of its specializations, the grade they
declared there — the one of their last test, or one declared in the survey without a test (`declared`) — naming one of
its categories. `as_product` is the shortlist; `as_product_shown` is what the
employer sees, the shortlist and then the group. Who the product shows in neither, and why, is listed apart. What the
input confirms — how many candidates carry test results and hold a category — goes with every run: without test results
the shortlist is empty by the terms of reference, and the numbers of `as_product` say so, not how it ranks.

Nothing touches the application's data: the bridge ranks in a temporary database it drops (`rank`), the resumes go
through `docparse` and the product's extraction (`extract`).
"""

import base64
import json
import random
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path, PurePath
from typing import Any

from fsp_eval.selection import SUITABLE, K, bm25_order, ndcg, paired_delta, precision_at, reciprocal_rank

LANES = ("as_product", "resume_only")
SHOWN = "as_product_shown"
# The group «грейд не подтверждён» of the product's lane, explained by the bridge apart from the shortlist.
GROUP = "grade_not_confirmed"
BASELINE = "keywords_same_text"
# Ranked lists of the run; the product's shown order is the shortlist and its group, put together by the metrics.
RANKED = (*LANES, BASELINE)
COMPARED = ("as_product", SHOWN, "resume_only")
SYSTEMS = (*COMPARED, BASELINE)
LANE_TITLES = {
    "as_product": "как в продукте, подборка: только кандидаты с категорией подборки из подтверждённого теста",
    SHOWN: (
        "как в продукте, всё показанное работодателю: подборка, затем группа «грейд не подтверждён» —"
        " её кандидаты тестом не подтверждены"
    ),
    "resume_only": "эксперимент без теста: категория из подсказки грейда по резюме, не подтверждена",
    "keywords_same_text": "поиск по тому же тексту потребности (BM25) среди тех же кандидатов",
}
GROUP_TITLE = (
    "грейд не подтверждён: категории подборки нет, грейд последнего теста по её специальности или заявленный без теста"
    " называет её категорию; продукт показывает группу после подборки"
)
NOT_SHOWN_TITLES = {
    "no_test": "нет решений теста и заявленной категории подборки: без теста нет категории, продукт их не показывает",
    "category_elsewhere": "категория из теста есть, но не из категорий подборки",
    "not_confirmed_elsewhere": "категории нет, последний тест — не на категорию подборки",
}
MEASURES = {
    "precision_at_10": "доля подходящих (метка 2–3) среди первых десяти позиций, знаменатель всегда 10",
    "ndcg_at_10": "nDCG@10 по меткам 0–3 (выигрыш 2^метка − 1), идеальный порядок — по всем кандидатам потребности",
    "mrr": "1 / позиция первого подходящего во всём порядке, 0 — если его нет",
    "judged_at_10": "доля размеченных среди первых десяти; неразмеченная карточка считается неподходящей",
}
RESUME_EXTENSIONS = frozenset({".pdf", ".docx", ".odt", ".txt"})
SAFE = re.compile(r"[^0-9A-Za-z_.-]")


class JuryError(Exception):
    pass


@dataclass(frozen=True)
class Candidate:
    candidate_id: str
    file_name: str
    content: bytes
    test_results: list[dict[str, Any]]
    # Grades declared in the survey of a specialization without its test: `{specialization, grade}`.
    declared: list[dict[str, str]]
    fsp: dict[str, Any] | None
    preferences: dict[str, Any] | None
    label: int | None


@dataclass(frozen=True)
class Need:
    need_id: str
    text: str
    candidates: tuple[Candidate, ...]


def _require(condition: bool, line: int, message: str) -> None:
    if not condition:
        raise JuryError(f"line {line}: {message}")


def _candidate(line: int, raw: Any, index: int) -> Candidate:
    where = f"candidates[{index}]"
    _require(isinstance(raw, dict), line, f"{where} must be an object")
    known = {"candidate_id", "resume_text", "resume_file", "test_results", "declared", "fsp", "preferences", "label"}
    extra = sorted(set(raw) - known)
    _require(not extra, line, f"{where} has unknown fields {', '.join(extra)}")
    candidate_id = raw.get("candidate_id")
    _require(isinstance(candidate_id, str) and candidate_id != "", line, f"{where}.candidate_id must be a string")
    text, file = raw.get("resume_text"), raw.get("resume_file")
    _require((text is None) != (file is None), line, f"{where} needs exactly one of resume_text and resume_file")
    if text is not None:
        _require(isinstance(text, str) and text.strip() != "", line, f"{where}.resume_text must be a non-empty string")
        name, content = "resume.txt", text.encode("utf-8")
    else:
        _require(
            isinstance(file, dict) and isinstance(file.get("name"), str) and isinstance(file.get("base64"), str),
            line,
            f"{where}.resume_file must be {{name, base64}}",
        )
        name = PurePath(file["name"]).name
        _require(
            PurePath(name).suffix.lower() in RESUME_EXTENSIONS,
            line,
            f"{where}.resume_file must be one of {', '.join(sorted(RESUME_EXTENSIONS))}",
        )
        try:
            content = base64.b64decode(file["base64"], validate=True)
        except ValueError as error:
            raise JuryError(f"line {line}: {where}.resume_file.base64 is not base64") from error
    results = raw.get("test_results", [])
    _require(isinstance(results, list), line, f"{where}.test_results must be a list")
    for result in results:
        _require(isinstance(result, dict), line, f"{where}.test_results must hold objects")
    declared = raw.get("declared", [])
    _require(isinstance(declared, list), line, f"{where}.declared must be a list")
    tested = {result.get("specialization") for result in results}
    seen: set[str] = set()
    for declaration in declared:
        _require(
            isinstance(declaration, dict)
            and set(declaration) == {"specialization", "grade"}
            and all(isinstance(value, str) for value in declaration.values()),
            line,
            f"{where}.declared must hold {{specialization, grade}}",
        )
        specialization = declaration["specialization"]
        _require(specialization not in seen, line, f"{where}.declared names {specialization} twice")
        _require(
            specialization not in tested,
            line,
            f"{where}.declared names {specialization} of a test: its declaration is the test's own",
        )
        seen.add(specialization)
    label = raw.get("label")
    _require(label is None or label in (0, 1, 2, 3), line, f"{where}.label must be 0–3")
    fsp, preferences = raw.get("fsp"), raw.get("preferences")
    _require(fsp is None or isinstance(fsp, dict), line, f"{where}.fsp must be a page of fsp-achievements/v1")
    _require(preferences is None or isinstance(preferences, dict), line, f"{where}.preferences must be an object")
    return Candidate(candidate_id, name, content, results, declared, fsp, preferences, label)


def read_needs(path: Path) -> list[Need]:
    """The needs of the file, each line checked: the bridge checks the test results, the FSP page and the preferences
    against the product's own schemas."""
    needs: list[Need] = []
    for number, text in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not text.strip():
            continue
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as error:
            raise JuryError(f"line {number}: not JSON: {error}") from error
        _require(isinstance(raw, dict), number, "a need must be an object")
        extra = sorted(set(raw) - {"need_id", "need", "candidates"})
        _require(not extra, number, f"unknown fields {', '.join(extra)}")
        need_id = raw.get("need_id")
        _require(isinstance(need_id, str) and need_id != "", number, "need_id must be a string")
        need = raw.get("need")
        _require(
            isinstance(need, dict) and isinstance(need.get("text"), str) and need["text"].strip() != "",
            number,
            "need must be {text}",
        )
        _require(len(need["text"]) <= 5000, number, "need.text is longer than 5000 characters")
        raw_candidates = raw.get("candidates")
        _require(isinstance(raw_candidates, list) and raw_candidates, number, "candidates must be a non-empty list")
        candidates = tuple(_candidate(number, c, i) for i, c in enumerate(raw_candidates))
        ids = [c.candidate_id for c in candidates]
        _require(len(set(ids)) == len(ids), number, "candidate ids repeat within the need")
        needs.append(Need(need_id, need["text"], candidates))
    if not needs:
        raise JuryError(f"{path} holds no need")
    if len({n.need_id for n in needs}) != len(needs):
        raise JuryError("need ids repeat")
    return needs


def _key(need_index: int, candidate_index: int) -> str:
    return f"n{need_index}c{candidate_index}"


def jury_run(
    bridge: Any, needs: Sequence[Need], out: Path, *, mode: str, concurrency: int, as_of: date, seed: int
) -> dict[str, Any]:
    """The two lanes and the search by the same text for every need; `results.json` and `judging.jsonl` in a new run
    directory under `out/jury/`, and `metrics.json` when the input carries labels."""
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    directory = out / "jury" / stamp
    files = directory / "resumes"
    files.mkdir(parents=True)
    keys: dict[str, tuple[Need, Candidate]] = {}
    documents = []
    for i, need in enumerate(needs):
        for j, candidate in enumerate(need.candidates):
            key = _key(i, j)
            keys[key] = (need, candidate)
            path = files / f"{key}{PurePath(candidate.file_name).suffix.lower()}"
            path.write_bytes(candidate.content)
            documents.append({"id": key, "path": str(path), "declared_name": SAFE.sub("_", candidate.file_name)})
    info = bridge.call({"command": "info"})
    extracted = bridge.call(
        {
            "command": "extract",
            "mode": mode,
            "as_of": as_of.isoformat(),
            "concurrency": concurrency,
            "documents": documents,
        }
    )["documents"]
    by_key = {document["id"]: document for document in extracted}
    candidates = []
    for key, (_, candidate) in keys.items():
        document = by_key[key]
        resume = (
            {"evidence": document["evidence"], "mode": document["mode"], "producer": document["producer"]}
            if document["ok"]
            else None
        )
        for lane in LANES:
            entry: dict[str, Any] = {
                "id": f"{key}/{lane}",
                "resume": resume,
                "fsp": candidate.fsp,
                "test_results": candidate.test_results if lane == "as_product" else [],
                "declared": candidate.declared if lane == "as_product" else [],
            }
            if candidate.preferences is not None:
                entry["preferences"] = candidate.preferences
            candidates.append(entry)
    need_keys = {f"n{i}": need for i, need in enumerate(needs)}
    members = {nk: [_key(i, j) for j in range(len(need.candidates))] for i, (nk, need) in enumerate(need_keys.items())}
    answer = bridge.call(
        {
            "command": "rank",
            "as_of": as_of.isoformat(),
            "open_specializations": sorted(s["key"] for s in info["specializations"] if s["open"]),
            "candidates": candidates,
            "needs": [{"id": nk, "text": need.text} for nk, need in need_keys.items()],
            "rankings": [
                {
                    "name": lane,
                    "candidates": [f"{key}/{lane}" for key in keys],
                    "semantic": False,
                    "admission": "categories" if lane == "as_product" else "grade_hint",
                    "per_need": {nk: [f"{key}/{lane}" for key in people] for nk, people in members.items()},
                }
                for lane in LANES
            ],
        }
    )
    rng = random.Random(f"{seed}:judging")
    held = {
        cid.split("/", 1)[0]: categories for cid, categories in answer["categories"].items() if "/as_product" in cid
    }
    results, sheet = [], []
    for nk, need in need_keys.items():
        result, orders = _need_result(
            need, nk, people=members[nk], keys=keys, by_key=by_key, answer=answer, held=held, seed=seed
        )
        results.append(result)
        name = {key: keys[key][1].candidate_id for key in members[nk]}
        pool = sorted({name[key] for order in orders for key in order[:K]})
        rng.shuffle(pool)
        sheet.extend({"need_id": need.need_id, "candidate_id": cid, "label": None} for cid in pool)
    run = {
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "product_revision": info["product_revision"],
        "versions": {**info["versions"], **answer["models"]},
        "mode": mode,
        "as_of": as_of.isoformat(),
        "inputs": _run_inputs(results),
        "warnings": _warnings(results),
        "needs": results,
    }
    (directory / "results.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
    (directory / "judging.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in sheet), encoding="utf-8"
    )
    run["directory"] = str(directory)
    labels = {
        (need.need_id, candidate.candidate_id): candidate.label
        for need in needs
        for candidate in need.candidates
        if candidate.label is not None
    }
    if labels:
        metrics = jury_metrics(run, labels, seed=seed)
        (directory / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=1), encoding="utf-8")
        run["metrics"] = metrics
    return run


def _need_result(
    need: Need,
    nk: str,
    *,
    people: Sequence[str],
    keys: Mapping[str, tuple[Need, Candidate]],
    by_key: Mapping[str, Mapping[str, Any]],
    answer: Mapping[str, Any],
    held: Mapping[str, Sequence[Any]],
    seed: int,
) -> tuple[dict[str, Any], list[list[str]]]:
    """One need of a run: what the product read, what its input confirms, every lane — the product's with the group
    «грейд не подтверждён» after its shortlist and who it shows in neither — and the orders the blind sheet unites."""
    name = {key: keys[key][1].candidate_id for key in people}
    texts = {key: by_key[key]["text"] if by_key[key]["ok"] else None for key in people}
    orders = {lane: [cid.split("/", 1)[0] for cid in answer["rankings"][lane][nk]] for lane in LANES}
    orders[BASELINE] = bm25_order(need.text, texts, seed, nk)
    top = {lane: {e["id"].split("/", 1)[0]: e for e in answer["top"][lane][nk]} for lane in LANES}
    top[GROUP] = {e["id"].split("/", 1)[0]: e for e in answer["declared_top"]["as_product"][nk]}
    shortlist = orders["as_product"]
    group = [cid.split("/", 1)[0] for cid in answer["declared"]["as_product"][nk]]
    read = answer["needs"][nk]

    def ranked(order: Sequence[str], explained: Mapping[str, Any], start: int) -> list[dict[str, Any]]:
        return [
            {"candidate_id": name[key], "position": start + position + 1}
            | (_explained(explained[key]) if key in explained else {})
            for position, key in enumerate(order)
        ]

    lanes: dict[str, Any] = {
        system: {"title": LANE_TITLES[system], "ranked": ranked(order, top.get(system, {}), 0)}
        for system, order in orders.items()
    }
    lanes["as_product"][GROUP] = {
        "title": GROUP_TITLE,
        "ranked": [
            entry | {"declared": _declared(keys[key][1], read["categories"])}
            for key, entry in zip(group, ranked(group, top[GROUP], len(shortlist)), strict=True)
        ],
    }
    lanes["as_product"]["not_shown"] = _not_shown(
        [key for key in people if key not in {*shortlist, *group}], keys, held, name
    )
    lanes["resume_only"]["not_admitted_by_grade_hint"] = sorted(
        name[key] for key in people if key not in set(orders["resume_only"])
    )
    inputs = _inputs(need, [by_key[key]["ok"] for key in people], [bool(held.get(key)) for key in people])
    result = {
        "need_id": need.need_id,
        "read": read,
        "inputs": inputs | {"shortlist": len(shortlist), "grade_not_confirmed": len(group)},
        "lanes": lanes,
        "unparsed": sorted(name[key] for key in people if not by_key[key]["ok"]),
    }
    return result, [*orders.values(), [*shortlist, *group]]


def _declared(candidate: Candidate, categories: Sequence[str]) -> dict[str, str] | None:
    """The category the candidate declared in a specialization of the shortlist — the one their last test there was
    taken on, or one declared without a test (`outcome` `not_tested`): what the group «грейд не подтверждён» shows of
    them."""
    specializations = {category.split(":", 1)[0] for category in categories}
    last = [result for result in candidate.test_results if result.get("specialization") in specializations]
    if last:
        return {
            "specialization": last[-1]["specialization"],
            "grade": last[-1]["grade"],
            "outcome": last[-1]["outcome"],
        }
    untested = [d for d in candidate.declared if f"{d['specialization']}:{d['grade']}" in categories]
    if not untested:
        return None
    return {"specialization": untested[0]["specialization"], "grade": untested[0]["grade"], "outcome": "not_tested"}


def _not_shown(
    keys_apart: Sequence[str],
    keys: Mapping[str, tuple[Need, Candidate]],
    held: Mapping[str, Sequence[Any]],
    name: Mapping[str, str],
) -> dict[str, Any]:
    """Who the product shows in neither group, by reason: no test at all; a category, but not of the shortlist; no
    category, the last test not on a category of the shortlist."""
    apart: dict[str, list[str]] = {reason: [] for reason in NOT_SHOWN_TITLES}
    for key in keys_apart:
        if not keys[key][1].test_results:
            apart["no_test"].append(name[key])
        elif held.get(key):
            apart["category_elsewhere"].append(name[key])
        else:
            apart["not_confirmed_elsewhere"].append(name[key])
    return {"titles": NOT_SHOWN_TITLES, **{reason: sorted(ids) for reason, ids in apart.items()}}


def _inputs(need: Need, parsed: Sequence[bool], categorized: Sequence[bool]) -> dict[str, int]:
    """What the input of a need confirms: candidates, resumes read, candidates with test results, with a grade declared
    without a test, with a category in force after the tests, labelled by the jury."""
    return {
        "candidates": len(need.candidates),
        "parsed": sum(parsed),
        "with_test_results": sum(bool(c.test_results) for c in need.candidates),
        "declared_without_test": sum(bool(c.declared) for c in need.candidates),
        "with_category": sum(categorized),
        "labelled": sum(c.label is not None for c in need.candidates),
    }


def _run_inputs(results: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    keys = (
        "candidates",
        "parsed",
        "with_test_results",
        "declared_without_test",
        "with_category",
        "labelled",
        "shortlist",
        "grade_not_confirmed",
    )
    totals = {key: sum(need["inputs"][key] for need in results) for key in keys}
    return {
        "needs": len(results),
        **totals,
        "needs_without_categories": sum(not n["read"]["categories"] for n in results),
    }


def _warnings(results: Sequence[Mapping[str, Any]]) -> list[str]:
    """What the numbers of a run do not say, in words: the jury reads them next to the metrics."""
    warnings = []
    declared = any(need["inputs"]["declared_without_test"] for need in results)
    if not any(need["inputs"]["with_test_results"] for need in results) and not declared:
        warnings.append(
            "Во входе нет ни одного решения теста (test_results) и заявленного грейда (declared): категорию продукт"
            " даёт только подтверждённым тестом, поэтому подборка «как в продукте» и группа «грейд не подтверждён»"
            " пусты у каждой потребности, и метрики as_product и as_product_shown — нули входа, а не ранжирования."
            " Чтение тех же резюме без теста показывает только эксперимент resume_only."
        )
    elif not any(need["inputs"]["with_test_results"] for need in results):
        warnings.append(
            "Во входе нет ни одного решения теста (test_results): подборка «как в продукте» пуста у каждой потребности,"
            " метрики as_product — нули входа; as_product_shown — только группа «грейд не подтверждён» из заявивших"
            " грейд без теста (declared), их грейд тестом не подтверждён."
        )
    elif not any(need["inputs"]["with_category"] for need in results):
        warnings.append(
            "Во входе есть решения тестов, но ни одно не подтвердило категорию: подборка пуста, показана только группа"
            " «грейд не подтверждён»."
        )
    unread = [need["need_id"] for need in results if not need["read"]["categories"]]
    if unread:
        warnings.append(
            "Потребности без категорий подборки (роль без выпущенного теста или не прочитана): "
            + ", ".join(unread)
            + " — продукт не показывает по ним ни одного кандидата."
        )
    return warnings


def _explained(entry: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "score": entry["score"],
        "components": entry["components"],
        "reasons": entry["reasons"],
        "gaps": entry["gaps"],
        "to_verify": entry["to_verify"],
    }


def read_labels(path: Path) -> dict[tuple[str, str], int]:
    labels: dict[tuple[str, str], int] = {}
    for number, text in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not text.strip():
            continue
        row = json.loads(text)
        _require(isinstance(row, dict), number, "a label must be an object")
        label = row.get("label")
        if label is None:
            continue
        _require(label in (0, 1, 2, 3), number, "label must be 0–3 or null")
        key = (row.get("need_id"), row.get("candidate_id"))
        _require(all(isinstance(part, str) for part in key), number, "need_id and candidate_id must be strings")
        _require(key not in labels, number, f"{key} is labelled twice")
        labels[key] = label
    return labels


def jury_metrics(run: Mapping[str, Any], labels: Mapping[tuple[str, str], int], *, seed: int) -> dict[str, Any]:
    """Every system against the jury's labels: the product's shortlist, all the product shows (the shortlist, then the
    group «грейд не подтверждён»), the lane without a test and the search by the same text. An unlabelled card is not
    suitable; a need without a suitable candidate by the labels is not rated."""
    values: dict[str, dict[str, list[float]]] = {
        s: {"ndcg_at_10": [], "precision_at_10": [], "mrr": []} for s in SYSTEMS
    }
    judged: dict[str, list[float]] = {s: [] for s in SYSTEMS}
    unknown = {key for key in labels if key[0] not in {n["need_id"] for n in run["needs"]}}
    if unknown:
        raise JuryError(f"labels of needs the run has not: {sorted(unknown)[:5]}")
    rated = 0
    for need in run["needs"]:
        need_id = need["need_id"]
        lanes = need["lanes"]
        orders = {s: [row["candidate_id"] for row in lanes[s]["ranked"]] for s in RANKED}
        group = [row["candidate_id"] for row in lanes["as_product"][GROUP]["ranked"]]
        orders[SHOWN] = [*orders["as_product"], *group]
        # Every candidate a system orders (unlabelled — not suitable) and every labelled one, shown or not: the ideal
        # order is over all of them.
        rels = {cid: 0 for order in orders.values() for cid in order} | {
            cid: label for (nid, cid), label in labels.items() if nid == need_id
        }
        for system, order in orders.items():
            if order[:K]:
                judged[system].append(sum((need_id, cid) in labels for cid in order[:K]) / len(order[:K]))
        if not any(rel >= SUITABLE for rel in rels.values()):
            continue
        rated += 1
        for system, order in orders.items():
            values[system]["ndcg_at_10"].append(ndcg(order, rels))
            values[system]["precision_at_10"].append(precision_at(order, rels))
            values[system]["mrr"].append(reciprocal_rank(order, rels))

    def mean(series: Sequence[float]) -> float | None:
        return round(sum(series) / len(series), 4) if series else None

    return {
        "needs": len(run["needs"]),
        "rated_needs": rated,
        "labels": len(labels),
        "inputs": run["inputs"],
        "warnings": run["warnings"],
        "measures": MEASURES,
        "systems": {
            system: {
                "title": LANE_TITLES[system],
                **{measure: mean(series) for measure, series in values[system].items()},
                "judged_at_10": mean(judged[system]),
            }
            for system in SYSTEMS
        },
        "deltas": {
            f"{system}_minus_keywords_same_text": {
                measure: paired_delta(seed, values[system][measure], values[BASELINE][measure])
                for measure in values[system]
            }
            for system in COMPARED
            if rated
        },
    }
