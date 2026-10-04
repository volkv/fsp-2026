"""Labels of a document, read from its source profile and the template family that rendered it.

Nothing here looks at the product's output. What a careful human reader would take from the document is the label:
the skills the resume asserts (titles, achievement lines, the skills section, English with its level — not «planning
to learn X»), each job's period at the precision the template printed it, role, organization, languages with levels,
education, responsibility lines; and whether the resume gives enough to name a role and a grade at all.
"""

from dataclasses import asdict, dataclass

from fsp_eval.families import FAMILY_BY_KEY
from fsp_eval.lexicon import fold_spelling
from fsp_eval.profiles import Job, Mention, Profile


@dataclass(frozen=True)
class Gold:
    profile_id: str
    skills: tuple[str, ...]
    periods: tuple[str, ...]
    roles: tuple[str, ...]
    organizations: tuple[str, ...]
    languages: tuple[str, ...]
    education: tuple[str, ...]
    markers: tuple[str, ...]
    # Categorization: the role and grade of the person, and whether the resume grounds each of them.
    role: str | None
    role_sufficient: bool
    grade: str | None
    grade_sufficient: bool
    # Skill spellings of the document with their keys (normalization is measured on them).
    mentions: tuple[tuple[str, str, bool], ...]

    def to_json(self) -> dict[str, object]:
        return asdict(self)


def period_key(start: tuple[int, int], end: tuple[int, int] | None, year_only: bool) -> str:
    """A period as the document states it: `2021-03/present`, `2019/2021`."""

    def point(value: tuple[int, int]) -> str:
        return f"{value[0]}" if year_only else f"{value[0]}-{value[1]:02d}"

    return f"{point(start)}/{'present' if end is None else point(end)}"


def _job_mentions(job: Job) -> list[tuple[str, str, bool]]:
    return [(m.surface, m.key, m.typo) for line in job.lines for m in line.mentions]


def gold_of(profile: Profile) -> Gold:
    family = FAMILY_BY_KEY[profile.family]
    dated = profile.kind == "full"
    skills = {m.key for m in profile.skills}
    for job in profile.jobs:
        skills.update(job.title_skills)
        skills.update(m.key for line in job.lines for m in line.mentions)
    # English is a skill of the taxonomy: a resume that states its level asserts it.
    if any(code == "en" for code, _ in profile.languages):
        skills.add("english")
    mentions = [(m.surface, m.key, m.typo) for m in profile.skills]
    for job in profile.jobs:
        mentions.extend(_job_mentions(job))
    return Gold(
        profile_id=profile.id,
        skills=tuple(sorted(skills)),
        periods=tuple(period_key(job.start, job.end, family.date_style == "year") for job in profile.jobs if dated),
        roles=tuple(job.role for job in profile.jobs),
        organizations=tuple(job.organization for job in profile.jobs),
        languages=tuple(f"{code}:{level}" for code, level in profile.languages),
        education=tuple(entry.institution for entry in profile.education),
        markers=tuple(sorted(line.marker for job in profile.jobs for line in job.lines if line.marker)),
        role=None if profile.kind == "skills_only" else profile.role,
        role_sufficient=profile.kind != "skills_only",
        grade=profile.grade if dated else None,
        grade_sufficient=dated,
        mentions=tuple(sorted(set(mentions))),
    )


def unfamiliar_skills(profile: Profile, known: set[str]) -> set[str]:
    """Skills the document writes only in spellings the taxonomy does not know (`known`, folded): no typo, no canonical
    name or alias among its mentions, and not in a job title, whose words name the skill in their own way."""
    written: dict[str, list[Mention]] = {}
    for mention in (*profile.skills, *(m for job in profile.jobs for line in job.lines for m in line.mentions)):
        written.setdefault(mention.key, []).append(mention)
    titled = {key for job in profile.jobs for key in job.title_skills}
    return {
        key
        for key, mentions in written.items()
        if key not in titled and all(not m.typo and fold_spelling(m.surface) not in known for m in mentions)
    }
