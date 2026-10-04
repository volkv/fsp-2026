"""Matching of the synthetic people with vacancies: a layer over a resume dataset and its FSP achievements for
`matching.ndcg_at_10` — the product's ranking of candidates for a vacancy against a relevance the harness decides.

The layer decides the truth before anything is ranked, by its own rubric, never from the product:

- the skills a person really has. A skill used at work (an achievement line, a job title) is real. A skill only listed
  in the skills section is real with probability 0.7: a listed skill nobody used is often a word, not a skill. A skill
  of the person's role written nowhere is real with probability 0.15: people omit what they know. A skill the person
  plans to learn is not real. Algorithms are real for a person with an official algorithmic result at FSP level L2 or
  above, with probability 0.5 at L1 and 0.1 without a record: the model of the world in which the product's premise —
  a competition result tells a real skill — holds, and the only place the FSP layer enters the truth;
- the person's grade — the generator's; a student without experience is an intern;
- platform tests: half of the people take one or two tests of the bank in skills they claim or have; a test is passed at
  the person's level with probability 0.9 when the skill is real and at the junior level with probability 0.05 when it
  is not. Only a passed test reaches the product, as the platform records it.

Vacancies are drawn from the roles and stacks of the lexicon: the stack's language and two more of its skills required,
two nice to have, a grade range of one or two grades; some engineering vacancies also require algorithms. Relevance of
a person for a vacancy, 0–3: no relevance below half of the required skills really held; otherwise 1, plus 1 when every
required skill is held, plus 1 when the grade is inside the range; a person of another role is at most 1.
"""

import hashlib
import json
import math
import random
import re
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from fsp_eval.dataset import DATASETS_DIR, Dataset, DatasetError
from fsp_eval.families import Split
from fsp_eval.fsp import FspRecord
from fsp_eval.lexicon import GRADES, LEVEL_WORDS, ROLES, SKILL_SURFACES, RoleSpec
from fsp_eval.metrics import MetricTable
from fsp_eval.profiles import Profile

GENERATOR_VERSION = 1

LISTED_REAL = 0.7
OMITTED_REAL = 0.15
ALGORITHMS_REAL = {"strong": 1.0, "participant": 0.5, "none": 0.1}
TEST_TAKERS = 0.5
TEST_PASS = {"real": 0.9, "not_real": 0.05}
ALGORITHMIC_ROLES = frozenset({"backend", "data_engineer", "data_scientist", "ml_engineer"})
ALGORITHMIC_SHARE = 0.3

# Assessments of the bank by skill: the quiz sets the level itself; a code task confirms one level.
QUIZZES: dict[str, str] = {
    "python": "quiz-python",
    "go": "quiz-go",
    "javascript": "quiz-javascript",
    "sql": "quiz-sql",
}
CODE_TASKS: dict[str, dict[str, str]] = {"java": {"junior": "java-grade-report", "middle": "java-lru-cache"}}
TESTABLE: frozenset[str] = frozenset(QUIZZES) | frozenset(CODE_TASKS)
# Level of a test a person of the grade reaches.
TEST_LEVEL: dict[str, str] = {
    "intern": "junior",
    "junior": "junior",
    "middle": "middle",
    "senior": "senior",
    "lead": "senior",
}
# How a vacancy writes a skill the resumes never write.
VACANCY_NAMES: dict[str, str] = {"algorithms": "Алгоритмы и структуры данных"}

K = 10


@dataclass(frozen=True)
class Vacancy:
    id: str
    split: Split
    role: str
    grade_min: str
    grade_max: str
    required: tuple[str, ...]
    nice: tuple[str, ...]
    title: str
    description: str
    algorithmic: bool


@dataclass(frozen=True)
class Truth:
    profile_id: str
    # `None` — a student with no role yet.
    role: str | None
    grade: str
    skills: tuple[str, ...]


@dataclass(frozen=True)
class TestResult:
    skill: str
    assessment: str
    level: str


@dataclass(frozen=True)
class World:
    vacancies: tuple[Vacancy, ...]
    truths: dict[str, Truth]
    tests: dict[str, tuple[TestResult, ...]]

    def vacancies_of(self, split: Split) -> tuple[Vacancy, ...]:
        return tuple(vacancy for vacancy in self.vacancies if vacancy.split == split)


@dataclass(frozen=True)
class MatchingLayer:
    id: str
    provenance: str
    generator: int
    seed: int
    base_dataset: str
    fsp_layer: str
    vacancies: dict[str, int]
    labels_sha256: str


