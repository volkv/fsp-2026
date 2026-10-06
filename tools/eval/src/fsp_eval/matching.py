"""The world of matching (generator 3): a layer over a resume dataset and its FSP achievements that decides, before
anything is ranked and never from the product, who each person really is, what they want, which tests they take, and
which hiring needs employers write. Methodology v3 of the evaluation reads it (selection.py, README «Методика v3»).

Truth of a person:

- the skills they really have. A skill used at work (an achievement line, a job title) is real. A skill only listed in
  the skills section is real with probability 0.7. A skill of the person's stack written nowhere is real with
  probability 0.15: people omit what they know. A skill the person plans to learn is not real. Algorithms are real for
  a person with an official algorithmic result at FSP level L2 or above, with probability 0.5 at L1 and 0.1 without a
  record — the one place the FSP layer enters the truth. Skills of a role's daily work its resumes rarely name (SQL and
  REST of a Django developer) are real by `IMPLICIT_REAL`, a table of the harness fixed with the generator;
- an inflated resume (`INFLATION`, levels fixed before any run): `skills` — 0.4 of the skills the resume claims, other
  than the stack's language, are not real; `skills_and_grade` — the same and the real grade is one below the grade the
  resume shows. An honest resume shows the real grade. A student without experience is an intern without a role;
- what the person wants (the survey's answers): work formats, the region of the city of the resume, relocation, and a
  salary expectation from the market of the real grade.

Tests: 0.65 of the people of a role with a tested specialization take the test of that specialization on the grade
their resume shows (a lead — on senior, the catalog has no lead); 0.7 of those not confirmed retake it one grade
lower. The outcome is decided when the catalog of the product is known (the bridge's `info`), by the harness's model
of an honest test: a defining block is passed only by a person who really holds every skill of it the world models
(a block naming none — by holding at least half of the stack), never by a person tested above their real grade; the
practice is passed with probability 0.85 by a person who holds one of its languages (a practice that is not a program
the person writes — QA cases a harness runs — needs no language and confirms none). A confirmation therefore never
claims a skill the world says the person lacks — except in the explicit scenario of false confirmations: 0.3 of the
people with no honest confirmation are confirmed on their first attempt anyway, ranked by a variant of their own and
never mixed into the main measurement.

Needs: written as employers write them — a title with the level and the role, required and nice skills, the format of
work with the city, the salary range; stratified by role (`NEEDS_PER_ROLE`, roles without a released test included)
and by the lowest grade of the range (every grade, intern and lead too); a quarter of the ranges are below the market.
"""

import hashlib
import json
import random
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from fsp_eval.dataset import DATASETS_DIR, Dataset, DatasetError
from fsp_eval.families import Split
from fsp_eval.fsp import FspRecord
from fsp_eval.lexicon import GRADES, LEVEL_WORDS, ROLES, SKILL_SURFACES, RoleSpec
from fsp_eval.profiles import Profile

GENERATOR_VERSION = 3

# --- The world's parameters, fixed with the generator -----------------------------------------------------------------

LISTED_REAL = 0.7
OMITTED_REAL = 0.15
ALGORITHMS_REAL = {"strong": 1.0, "participant": 0.5, "none": 0.1}
# Skills of a role's daily work its resumes rarely name, and how often a person of the role has one: a backend
# developer of any stack writes SQL and REST services, a Vue developer writes CSS through Sass, an automation tester has
# done manual testing. Only skills outside the person's stack: those of the stack follow the resume.
IMPLICIT_REAL: dict[str, dict[str, float]] = {
    "backend": {"sql": 0.8, "rest": 0.8, "microservices": 0.5},
    "fullstack": {"sql": 0.6, "rest": 0.8, "html": 0.9, "css": 0.9},
    "frontend": {"html": 0.9, "css": 0.9, "rest": 0.5},
    "qa_manual": {"test_automation": 0.2},
    "qa_automation": {"manual_testing": 0.7, "rest": 0.6, "sql": 0.5},
    "data_scientist": {"dl": 0.4},
    "ml_engineer": {"statistics": 0.7, "sql": 0.4},
    "data_engineer": {"docker": 0.5},
    "data_analyst": {},
    "devops": {},
    "mobile": {},
    "systems_analyst": {},
}
# Levels of the inflation of a resume and their shares.
INFLATION: dict[str, float] = {"honest": 0.7, "skills": 0.15, "skills_and_grade": 0.15}
INFLATED_DROP = 0.4

