"""Synthetic people: the source of every document and of its labels.

A profile is drawn from a seeded generator: role, grade, career with dated jobs, achievement lines with the skills
they name, a skills section, languages, education. The generator decides the truth first (who the person is) and
the documents only show it; labels are read from the profile, never from what the product extracts.
"""

import hashlib
import random
from dataclasses import dataclass
from typing import Literal

from fsp_eval.families import Family, Split, families_of
from fsp_eval.lexicon import (
    ABOUT_EN,
    ABOUT_RU,
    CITIES,
    DEGREES_EN,
    DEGREES_RU,
    FEMALE_NAMES,
    FIRST_NAMES,
    GENERIC_LINES_EN,
    GENERIC_LINES_RU,
    GRADE_MONTHS,
    GRADE_WEIGHTS,
    GRADES,
    INSTITUTIONS,
    LANGUAGE_LEVELS,
    LAST_NAMES_M,
    LEVEL_WORDS,
    MARKER_LINES,
    NEGATED_LINES_EN,
    NEGATED_LINES_RU,
    ORGANIZATIONS,
    ROLES,
    SKILL_SURFACES,
    STARTER_SKILLS,
    RoleSpec,
    Stack,
)

Kind = Literal["full", "no_dates", "skills_only"]
Language = Literal["ru", "en"]

# Share of each kind: most resumes are complete; some give no dates, some have no experience at all.
KIND_WEIGHTS: dict[Kind, int] = {"full": 84, "no_dates": 8, "skills_only": 8}
TYPO_SHARE = 0.12
NEGATED_SHARE = 0.2


@dataclass(frozen=True)
class Mention:
    surface: str
    key: str
    typo: bool = False


@dataclass(frozen=True)
class Line:
    text: str
    mentions: tuple[Mention, ...] = ()
    marker: str | None = None


@dataclass(frozen=True)
class Job:
    title: str
    title_skills: tuple[str, ...]
    role: str
    organization: str
    # (year, month); `end` is None for a job held now.
    start: tuple[int, int]
    end: tuple[int, int] | None
    lines: tuple[Line, ...]


@dataclass(frozen=True)
class Education:
    institution: str
    degree: str
    year: int


@dataclass(frozen=True)
class Profile:
    id: str
    split: Split
    family: str
    language: Language
    kind: Kind
    role: str
    grade: str
    months_in_role: int
    name: str
    city: str
    email: str
    phone: str
    headline: str
    jobs: tuple[Job, ...]
    skills: tuple[Mention, ...]
    negated: tuple[Mention, ...]
    languages: tuple[tuple[str, str], ...]
    education: tuple[Education, ...]
    about: str


def _hash_int(*parts: object) -> int:
    return int.from_bytes(hashlib.sha256(":".join(map(str, parts)).encode()).digest()[:8], "big")


def assign(seed: int, profile_id: str, holdout_percent: int) -> tuple[Split, Family]:
    """Split by profile and the family within the split: fixed by the seed and the id alone."""
    split: Split = "holdout" if _hash_int(seed, "split", profile_id) % 100 < holdout_percent else "dev"
    candidates = families_of(split)
    return split, candidates[_hash_int(seed, "family", profile_id) % len(candidates)]


def _has_cyrillic(text: str) -> bool:
    return any("а" <= char.lower() <= "я" or char in "ёЁ" for char in text)


def _surface(rng: random.Random, key: str, language: Language) -> str:
    options = SKILL_SURFACES[key]
    if language == "en":
        options = tuple(option for option in options if not _has_cyrillic(option))
        if not options:
            raise ValueError(f"skill {key} has no spelling for an English resume")
    return rng.choice(options)


def _typo(rng: random.Random, surface: str) -> str | None:
    """Two neighbouring letters swapped inside a long word, the way people mistype; `None` — not applicable."""
    if len(surface) < 6 or not surface.isascii() or not surface.isalpha():
        return None
    places = [i for i in range(1, len(surface) - 2) if surface[i] != surface[i + 1]]
    if not places:
        return None
    i = rng.choice(places)
    return surface[:i] + surface[i + 1] + surface[i] + surface[i + 2 :]


def _level_at(months: int, grade: str) -> str:
    """The level a title shows after `months` of experience, never above the person's grade."""
    reached = "intern" if months < 6 else "junior" if months < 24 else "middle" if months < 60 else "senior"
    return GRADES[min(GRADES.index(reached), GRADES.index(grade))]