# --- Truth ------------------------------------------------------------------------------------------------------------


def _role_spec(key: str) -> RoleSpec:
    return next(role for role in ROLES if role.key == key)


def _algorithms_class(record: FspRecord | None) -> str:
    if record is None:
        return "none"
    level = dict(record.gold.levels).get("algorithmic")
    if level is None:
        return "none"
    return "participant" if level == "L1" else "strong"


def truth_of(seed: int, profile: Profile, record: FspRecord | None) -> Truth:
    rng = random.Random(f"{seed}:truth:{profile.id}")
    used = {m.key for job in profile.jobs for line in job.lines for m in line.mentions}
    used |= {key for job in profile.jobs for key in job.title_skills}
    listed = {m.key for m in profile.skills} - used
    negated = {m.key for m in profile.negated}
    real = set(used)
    real |= {key for key in sorted(listed) if rng.random() < LISTED_REAL}
    role_skills = {key for stack in _role_spec(profile.role).stacks for key in stack.skills}
    omitted = sorted(role_skills - used - listed - negated)
    real |= {key for key in omitted if rng.random() < OMITTED_REAL}
    if rng.random() < ALGORITHMS_REAL[_algorithms_class(record)]:
        real.add("algorithms")
    student = profile.kind == "skills_only"
    return Truth(
        profile_id=profile.id,
        role=None if student else profile.role,
        grade="intern" if student else profile.grade,
        skills=tuple(sorted(real)),
    )


def tests_of(seed: int, profile: Profile, truth: Truth) -> tuple[TestResult, ...]:
    """Passed tests of the person; a failed attempt gives the product no evidence and is not listed."""
    rng = random.Random(f"{seed}:tests:{profile.id}")
    if rng.random() >= TEST_TAKERS:
        return ()
    claimed = {m.key for m in profile.skills} | {
        m.key for job in profile.jobs for line in job.lines for m in line.mentions
    }
    options = sorted((claimed | set(truth.skills)) & TESTABLE)
    if not options:
        return ()
    rng.shuffle(options)
    results = []
    for skill in options[: rng.randint(1, 2)]:
        real = skill in truth.skills
        if rng.random() >= TEST_PASS["real" if real else "not_real"]:
            continue
        level = TEST_LEVEL[truth.grade] if real else "junior"
        if skill in QUIZZES:
            results.append(TestResult(skill, QUIZZES[skill], level))
        else:
            tasks = CODE_TASKS[skill]
            task_level = level if level in tasks else max(tasks, key=GRADES.index)
            results.append(TestResult(skill, tasks[task_level], task_level))
    return tuple(results)


# --- Vacancies --------------------------------------------------------------------------------------------------------


def vacancy_name(key: str) -> str:
    return VACANCY_NAMES.get(key) or SKILL_SURFACES[key][0]


def _vacancy(seed: int, split: Split, index: int) -> Vacancy:
    rng = random.Random(f"{seed}:vacancy:{split}:{index}")
    role = rng.choice(ROLES)
    stack = rng.choice(role.stacks)
    primary, *rest = stack.skills
    pool = [key for key in rest if key != "git"]
    rng.shuffle(pool)
    required = [primary, *pool[:2]]
    others = sorted({key for s in role.stacks for key in s.skills} - set(required) - {"git"})
    rng.shuffle(others)
    nice = others[:2]
    algorithmic = role.key in ALGORITHMIC_ROLES and rng.random() < ALGORITHMIC_SHARE
    if algorithmic:
        required.append("algorithms")
    low = rng.randint(GRADES.index("junior"), GRADES.index("lead"))
    high = min(low + rng.randint(0, 1), GRADES.index("lead"))
    grade_min, grade_max = GRADES[low], GRADES[high]
    level = next(word for word in LEVEL_WORDS[grade_min][0] if word)
    title = f"{level} {stack.titles_ru[0].text}"
    description = (
        f"Требования: {', '.join(vacancy_name(key) for key in required)}. "
        f"Будет плюсом: {', '.join(vacancy_name(key) for key in nice)}."
    )
    return Vacancy(
        id=f"{split[0]}v{index:03d}",
        split=split,
        role=role.key,
        grade_min=grade_min,
        grade_max=grade_max,
        required=tuple(required),
        nice=tuple(nice),
        title=title,
        description=description,
        algorithmic=algorithmic,
    )