# What a person wants: sets of work formats and their weights, relocation, the salary expectation around the market of
# the real grade (roubles a month, net).
FORMAT_SETS: tuple[tuple[tuple[str, ...], int], ...] = (
    (("remote",), 30),
    (("remote", "hybrid"), 35),
    (("remote", "hybrid", "office"), 20),
    (("hybrid", "office"), 15),
)
RELOCATION = 0.3
MARKET_SALARY: dict[str, int] = {
    "intern": 60_000,
    "junior": 120_000,
    "middle": 210_000,
    "senior": 320_000,
    "lead": 400_000,
}
EXPECTATION_SPREAD = (0.85, 1.2)
# The region of a city, by ISO 3166-2:RU: the harness's own table, the codes are public.
CITY_REGIONS: dict[str, str] = {
    "Москва": "RU-MOW",
    "Санкт-Петербург": "RU-SPE",
    "Казань": "RU-TA",
    "Новосибирск": "RU-NVS",
    "Екатеринбург": "RU-SVE",
    "Самара": "RU-SAM",
    "Томск": "RU-TOM",
}

# The specialization of the catalog a person of the role takes the test of. Roles not here take no test.
TEST_SPECIALIZATION: dict[str, str] = {
    "backend": "backend",
    "fullstack": "backend",
    "frontend": "frontend",
    "qa_manual": "qa",
    "qa_automation": "qa",
    "data_scientist": "data_ml",
    "ml_engineer": "data_ml",
}
# The grade of the catalog for a grade of the world: the catalog has no lead.
TEST_GRADE: dict[str, str] = {
    "intern": "intern",
    "junior": "junior",
    "middle": "middle",
    "senior": "senior",
    "lead": "senior",
}
CATALOG_GRADES: tuple[str, ...] = ("intern", "junior", "middle", "senior")
TEST_TAKERS = 0.8
RETAKE = 0.7
PRACTICE_PASSED = 0.85
# Share of a block's points a person scores: holding its skills or not. The cut of a block is `BLOCK_CUT` of its points.
BLOCK_CUT = 0.6
BLOCK_SHARE = {"holds": (0.65, 1.0), "lacks": (0.3, 0.59)}
# The scenario of false confirmations: the share of the people without an honest confirmation confirmed anyway.
FALSE_CONFIRMED = 0.3

# Needs of each split by role: every role with a released test, and the roles without one.
NEEDS_PER_ROLE: dict[str, int] = {
    "backend": 10,
    "fullstack": 6,
    "frontend": 10,
    "qa_manual": 6,
    "qa_automation": 6,
    "data_scientist": 8,
    "ml_engineer": 8,
    "data_engineer": 3,
    "data_analyst": 3,
    "devops": 3,
    "mobile": 3,
    "systems_analyst": 2,
}
ALGORITHMIC_ROLES = frozenset({"backend", "data_engineer", "data_scientist", "ml_engineer"})
ALGORITHMIC_SHARE = 0.3
NEED_FORMATS: dict[str, float] = {"remote": 0.6, "hybrid": 0.2, "office": 0.2}
# Cities of the needs: the cities of the resumes, Moscow the most, and Saint Petersburg, where no resume lives.
NEED_CITIES: dict[str, float] = {
    "Москва": 0.3,
    "Санкт-Петербург": 0.1,
    "Казань": 0.12,
    "Новосибирск": 0.12,
    "Екатеринбург": 0.12,
    "Самара": 0.12,
    "Томск": 0.12,
}
BELOW_MARKET = 0.2
# Share of the needs whose range is two grades («Middle/Senior»), the rest — one.
TWO_GRADES = 0.7
# How a need writes a skill the resumes never write.
VACANCY_NAMES: dict[str, str] = {"algorithms": "Алгоритмы и структуры данных"}
FORMAT_WORDS: dict[str, str] = {"remote": "удалённо", "hybrid": "гибрид", "office": "офис"}

# Skills the world has a truth about: the lexicon's and algorithms. A skill of the catalog outside it (OOP, system
# design) is not modelled: no need asks for it, and a confirmation of it is not checked against the truth.
VOCABULARY: frozenset[str] = frozenset(SKILL_SURFACES) | {"algorithms"}


@dataclass(frozen=True)
class Preferences:
    formats: tuple[str, ...]
    region: str | None
    relocation: bool
    salary_min: int


