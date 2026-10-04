"""FSP achievements of the synthetic people: a layer over a resume dataset for the «with FSP data / without» ablation.

The layer decides, per profile of the base dataset, whether the person competes in sport programming and what the
federation's record of them holds — results with the norms the source states, assigned ranks, a national team — and
writes it as the source sends it (one page of `fsp-achievements/v1`). The record follows the person: a backend developer
who competes in the product discipline does it as the team's backend, a student is more likely to compete than a lead.

Labels are read from the record by the harness's own rubric, not from the product:
- the FSP level of a discipline is the highest the record states by the published scale of the taxonomy (the label
  space, like grade keys): a master rank or the main national squad — L5, a candidate master or the reserve squad — L4,
  first rank — L3, second or third — L2, a youth rank or any official result — L1. Only official results of the person
  count: a reserve or a trainer did not compete, a preliminary or annulled result is not a result yet;
- the record grounds the person's role when it holds an official result of the product discipline where the person
  competed with a personal specialization that names that role («backend in the team»). An olympiad result, a CTF or a
  team result without a specialization tells how strong a person is, not which job they do;
- the grade is not grounded by the record: a competition is not production experience.

The competitions are a small world of event kinds with the norms the regulation assigns to places (order of the
Ministry of Sport No. 299 of 2026, appendix 77), each checked against the taxonomy's norm table by a test.
"""

import hashlib
import json
import random
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Any

from fsp_eval.dataset import DATASETS_DIR, Dataset, DatasetError
from fsp_eval.profiles import Profile

GENERATOR_VERSION = 1

# Rank of the regulation → FSP level of the published scale (taxonomy/fsp-levels.json, read by a person).
RANK_LEVEL: dict[str, str] = {
    "ZMS": "L5",
    "MSMK": "L5",
    "MS": "L5",
    "KMS": "L4",
    "I": "L3",
    "II": "L2",
    "III": "L2",
    "Y1": "L1",
    "Y2": "L1",
    "Y3": "L1",
}
SQUAD_LEVEL: dict[str, str] = {"main": "L5", "reserve": "L4"}
LEVELS: tuple[str, ...] = ("L1", "L2", "L3", "L4", "L5")

# Personal specialization in a product team that names a role of the harness (how a recruiter reads it).
SPECIALIZATION_ROLE: dict[str, str] = {
    "backend": "backend",
    "frontend": "frontend",
    "fullstack": "fullstack",
    "mobile": "mobile",
    "devops": "devops",
    "ml": "ml_engineer",
}
ROLE_SPECIALIZATION: dict[str, str] = {"data_scientist": "ml"} | {
    role: spec for spec, role in SPECIALIZATION_ROLE.items()
}
INFOSEC_SPECIALIZATIONS: tuple[str, ...] = ("pentest", "web", "reverse", "crypto", "forensics", "pwn")

# Who competes: a student almost surely, a senior rarely.
PARTICIPATION: dict[str, float] = {"intern": 0.85, "junior": 0.7, "middle": 0.45, "senior": 0.25, "lead": 0.15}
STUDENT_PARTICIPATION = 1.0


@dataclass(frozen=True)
class EventKind:
    """A kind of competition and the norms its places fulfil; no norms — the stage does not count for a rank."""

    key: str
    level: str
    age_group: str
    stage: str
    online: bool
    title: str
    # (rank, first place, last place), best rank first.
    norms: tuple[tuple[str, int, int], ...]
    # How strong a person must be to take part: 0 — anyone, 1 — the national elite.
    entry: float


EVENTS: tuple[EventKind, ...] = (
    EventKind(
        "municipal",
        "municipal",
        "adults",
        "single",
        True,
        "Открытое первенство города",
        (("II", 1, 2), ("III", 3, 4)),
        0.0,
    ),
    EventKind(
        "regional",
        "regional_championship",
        "adults",
        "single",
        False,
        "Чемпионат области",
        (("I", 1, 2), ("II", 3, 4), ("III", 5, 6)),
        0.2,
    ),
    EventKind(
        "student",
        "all_russian_sport_event",
        "juniors_u26",
        "single",
        False,
        "Всероссийские студенческие соревнования",
        (("II", 1, 2), ("III", 3, 5)),
        0.2,
    ),
    EventKind("cup_qualifier", "russian_cup", "adults", "qualifier", True, "Кубок России, отборочный этап", (), 0.3),
    EventKind(
        "cup_final", "russian_cup", "adults", "final", False, "Кубок России, финал", (("KMS", 1, 3), ("I", 4, 8)), 0.6
    ),
    EventKind(
        "championship",
        "russian_championship",
        "adults",
        "single",
        False,
        "Чемпионат России",
        (("MS", 1, 1), ("KMS", 2, 4), ("I", 5, 9)),
        0.75,
    ),
)