def build_world(seed: int, dataset: Dataset, records: Mapping[str, FspRecord], vacancies: Mapping[str, int]) -> World:
    truths = {p.id: truth_of(seed, p, records.get(p.id)) for p in dataset.profiles}
    return World(
        vacancies=tuple(
            _vacancy(seed, split, i) for split in ("dev", "holdout") for i in range(1, vacancies[split] + 1)
        ),
        truths=truths,
        tests={p.id: tests_of(seed, p, truths[p.id]) for p in dataset.profiles},
    )


def world_digest(world: World) -> str:
    content = {
        "vacancies": [asdict(v) for v in world.vacancies],
        "truths": [asdict(t) for _, t in sorted(world.truths.items())],
        "tests": {pid: [asdict(t) for t in tests] for pid, tests in sorted(world.tests.items())},
    }
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def new_matching_manifest(
    layer_id: str,
    seed: int,
    dataset: Dataset,
    *,
    fsp_layer: str,
    records: Mapping[str, FspRecord],
    vacancies: int,
) -> dict[str, object]:
    counts = {"dev": vacancies, "holdout": vacancies}
    return {
        "id": layer_id,
        "provenance": "synthetic",
        "generator": GENERATOR_VERSION,
        "seed": seed,
        "base_dataset": dataset.manifest.id,
        "fsp_layer": fsp_layer,
        "vacancies": counts,
        "labels_sha256": world_digest(build_world(seed, dataset, records, counts)),
    }


def load_matching(layer_id: str, directory: Path = DATASETS_DIR) -> MatchingLayer:
    path = directory / layer_id / "manifest.json"
    if not path.is_file():
        raise DatasetError(f"no manifest {path}")
    return MatchingLayer(**json.loads(path.read_text(encoding="utf-8")))


def build_matching(
    layer: MatchingLayer, dataset: Dataset, fsp_layer: str | None, records: Mapping[str, FspRecord]
) -> World:
    if layer.base_dataset != dataset.manifest.id:
        raise DatasetError(f"{layer.id} is a layer over {layer.base_dataset}, not over {dataset.manifest.id}")
    if layer.fsp_layer != fsp_layer:
        raise DatasetError(f"{layer.id} is built with the FSP layer {layer.fsp_layer}, the run has {fsp_layer}")
    if layer.generator != GENERATOR_VERSION:
        raise DatasetError(f"{layer.id} was made by generator {layer.generator}, this is generator {GENERATOR_VERSION}")
    world = build_world(layer.seed, dataset, records, layer.vacancies)
    digest = world_digest(world)
    if digest != layer.labels_sha256:
        raise DatasetError(
            f"{layer.id}: the generator no longer reproduces the labels of the manifest "
            f"({digest[:12]} ≠ {layer.labels_sha256[:12]}); a changed generator needs a new layer id"
        )
    return world


# --- Relevance and nDCG -----------------------------------------------------------------------------------------------


def relevance(vacancy: Vacancy, truth: Truth, *, role_matters: bool = True) -> int:
    """The rubric's relevance, 0–3. `role_matters=False` — the same without the cap for another role: a reading of
    the rubric that asks only for skills and grade, reported next to the main one."""
    held = set(truth.skills)
    covered = sum(key in held for key in vacancy.required) / len(vacancy.required)
    if covered < 0.5:
        return 0
    order = {grade: index for index, grade in enumerate(GRADES)}
    in_range = order[vacancy.grade_min] <= order[truth.grade] <= order[vacancy.grade_max]
    points = 1 + (covered == 1) + in_range
    return points if not role_matters or truth.role == vacancy.role else min(points, 1)


def _gain(rel: int) -> float:
    return 2.0**rel - 1


def _discount(position: int) -> float:
    return 1 / math.log2(position + 2)


def _ideal(rels: Mapping[str, int], k: int) -> float:
    ordered = sorted(rels.values(), reverse=True)[:k]
    return sum(_gain(rel) * _discount(i) for i, rel in enumerate(ordered))


def ndcg(order: Sequence[str], rels: Mapping[str, int], k: int = K) -> float:
    """nDCG@k of an order of the whole pool; the caller skips a vacancy without a relevant person."""
    if sorted(order) != sorted(rels):
        raise ValueError("the ranking does not hold the pool exactly")
    dcg = sum(_gain(rels[pid]) * _discount(i) for i, pid in enumerate(order[:k]))
    return dcg / _ideal(rels, k)