def _title(rng: random.Random, stack: Stack, level: str, language: Language) -> tuple[str, tuple[str, ...]]:
    stem = rng.choice(stack.titles_ru if language == "ru" else stack.titles_en)
    word = rng.choice(LEVEL_WORDS[level][0 if language == "ru" else 1])
    return f"{word} {stem.text}".strip(), stem.skills


def _month_index(year: int, month: int) -> int:
    return year * 12 + month - 1


def _from_index(index: int) -> tuple[int, int]:
    return index // 12, index % 12 + 1


def _markers_for(rng: random.Random, grade: str, level: str, last: bool) -> list[str]:
    if grade == "lead" and last:
        return ["team_lead", *([rng.choice(["mentoring", "architecture"])] if rng.random() < 0.5 else [])]
    if level == "senior" and rng.random() < (0.35 if last else 0.2):
        return [rng.choice(["mentoring", "architecture"])]
    if level == "middle" and rng.random() < 0.1:
        return ["mentoring"]
    return []


def _marker_line(rng: random.Random, marker: str, language: Language) -> Line:
    text = rng.choice(MARKER_LINES[marker][0 if language == "ru" else 1]).format(n=rng.randint(4, 9))
    return Line(text, (), marker)


def _job_lines(
    rng: random.Random, role: RoleSpec, stack: Stack, language: Language, markers: list[str]
) -> tuple[Line, ...]:
    templates = list(role.lines_ru if language == "ru" else role.lines_en)
    rng.shuffle(templates)
    pool = list(stack.skills)
    rng.shuffle(pool)
    lines: list[Line] = []
    for template in templates[: rng.randint(2, 4)]:
        slots = template.count("{")
        if len(pool) < slots:
            break
        keys = [pool.pop() for _ in range(slots)]
        mentions = tuple(Mention(_surface(rng, key, language), key) for key in keys)
        lines.append(Line(template.format(*(m.surface for m in mentions)), mentions))
    if rng.random() < 0.4:
        lines.append(Line(rng.choice(GENERIC_LINES_RU if language == "ru" else GENERIC_LINES_EN)))
    lines.extend(_marker_line(rng, marker, language) for marker in markers)
    return tuple(lines)