@dataclass(frozen=True)
class Truth:
    profile_id: str
    # `None` — a student with no role yet.
    role: str | None
    # The real grade; `claimed_grade` — the one the resume shows.
    grade: str
    claimed_grade: str
    skills: tuple[str, ...]
    inflation: str
    preferences: Preferences


@dataclass(frozen=True)
class TestPlan:
    """The test a person takes: the specialization, the catalog grade of the first attempt, whether a failed attempt is
    retaken one grade lower, and whether the scenario of false confirmations confirms them."""

    specialization: str
    grade: str
    retake: bool
    false_confirmed: bool


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
    algorithmic: bool
    work_format: str
    # `None` — remote work names no city.
    city: str | None
    salary_min: int
    salary_max: int
    below_market: bool

    @property
    def region(self) -> str | None:
        return None if self.city is None else CITY_REGIONS[self.city]


@dataclass(frozen=True)
class World:
    vacancies: tuple[Vacancy, ...]
    truths: dict[str, Truth]
    plans: dict[str, TestPlan | None]

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


def _own_stack(profile: Profile) -> tuple[str, ...]:
    """The stack of the role the resume was written from: the one sharing the most skills with what it claims."""
    claimed = {m.key for m in profile.skills} | {
        m.key for job in profile.jobs for line in job.lines for m in line.mentions
    }
    stacks = _role_spec(profile.role).stacks
    return max(stacks, key=lambda stack: len(set(stack.skills) & claimed)).skills


def _preferences(rng: random.Random, profile: Profile, grade: str) -> Preferences:
    """The survey's answers; the salary expectation follows the grade the person believes they have."""
    formats = rng.choices([f for f, _ in FORMAT_SETS], weights=[w for _, w in FORMAT_SETS])[0]
    expectation = MARKET_SALARY[grade] * rng.uniform(*EXPECTATION_SPREAD)
    return Preferences(
        formats=formats,
        region=CITY_REGIONS.get(profile.city),
        relocation=rng.random() < RELOCATION,
        salary_min=int(round(expectation / 5000) * 5000),
    )


def truth_of(seed: int, profile: Profile, record: FspRecord | None) -> Truth:
    rng = random.Random(f"{seed}:truth:{profile.id}")
    used = {m.key for job in profile.jobs for line in job.lines for m in line.mentions}
    used |= {key for job in profile.jobs for key in job.title_skills}
    listed = {m.key for m in profile.skills} - used
    negated = {m.key for m in profile.negated}
    real = set(used)
    real |= {key for key in sorted(listed) if rng.random() < LISTED_REAL}
    stack = _own_stack(profile)
    omitted = sorted(set(stack) - used - listed - negated)
    real |= {key for key in omitted if rng.random() < OMITTED_REAL}
    if rng.random() < ALGORITHMS_REAL[_algorithms_class(record)]:
        real.add("algorithms")
    student = profile.kind == "skills_only"
    inflation = "honest" if student else rng.choices(list(INFLATION), weights=list(INFLATION.values()))[0]
    grade = "intern" if student else profile.grade
    if not student:
        implicit = IMPLICIT_REAL[profile.role]
        real |= {
            key for key in sorted(implicit) if key not in stack and key not in negated and rng.random() < implicit[key]
        }
    if inflation != "honest":
        claimed = sorted((used | listed) - {stack[0]} - negated)
        real -= {key for key in claimed if rng.random() < INFLATED_DROP}
    if inflation == "skills_and_grade" and grade != "intern":
        grade = GRADES[GRADES.index(grade) - 1]
    return Truth(
        profile_id=profile.id,
        role=None if student else profile.role,
        grade=grade,
        claimed_grade="intern" if student else profile.grade,
        skills=tuple(sorted(real)),
        inflation=inflation,
        preferences=_preferences(rng, profile, "intern" if student else profile.grade),
    )


def plan_of(seed: int, truth: Truth) -> TestPlan | None:
    """The test the person takes, if any: on the grade their resume shows."""
    rng = random.Random(f"{seed}:plan:{truth.profile_id}")
    specialization = TEST_SPECIALIZATION.get(truth.role) if truth.role is not None else None
    if specialization is None or rng.random() >= TEST_TAKERS:
        return None
    return TestPlan(
        specialization=specialization,
        grade=TEST_GRADE[truth.claimed_grade],
        retake=rng.random() < RETAKE,
        false_confirmed=rng.random() < FALSE_CONFIRMED,
    )