def random_ndcg(rels: Mapping[str, int], k: int = K) -> float:
    """Expected nDCG@k of a uniformly random order: every position holds the mean gain of the pool."""
    mean = sum(_gain(rel) for rel in rels.values()) / len(rels)
    return mean * sum(_discount(i) for i in range(min(k, len(rels)))) / _ideal(rels, k)


def _tie_break(seed: int, vacancy_id: str, profile_id: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{seed}:tie:{vacancy_id}:{profile_id}".encode()).digest()[:8], "big")


def keyword_order(vacancy: Vacancy, texts: Mapping[str, str | None], seed: int) -> list[str]:
    """The baseline a recruiter's search gives: the names the vacancy prints searched as whole words in the parsed
    resume text, a required name worth two, a nice one worth one; ties in a fixed pseudo-random order."""

    def pattern(key: str) -> re.Pattern[str]:
        return re.compile(rf"(?<![\w+#.]){re.escape(vacancy_name(key))}(?![\w+#])", re.IGNORECASE)

    weights = [(pattern(key), 2) for key in vacancy.required] + [(pattern(key), 1) for key in vacancy.nice]

    def score(text: str | None) -> int:
        return 0 if text is None else sum(weight for p, weight in weights if p.search(text))

    return sorted(texts, key=lambda pid: (-score(texts[pid]), _tie_break(seed, vacancy.id, pid)))


# --- Metrics ----------------------------------------------------------------------------------------------------------

# Product variants of the ranking: which evidence the candidates carry and whether the reranker and the semantic
# similarity are on. A run without an embedder has no semantic similarity in any variant and no `without_semantic`.
VARIANTS: dict[str, dict[str, bool]] = {
    "full": {"fsp": True, "tests": True, "reranker": True, "semantic": True},
    "without_fsp": {"fsp": False, "tests": True, "reranker": True, "semantic": True},
    "without_tests": {"fsp": True, "tests": False, "reranker": True, "semantic": True},
    "resume_only": {"fsp": False, "tests": False, "reranker": True, "semantic": True},
    "without_reranker": {"fsp": True, "tests": True, "reranker": False, "semantic": True},
    "without_semantic": {"fsp": True, "tests": True, "reranker": True, "semantic": False},
}
# Variants a run computes only with the model the variant switches off.
NEEDS_MODEL: dict[str, str] = {"without_reranker": "reranker", "without_semantic": "semantic"}
BOOTSTRAP_SAMPLES = 2000


def _mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _paired_interval(seed: int, deltas: Sequence[float]) -> tuple[float, float]:
    """95 % percentile bootstrap interval of the mean of paired per-vacancy differences."""
    rng = random.Random(f"{seed}:bootstrap")
    means = sorted(
        sum(deltas[rng.randrange(len(deltas))] for _ in deltas) / len(deltas) for _ in range(BOOTSTRAP_SAMPLES)
    )
    return means[int(0.025 * BOOTSTRAP_SAMPLES)], means[int(0.975 * BOOTSTRAP_SAMPLES) - 1]


def matching_metrics(
    table: MetricTable,
    *,
    seed: int,
    vacancies: Sequence[Vacancy],
    truths: Mapping[str, Truth],
    pool: Sequence[str],
    texts: Mapping[str, str | None],
    rankings: Mapping[str, Mapping[str, Sequence[str]]],
    top: Mapping[str, Mapping[str, Sequence[Mapping[str, Any]]]],
    reranker_used: bool,
    semantic_used: bool,
) -> dict[str, Any]:
    """nDCG@10 of the product's ranking and of its variants over the same vacancies and the same pool, with the
    baselines, and the report part: per vacancy values and paired bootstrap intervals of the differences.

    - `matching.ndcg_at_10` — the product with everything the run has (resume, FSP, tests, the reranker and the
      semantic similarity when the run has them); baseline — the keyword search;
    - `.lift_over_keywords` — the lower bound of the 95 % paired bootstrap interval of «the product minus the keyword
      search»: above zero — the product is better than the search a recruiter has without it;
    - `.keywords` (baseline — random order), `.random` — the baselines;
    - `.resume_only` — the product on the resume alone; baseline — the keyword search;
    - `.without_fsp`, `.without_tests`, `.without_reranker`, `.without_semantic` — the product without one source;
      baseline — the full product, so the delta is what the source adds (negative — it helps). A run without the
      reranker or the embedder does not compute the variant without it.
    """
    used = {"reranker": reranker_used, "semantic": semantic_used}

    def scores(vacancy: Vacancy, rels: Mapping[str, int]) -> dict[str, float]:
        found = {"keywords": ndcg(keyword_order(vacancy, texts, seed), rels), "random": random_ndcg(rels)}
        for name in VARIANTS:
            if name not in NEEDS_MODEL or used[NEEDS_MODEL[name]]:
                found[name] = ndcg(rankings[name][vacancy.id], rels)
        return found

    rated = []
    for vacancy in vacancies:
        rels = {pid: relevance(vacancy, truths[pid]) for pid in pool}
        if any(rels.values()):
            rated.append((vacancy, rels))
    per_vacancy: dict[str, dict[str, Any]] = {}
    values: dict[str, list[float]] = {name: [] for name in ("keywords", "random", *VARIANTS)}
    # The same rankings against the rubric read without the role: what changes when only skills and grade count.
    role_agnostic: dict[str, list[float]] = {name: [] for name in values}
    for vacancy, rels in rated:
        found = scores(vacancy, rels)
        for name, value in found.items():
            values[name].append(value)
        agnostic = {pid: relevance(vacancy, truths[pid], role_matters=False) for pid in pool}
        for name, value in scores(vacancy, agnostic).items():
            role_agnostic[name].append(value)
        per_vacancy[vacancy.id] = {
            "relevant": {str(level): sum(r == level for r in rels.values()) for level in (1, 2, 3)},
            "algorithmic": vacancy.algorithmic,
            **found,
            "top10": _top10(vacancy, rels, top, keyword_order(vacancy, texts, seed)[:K]),
        }
    n = len(rated)
    mean = {name: _mean(series) for name, series in values.items()}
    deltas = _deltas(seed, values)
    table.put("matching.ndcg_at_10", mean["full"], n, mean["keywords"], with_baseline=True)
    lift = deltas.get("full_minus_keywords")
    table.put(
        "matching.ndcg_at_10.lift_over_keywords", None if lift is None else lift["ci95"][0], n, with_baseline=False
    )
    table.put("matching.ndcg_at_10.keywords", mean["keywords"], n, mean["random"], with_baseline=True)
    table.put("matching.ndcg_at_10.random", mean["random"], n, with_baseline=False)
    table.put("matching.ndcg_at_10.resume_only", mean["resume_only"], n, mean["keywords"], with_baseline=True)
    for name in ("without_fsp", "without_tests", "without_reranker", "without_semantic"):
        computed = bool(values[name])
        table.put(f"matching.ndcg_at_10.{name}", mean[name], n if computed else 0, mean["full"], with_baseline=True)
    by_kind = {
        kind: {
            name: _mean([row[name] for row in per_vacancy.values() if row["algorithmic"] == flag and name in row])
            for name in values
        }
        for kind, flag in (("algorithmic", True), ("other", False))
    }
    return {
        "vacancies": len(vacancies),
        "rated_vacancies": n,
        "pool": len(pool),
        "reranker_used": reranker_used,
        "semantic_used": semantic_used,
        "deltas": deltas,
        "role_agnostic": {name: _mean(series) for name, series in role_agnostic.items()},
        "by_kind": by_kind,
        "per_vacancy": per_vacancy,
    }


def _top10(
    vacancy: Vacancy,
    rels: Mapping[str, int],
    top: Mapping[str, Mapping[str, Sequence[Mapping[str, Any]]]],
    keywords: Sequence[str],
) -> dict[str, list[dict[str, Any]]]:
    """What each variant put first: the person, the relevance the rubric gives and the product's score by component."""
    first = {
        name: [
            {
                "profile_id": entry["id"].split("/", 1)[0],
                "relevance": rels[entry["id"].split("/", 1)[0]],
                "score": entry["score"],
                "components": entry["components"],
            }
            for entry in by_vacancy[vacancy.id]
        ]
        for name, by_vacancy in top.items()
    }
    first["keywords"] = [{"profile_id": pid, "relevance": rels[pid]} for pid in keywords]
    return first


def _deltas(seed: int, values: Mapping[str, Sequence[float]]) -> dict[str, dict[str, Any]]:
    """The full product minus each other variant, per vacancy, with a paired bootstrap interval."""
    deltas = {}
    for other in ("keywords", "random", "resume_only", *(name for name in VARIANTS if name.startswith("without_"))):
        if not values[other]:
            continue
        paired = [full - value for full, value in zip(values["full"], values[other], strict=True)]
        low, high = _paired_interval(seed, paired)
        deltas[f"full_minus_{other}"] = {"mean": sum(paired) / len(paired), "ci95": [low, high], "n": len(paired)}
    return deltas