EVENT_BY_KEY: dict[str, EventKind] = {event.key: event for event in EVENTS}

TEAM_SIZE: dict[str, tuple[int, int]] = {"algorithmic": (3, 3), "product": (3, 6), "infosec": (2, 5)}


@dataclass(frozen=True)
class FspGold:
    profile_id: str
    # The person's role (the generator's truth), whether or not anything grounds it.
    role: str
    # (discipline, level), by discipline.
    levels: tuple[tuple[str, str], ...]
    # The record alone tells the person's role (the product discipline with a specialization naming it).
    role_grounded: bool

    def to_json(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class FspRecord:
    profile_id: str
    page: dict[str, Any]
    gold: FspGold


@dataclass(frozen=True)
class FspLayer:
    id: str
    provenance: str
    generator: int
    seed: int
    base_dataset: str
    labels_sha256: str
    participants: dict[str, int]


def _hash_hex(*parts: object) -> str:
    return hashlib.sha256(":".join(map(str, parts)).encode()).hexdigest()


def _uuid(*parts: object) -> str:
    h = _hash_hex(*parts)
    return f"{h[:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}"


def _disciplines(rng: random.Random, profile: Profile) -> list[str]:
    """Product for a role a team specialization names, algorithmic for everyone, a CTF now and then."""
    options = ["algorithmic"]
    if profile.role in ROLE_SPECIALIZATION or rng.random() < 0.3:
        options.append("product")
    if profile.role in {"devops", "backend"} and rng.random() < 0.3:
        options.append("infosec")
    rng.shuffle(options)
    return options[: rng.choice((1, 1, 2))]


def _place(rng: random.Random, strength: float, event: EventKind) -> int:
    """Stronger people take higher places; the field of an event is about thirty."""
    margin = max(0.0, strength - event.entry)
    best = max(1, round(9 - 24 * margin))
    return rng.randint(best, best + 8)


def _stated_norm(event: EventKind, place: int) -> str | None:
    return next((rank for rank, first, last in event.norms if first <= place <= last), None)


@dataclass(frozen=True)
class _Entry:
    discipline: str
    event: EventKind
    on: date
    place: int
    team_role: str | None
    specialization: str | None
    # Whether the source passes the specialization field at all.
    specialization_sent: bool
    status: str


def _team(rng: random.Random, discipline: str, profile: Profile) -> tuple[str | None, str | None, bool]:
    """Team role, specialization and whether the source sends it; an individual result has none."""
    if discipline == "algorithmic" and rng.random() < 0.7:
        return None, None, False
    role = rng.choices(("athlete", "captain", "reserve"), weights=(70, 20, 10))[0]
    if discipline == "product":
        spec = ROLE_SPECIALIZATION.get(profile.role)
        if spec is None or rng.random() < 0.25:
            return role, None, rng.random() < 0.5
        return role, spec, True
    if discipline == "infosec":
        return role, rng.choice(INFOSEC_SPECIALIZATIONS), True
    return role, None, False


def _entries(rng: random.Random, profile: Profile, as_of: date, birth_year: int) -> list[_Entry]:
    strength = rng.betavariate(2, 2)
    if profile.kind == "skills_only":
        strength = min(1.0, strength + 0.1)
    entries: list[_Entry] = []
    for discipline in _disciplines(rng, profile):
        for _ in range(rng.randint(1, 3)):
            events = [e for e in EVENTS if e.entry <= strength + 0.15]
            event = rng.choice(events)
            year = rng.randint(as_of.year - 3, as_of.year)
            on = date(year, rng.randint(1, 12), rng.randint(1, 28))
            if on >= as_of:
                on = date(year - 1, on.month, on.day)
            if event.age_group == "juniors_u26" and on.year - birth_year >= 26:
                event = EVENT_BY_KEY["regional"]
            team_role, spec, sent = _team(rng, discipline, profile)
            status = rng.choices(("official", "preliminary", "annulled"), weights=(92, 5, 3))[0]
            entries.append(_Entry(discipline, event, on, _place(rng, strength, event), team_role, spec, sent, status))
    return entries


def _counts(entry: _Entry) -> bool:
    """An official result the person competed in."""
    return entry.status == "official" and entry.team_role not in {"reserve", "trainer"}


def _page(
    profile: Profile,
    entries: list[_Entry],
    *,
    birth_year: int,
    qualifications: list[dict[str, Any]],
    national_team: dict[str, Any] | None,
    seed: int,
    as_of: date,
) -> dict[str, Any]:
    competitions: dict[str, dict[str, Any]] = {}
    results = []
    for index, entry in enumerate(entries):
        competition_id = _uuid(seed, "competition", entry.discipline, entry.event.key, entry.on.isoformat())
        competitions[competition_id] = {
            "id": competition_id,
            "ekpNumber": None,
            "title": f"{entry.event.title} ({entry.discipline})",
            "discipline": entry.discipline,
            "level": entry.event.level,
            "stage": entry.event.stage,
            "ageGroup": entry.event.age_group,
            "format": "individual" if entry.team_role is None else "team",
            "startDate": entry.on.isoformat(),
            "online": entry.event.online,
        }
        result: dict[str, Any] = {
            "id": _uuid(seed, "result", profile.id, index),
            "competitionId": competition_id,
            "place": entry.place,
            "evskFulfilled": _stated_norm(entry.event, entry.place) if _counts(entry) else None,
            "status": entry.status,
        }
        if entry.team_role is not None:
            low, high = TEAM_SIZE[entry.discipline]
            team: dict[str, Any] = {
                "id": _uuid(seed, "team", profile.id, index),
                "name": f"Команда {index + 1}",
                "size": low if low == high else low + index % (high - low + 1),
                "role": entry.team_role,
            }
            if entry.specialization_sent:
                team["specialization"] = entry.specialization
            result["team"] = team
        results.append(result)
    return {
        "athlete": {
            "fspId": _uuid(seed, "athlete", profile.id),
            "lastName": profile.name.split(" ")[1],
            "firstName": profile.name.split(" ")[0],
            "birthYear": birth_year,
            **({"nationalTeam": national_team} if national_team else {}),
        },
        "qualifications": qualifications,
        "results": results,
        "competitions": sorted(competitions.values(), key=lambda c: c["id"]),
        "generatedAt": f"{as_of.isoformat()}T00:00:00Z",
        "sourceVersion": f"eval-{seed}",
        "page": {"number": 1, "size": 100, "totalPages": 1, "totalResults": len(results)},
        "complete": True,
    }


def _qualifications(
    rng: random.Random, profile: Profile, entries: list[_Entry], seed: int, as_of: date
) -> list[dict[str, Any]]:
    """The rank of the best norm fulfilled, assigned by an order some months later, when the source knows it."""
    order = list(RANK_LEVEL)
    stated = [
        (order.index(rank), entry)
        for entry in entries
        if _counts(entry) and (rank := _stated_norm(entry.event, entry.place)) is not None
    ]
    if not stated or rng.random() >= 0.6:
        return []
    best_index, entry = min(stated, key=lambda pair: (pair[0], pair[1].on))
    month = entry.on.month + 2
    assigned = min(date(entry.on.year + (month - 1) // 12, (month - 1) % 12 + 1, 1), as_of)
    competition_id = _uuid(seed, "competition", entry.discipline, entry.event.key, entry.on.isoformat())
    return [
        {
            "id": _uuid(seed, "qualification", profile.id),
            "rank": order[best_index],
            "discipline": entry.discipline,
            "assignedAt": assigned.isoformat(),
            "basisCompetitionId": competition_id,
        }
    ]


def _levels(entries: list[_Entry], qualifications: list[dict[str, Any]], team: dict[str, Any] | None) -> dict[str, str]:
    found: dict[str, list[str]] = {}
    for entry in entries:
        if not _counts(entry):
            continue
        rank = _stated_norm(entry.event, entry.place)
        found.setdefault(entry.discipline, []).append(RANK_LEVEL[rank] if rank else "L1")
    for qualification in qualifications:
        found.setdefault(qualification["discipline"], []).append(RANK_LEVEL[qualification["rank"]])
    if team:
        found.setdefault(team["discipline"], []).append(SQUAD_LEVEL[team["squad"]])
    return {discipline: max(levels, key=LEVELS.index) for discipline, levels in found.items()}


def record_of(seed: int, profile: Profile, as_of: date) -> FspRecord | None:
    """The FSP record of a person, or `None` — the person does not compete."""
    rng = random.Random(f"{seed}:fsp:{profile.id}")
    chance = STUDENT_PARTICIPATION if profile.kind == "skills_only" else PARTICIPATION[profile.grade]
    if rng.random() >= chance:
        return None
    age = (
        rng.randint(19, 22) if profile.kind == "skills_only" else 22 + profile.months_in_role // 12 + rng.randint(0, 3)
    )
    birth_year = as_of.year - age
    entries = _entries(rng, profile, as_of, birth_year)
    qualifications = _qualifications(rng, profile, entries, seed, as_of)
    best = max((RANK_LEVEL.get(q["rank"], "L1") for q in qualifications), key=LEVELS.index, default="L1")
    national_team = None
    if best in {"L4", "L5"} and rng.random() < 0.3:
        national_team = {"discipline": qualifications[0]["discipline"], "squad": "reserve", "season": as_of.year}
    page = _page(
        profile,
        entries,
        birth_year=birth_year,
        qualifications=qualifications,
        national_team=national_team,
        seed=seed,
        as_of=as_of,
    )
    grounded = any(
        _counts(entry)
        and entry.discipline == "product"
        and entry.specialization is not None
        and SPECIALIZATION_ROLE.get(entry.specialization) == profile.role
        for entry in entries
    )
    levels = _levels(entries, qualifications, national_team)
    return FspRecord(profile.id, page, FspGold(profile.id, profile.role, tuple(sorted(levels.items())), grounded))


def generate_records(seed: int, dataset: Dataset) -> dict[str, FspRecord]:
    as_of = date.fromisoformat(dataset.manifest.as_of)
    records = (record_of(seed, profile, as_of) for profile in dataset.profiles)
    return {record.profile_id: record for record in records if record is not None}


def records_digest(records: dict[str, FspRecord]) -> str:
    content = [{"page": r.page, "gold": r.gold.to_json()} for _, r in sorted(records.items())]
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def new_layer_manifest(layer_id: str, seed: int, dataset: Dataset) -> dict[str, object]:
    records = generate_records(seed, dataset)
    return {
        "id": layer_id,
        "provenance": "synthetic",
        "generator": GENERATOR_VERSION,
        "seed": seed,
        "base_dataset": dataset.manifest.id,
        "labels_sha256": records_digest(records),
        "participants": {
            split: sum(1 for p in dataset.split(split) if p.id in records) for split in ("dev", "holdout")
        },
    }


def load_layer(layer_id: str, directory: Path = DATASETS_DIR) -> FspLayer:
    path = directory / layer_id / "manifest.json"
    if not path.is_file():
        raise DatasetError(f"no manifest {path}")
    return FspLayer(**json.loads(path.read_text(encoding="utf-8")))


def build_layer(layer: FspLayer, dataset: Dataset) -> dict[str, FspRecord]:
    if layer.base_dataset != dataset.manifest.id:
        raise DatasetError(f"{layer.id} is a layer over {layer.base_dataset}, not over {dataset.manifest.id}")
    if layer.generator != GENERATOR_VERSION:
        raise DatasetError(f"{layer.id} was made by generator {layer.generator}, this is generator {GENERATOR_VERSION}")
    records = generate_records(layer.seed, dataset)
    digest = records_digest(records)
    if digest != layer.labels_sha256:
        raise DatasetError(
            f"{layer.id}: the generator no longer reproduces the records of the manifest "
            f"({digest[:12]} ≠ {layer.labels_sha256[:12]}); a changed generator needs a new layer id"
        )
    return records