# --- Test decisions, once the catalog is known ------------------------------------------------------------------------


@dataclass(frozen=True)
class Catalog:
    """What the harness needs of the product's catalog (the bridge's `info`): the defining blocks of every category
    with their items and skills and whether its practice is a program the candidate writes, and the practice languages
    of each specialization with the skill each confirms."""

    defining: dict[tuple[str, str], tuple[tuple[str, int, tuple[str, ...]], ...]]
    writes_code: dict[tuple[str, str], bool]
    languages: dict[str, tuple[tuple[str, str], ...]]
    version: str

    @staticmethod
    def of(info: Mapping[str, Any]) -> "Catalog":
        return Catalog(
            defining={
                (c["specialization"], c["grade"]): tuple(
                    (b["block"], int(b["items"]), tuple(b["skill_keys"])) for b in c["defining"]
                )
                for c in info["categories"]
            },
            writes_code={
                (c["specialization"], c["grade"]): bool(c["practice_writes_code"]) for c in info["categories"]
            },
            languages={
                s["key"]: tuple((language["key"], language["skill"]) for language in s["practice_languages"])
                for s in info["specializations"]
            },
            version=str(info["versions"]["catalog"]),
        )


@dataclass(frozen=True)
class Decision:
    specialization: str
    grade: str
    outcome: str
    # The language the practice was solved in; `None` — no language of the practice the person could solve it in.
    practice_language: str | None
    blocks: tuple[dict[str, int | str], ...]

    def to_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "specialization": self.specialization,
            "grade": self.grade,
            "outcome": self.outcome,
            "blocks": [dict(block) for block in self.blocks],
        }
        if self.practice_language is not None:
            result["practice_language"] = self.practice_language
        return result


def _holds_stack(truth: Truth) -> bool:
    """The person really holds at least half of the stack of the role closest to what they hold."""
    if truth.role is None:
        return False
    held = set(truth.skills)
    return any(len(set(s.skills) & held) >= len(s.skills) / 2 for s in _role_spec(truth.role).stacks)


def _practice_language(truth: Truth, specialization: str, grade: str, catalog: Catalog) -> tuple[str | None, bool]:
    """The language the person writes the practice program in and whether they can: the language of their stack when
    the practice offers it, else the first one offered they hold; a practice that is not a program — none, and anyone
    can take it."""
    if not catalog.writes_code[(specialization, grade)]:
        return None, True
    offered = catalog.languages[specialization]
    held = [(key, skill) for key, skill in offered if skill in truth.skills]
    if not held:
        return None, False
    stack = {s.skills[0] for s in _role_spec(truth.role).stacks} if truth.role is not None else set()
    first = next(((key, skill) for key, skill in held if skill in stack), held[0])
    return first[0], True


def _attempt(
    seed: int, truth: Truth, specialization: str, grade: str, catalog: Catalog, *, forced: bool = False
) -> Decision:
    """One attempt by the honest model of the test; `forced` — the scenario of false confirmations: confirmed whatever
    the person holds."""
    rng = random.Random(f"{seed}:attempt:{truth.profile_id}:{specialization}:{grade}")
    above = CATALOG_GRADES.index(grade) > CATALOG_GRADES.index(TEST_GRADE[truth.grade])
    held = set(truth.skills)
    blocks = []
    for block, items, skills in catalog.defining[(specialization, grade)]:
        modelled = [key for key in skills if key in VOCABULARY]
        holds = forced or (not above and (all(key in held for key in modelled) if modelled else _holds_stack(truth)))
        points = items * 20
        cut = round(points * BLOCK_CUT)
        low, high = BLOCK_SHARE["holds" if holds else "lacks"]
        score = rng.randint(max(cut, round(points * low)), round(points * high)) if holds else None
        if score is None:
            score = rng.randint(round(points * low), cut - 1)
        blocks.append({"block": block, "items": items, "score": score, "cut": cut})
    language, can = _practice_language(truth, specialization, grade, catalog)
    practice = forced or (not above and can and rng.random() < PRACTICE_PASSED)
    confirmed = practice and all(b["score"] >= b["cut"] for b in blocks)
    if forced and language is None and catalog.writes_code[(specialization, grade)]:
        language = catalog.languages[specialization][0][0]
    return Decision(
        specialization=specialization,
        grade=grade,
        outcome="confirmed" if confirmed else "not_confirmed",
        practice_language=language if confirmed else None,
        blocks=tuple(blocks),
    )