def _career(
    rng: random.Random,
    role: RoleSpec,
    stack: Stack,
    *,
    grade: str,
    months: int,
    language: Language,
    as_of: tuple[int, int],
) -> tuple[Job, ...]:
    count = 1 if months < 12 else rng.randint(2, min(4, months // 12 + 1))
    # Lengths of the jobs, oldest first, at least three months each, summing to the months in the role.
    shares = [rng.uniform(1, 3) for _ in range(count)]
    lengths = [3 + int((months - 3 * count) * share / sum(shares)) for share in shares]
    lengths[-1] += months - sum(lengths)
    end = _month_index(*as_of) - (0 if rng.random() < 0.8 else rng.randint(1, 6))
    spans: list[tuple[int, int]] = []
    for length in reversed(lengths):
        spans.append((end - length + 1, end))
        end = end - length - rng.randint(1, 3)
    spans.reverse()
    organizations = rng.sample(ORGANIZATIONS, count)
    jobs: list[Job] = []
    elapsed = 0
    for index, ((start, stop), organization) in enumerate(zip(spans, organizations, strict=True)):
        elapsed += stop - start + 1
        last = index == count - 1
        level = grade if last else _level_at(elapsed, grade)
        title, title_skills = _title(rng, stack, level, language)
        markers = _markers_for(rng, grade, level, last)
        jobs.append(
            Job(
                title=title,
                title_skills=title_skills,
                role=role.key,
                organization=organization[0 if language == "ru" else 1],
                start=_from_index(start),
                end=None if last and stop == _month_index(*as_of) else _from_index(stop),
                lines=_job_lines(rng, role, stack, language, markers),
            )
        )
    return tuple(jobs)


def _skills_section(rng: random.Random, stack: Stack, jobs: tuple[Job, ...], language: Language) -> tuple[Mention, ...]:
    named = [m.key for job in jobs for line in job.lines for m in line.mentions]
    extra = [key for key in stack.skills if key not in named]
    rng.shuffle(extra)
    keys = list(dict.fromkeys(named))
    keys += extra[: max(0, rng.randint(5, 10) - len(keys))]
    rng.shuffle(keys)
    mentions: list[Mention] = []
    for key in keys:
        surface = _surface(rng, key, language)
        typo = _typo(rng, surface) if rng.random() < TYPO_SHARE else None
        mentions.append(Mention(typo or surface, key, typo is not None))
    return tuple(mentions)


def _negated(rng: random.Random, asserted: set[str], language: Language) -> tuple[tuple[Mention, ...], str]:
    others = sorted({key for role in ROLES for stack in role.stacks for key in stack.skills} - asserted)
    key = rng.choice(others)
    mention = Mention(_surface(rng, key, language), key)
    template = rng.choice(NEGATED_LINES_RU if language == "ru" else NEGATED_LINES_EN)
    return (mention,), template.format(mention.surface)


def _person_name(rng: random.Random) -> str:
    first = rng.choice(FIRST_NAMES)
    last = rng.choice(LAST_NAMES_M)
    if first in FEMALE_NAMES:
        last = last[:-2] + "ая" if last.endswith(("ой", "ый", "ий")) else last + "а"
    return f"{first} {last}"


def generate_profile(seed: int, index: int, as_of: tuple[int, int], holdout_percent: int) -> Profile:
    profile_id = f"p{index:04d}"
    split, family = assign(seed, profile_id, holdout_percent)
    language: Language = family.language
    rng = random.Random(f"{seed}:profile:{profile_id}")
    role = rng.choice(ROLES)
    stack = rng.choice(role.stacks)
    kind: Kind = rng.choices(list(KIND_WEIGHTS), weights=list(KIND_WEIGHTS.values()))[0]
    grade = rng.choices(list(GRADE_WEIGHTS), weights=list(GRADE_WEIGHTS.values()))[0]
    months = rng.randint(*GRADE_MONTHS[grade])

    if kind == "skills_only":
        jobs: tuple[Job, ...] = ()
        skills = tuple(Mention(_surface(rng, key, language), key) for key in STARTER_SKILLS)
        headline = "Стажёр" if language == "ru" else "Intern"
        about = "Студент, ищу первую работу в ИТ." if language == "ru" else "Student looking for a first job in IT."
        negated: tuple[Mention, ...] = ()
    else:
        jobs = _career(rng, role, stack, grade=grade, months=months, language=language, as_of=as_of)
        skills = _skills_section(rng, stack, jobs, language)
        headline = jobs[-1].title
        about = rng.choice(ABOUT_RU if language == "ru" else ABOUT_EN)
        negated = ()
        if rng.random() < NEGATED_SHARE:
            asserted = (
                {m.key for m in skills}
                | {m.key for job in jobs for line in job.lines for m in line.mentions}
                | {key for job in jobs for key in job.title_skills}
            )
            negated, line = _negated(rng, asserted, language)
            about = f"{about} {line}."

    languages = [("en", rng.choice(LANGUAGE_LEVELS))] if rng.random() < 0.95 else []
    if rng.random() < 0.15:
        languages.append(("de", rng.choice(LANGUAGE_LEVELS[:2])))
    institution = rng.choice(INSTITUTIONS)[0 if language == "ru" else 1]
    graduated = as_of[0] - months // 12 - rng.randint(0, 2)
    education = (
        (Education(institution, rng.choice(DEGREES_RU if language == "ru" else DEGREES_EN), graduated),)
        if kind == "skills_only" or rng.random() < 0.9
        else ()
    )
    number = _hash_int(seed, "phone", profile_id) % 10_000
    return Profile(
        id=profile_id,
        split=split,
        family=family.key,
        language=language,
        kind=kind,
        role=role.key,
        grade=grade,
        months_in_role=months,
        name=_person_name(rng),
        city=rng.choice(CITIES),
        email=f"candidate.{profile_id}@example.com",
        phone=f"+7 900 000-{number // 100:02d}-{number % 100:02d}",
        headline=headline,
        jobs=jobs,
        skills=skills,
        negated=negated,
        languages=tuple(languages),
        education=education,
        about=about,
    )


def generate_profiles(seed: int, count: int, as_of: tuple[int, int], holdout_percent: int) -> tuple[Profile, ...]:
    return tuple(generate_profile(seed, index, as_of, holdout_percent) for index in range(1, count + 1))