def decide(seed: int, truth: Truth, plan: TestPlan | None, catalog: Catalog) -> tuple[Decision, ...]:
    """The honest decisions of the person's test, oldest first."""
    if plan is None:
        return ()
    first = _attempt(seed, truth, plan.specialization, plan.grade, catalog)
    index = CATALOG_GRADES.index(plan.grade)
    if first.outcome == "confirmed" or not plan.retake or index == 0:
        return (first,)
    return first, _attempt(seed, truth, plan.specialization, CATALOG_GRADES[index - 1], catalog)


def decide_falsely(seed: int, truth: Truth, plan: TestPlan | None, catalog: Catalog) -> tuple[Decision, ...] | None:
    """The decisions of the scenario of false confirmations, for a person it confirms (no honest confirmation, drawn
    into the scenario); `None` — the scenario leaves the person as the honest decisions have them."""
    if plan is None or not plan.false_confirmed:
        return None
    if any(d.outcome == "confirmed" for d in decide(seed, truth, plan, catalog)):
        return None
    return (_attempt(seed, truth, plan.specialization, plan.grade, catalog, forced=True),)


def category_of(decisions: Sequence[Decision]) -> tuple[str, str] | None:
    """The category the decisions give (domain 12.4): the confirmed decision of the highest grade."""
    confirmed = [d for d in decisions if d.outcome == "confirmed"]
    if not confirmed:
        return None
    best = max(confirmed, key=lambda d: CATALOG_GRADES.index(d.grade))
    return best.specialization, best.grade


# --- Needs ------------------------------------------------------------------------------------------------------------


def vacancy_name(key: str) -> str:
    return VACANCY_NAMES.get(key) or SKILL_SURFACES[key][0]


def _money(value: int) -> str:
    return f"{value:,}".replace(",", " ")


def need_text(vacancy: Vacancy) -> str:
    """The need as an employer writes it: the title with the grades and the role — a range of two grades as
    «Middle/Senior» — the skills, the format with the city, the salary."""

    if vacancy.grade_min == vacancy.grade_max:
        levels = next(word for word in LEVEL_WORDS[vacancy.grade_min][0] if word)
    else:
        levels = "/".join(
            next(word for word in LEVEL_WORDS[g][1] if word) for g in (vacancy.grade_min, vacancy.grade_max)
        )
    place = FORMAT_WORDS[vacancy.work_format] + ("" if vacancy.city is None else f", {vacancy.city}")
    return (
        f"{levels} {vacancy.title}\n"
        f"Требования: {', '.join(vacancy_name(key) for key in vacancy.required)}.\n"
        f"Будет плюсом: {', '.join(vacancy_name(key) for key in vacancy.nice)}.\n"
        f"Формат работы: {place}.\n"
        f"Зарплата: от {_money(vacancy.salary_min)} до {_money(vacancy.salary_max)} ₽ на руки."
    )


def _weighted(rng: random.Random, weights: Mapping[str, float]) -> str:
    return rng.choices(list(weights), weights=list(weights.values()))[0]


def _vacancy(seed: int, split: Split, index: int, role_key: str, slot: int) -> Vacancy:
    rng = random.Random(f"{seed}:vacancy:{split}:{index}")
    role = _role_spec(role_key)
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
    # The lowest grade goes round the grades from a place of the split, so every grade has needs of most roles.
    low = (slot + (0 if split == "dev" else 2)) % len(GRADES)
    high = min(low + (rng.random() < TWO_GRADES), len(GRADES) - 1)
    work_format = _weighted(rng, NEED_FORMATS)
    city = None if work_format == "remote" else _weighted(rng, NEED_CITIES)
    below_market = rng.random() < BELOW_MARKET
    low_market, high_market = MARKET_SALARY[GRADES[low]], MARKET_SALARY[GRADES[high]]
    if below_market:
        salary_min, salary_max = low_market * rng.uniform(0.55, 0.65), high_market * rng.uniform(0.75, 0.82)
    else:
        salary_min, salary_max = low_market * rng.uniform(0.9, 1.0), high_market * rng.uniform(1.25, 1.45)
    return Vacancy(
        id=f"{split[0]}n{index:03d}",
        split=split,
        role=role.key,
        grade_min=GRADES[low],
        grade_max=GRADES[high],
        required=tuple(required),
        nice=tuple(nice),
        title=stack.titles_ru[0].text,
        algorithmic=algorithmic,
        work_format=work_format,
        city=city,
        salary_min=int(round(salary_min / 5000) * 5000),
        salary_max=int(round(salary_max / 5000) * 5000),
        below_market=below_market,
    )


def _vacancies(seed: int, split: Split) -> tuple[Vacancy, ...]:
    vacancies = []
    for role_key, count in NEEDS_PER_ROLE.items():
        for slot in range(count):
            vacancies.append(_vacancy(seed, split, len(vacancies) + 1, role_key, slot))
    return tuple(vacancies)


def build_world(seed: int, dataset: Dataset, records: Mapping[str, FspRecord]) -> World:
    truths = {p.id: truth_of(seed, p, records.get(p.id)) for p in dataset.profiles}
    return World(
        vacancies=_vacancies(seed, "dev") + _vacancies(seed, "holdout"),
        truths=truths,
        plans={pid: plan_of(seed, truth) for pid, truth in truths.items()},
    )


def world_digest(world: World) -> str:
    content = {
        "vacancies": [asdict(v) for v in world.vacancies],
        "truths": [asdict(t) for _, t in sorted(world.truths.items())],
        "plans": {pid: None if plan is None else asdict(plan) for pid, plan in sorted(world.plans.items())},
    }
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def new_matching_manifest(
    layer_id: str, seed: int, dataset: Dataset, *, fsp_layer: str, records: Mapping[str, FspRecord]
) -> dict[str, object]:
    world = build_world(seed, dataset, records)
    return {
        "id": layer_id,
        "provenance": "synthetic",
        "generator": GENERATOR_VERSION,
        "seed": seed,
        "base_dataset": dataset.manifest.id,
        "fsp_layer": fsp_layer,
        "vacancies": {split: len(world.vacancies_of(split)) for split in ("dev", "holdout")},
        "labels_sha256": world_digest(world),
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
    world = build_world(layer.seed, dataset, records)
    digest = world_digest(world)
    if digest != layer.labels_sha256:
        raise DatasetError(
            f"{layer.id}: the generator no longer reproduces the labels of the manifest "
            f"({digest[:12]} ≠ {layer.labels_sha256[:12]}); a changed generator needs a new layer id"
        )
    return world


# --- Rubric v3 --------------------------------------------------------------------------------------------------------

RUBRIC = "v3"
GRADE_ORDER = {grade: index for index, grade in enumerate(GRADES)}


def admissible_categories(vacancy: Vacancy) -> frozenset[tuple[str, str]]:
    """The categories a shortlist of the need may hold by the need alone: the specialization of the need's role, the
    catalog grades of its range (a lead is a senior of the catalog). A role with no released test has none."""
    specialization = TEST_SPECIALIZATION.get(vacancy.role)
    if specialization is None:
        return frozenset()
    grades = GRADES[GRADE_ORDER[vacancy.grade_min] : GRADE_ORDER[vacancy.grade_max] + 1]
    return frozenset((specialization, TEST_GRADE[grade]) for grade in grades)


def format_fits(vacancy: Vacancy, preferences: Preferences) -> bool:
    """The person would take the format and the place of the need: the format among theirs, and an office or hybrid
    work in their region or with relocation."""
    if vacancy.work_format not in preferences.formats:
        return False
    return vacancy.region is None or preferences.region == vacancy.region or preferences.relocation


def relevance(vacancy: Vacancy, truth: Truth) -> int:
    """Rubric v3, 0–3, of the need as its employer states it. 0 — the employer does not need the person: another role,
    a grade outside the range, a format or place the person would not take, an expectation above the range, or two
    required skills or more missing. 1 — one required skill missing, everything else fits. 2 — every required skill.
    3 — every required skill and a nice one."""
    if truth.role != vacancy.role:
        return 0
    if not GRADE_ORDER[vacancy.grade_min] <= GRADE_ORDER[truth.grade] <= GRADE_ORDER[vacancy.grade_max]:
        return 0
    if not format_fits(vacancy, truth.preferences) or truth.preferences.salary_min > vacancy.salary_max:
        return 0
    held = set(truth.skills)
    missing = sum(key not in held for key in vacancy.required)
    if missing == 0:
        return 3 if any(key in held for key in vacancy.nice) else 2
    return 1 if missing == 1 else 0
