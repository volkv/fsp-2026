import dataclasses
import json
from datetime import date
from pathlib import Path

import pytest

from fsp_eval.dataset import DatasetError, build, load_manifest
from fsp_eval.fsp import (
    EVENTS,
    RANK_LEVEL,
    SPECIALIZATION_ROLE,
    _counts,
    _Entry,
    _levels,
    _stated_norm,
    build_layer,
    generate_records,
    load_layer,
    records_digest,
)

LAYER = load_layer("fsp-achievements-v2")
DATASET = build(load_manifest(LAYER.base_dataset))
STRENGTH = json.loads((Path(__file__).parent / "taxonomy" / "fsp-strength.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def records():
    return build_layer(LAYER, DATASET)


def test_the_committed_layer_is_reproduced(records):
    for split, count in LAYER.participants.items():
        assert sum(1 for p in DATASET.split(split) if p.id in records) == count
    assert records_digest(records) == LAYER.labels_sha256


def test_a_changed_generator_or_another_base_is_refused():
    with pytest.raises(DatasetError, match="new layer id"):
        build_layer(dataclasses.replace(LAYER, labels_sha256="0" * 64), DATASET)
    with pytest.raises(DatasetError, match="not over"):
        build_layer(dataclasses.replace(LAYER, base_dataset="other"), DATASET)


def test_generation_is_deterministic_and_depends_on_the_seed():
    first = generate_records(1, DATASET)
    assert records_digest(first) == records_digest(generate_records(1, DATASET))
    assert records_digest(first) != records_digest(generate_records(2, DATASET))


def test_the_norms_of_the_world_are_those_of_the_regulation():
    # Each event kind states the norms the taxonomy's table gives its level and age group; a stage outside the
    # eligible ones states none.
    norm = STRENGTH["evskNorm"]
    table = {(row["level"], row["ageGroup"]): row["ranges"] for row in norm["rows"]}
    for event in EVENTS:
        expected = table.get((event.level, event.age_group), []) if event.stage in norm["eligibleStages"] else []
        assert [(r["rank"], r["fromPlace"], r["toPlace"]) for r in expected] == list(event.norms), event.key


def _entry(**overrides) -> _Entry:
    values = {
        "discipline": "product",
        "event": next(e for e in EVENTS if e.key == "regional"),
        "on": date(2025, 5, 10),
        "place": 1,
        "team_role": "athlete",
        "specialization": "backend",
        "specialization_sent": True,
        "status": "official",
    }
    return _Entry(**(values | overrides))


def test_the_level_rubric_counts_only_results_of_the_person():
    assert _stated_norm(_entry().event, 1) == "I"
    assert _levels([_entry()], [], None) == {"product": "L3"}
    # A reserve did not compete, a preliminary or annulled result is not a result yet.
    for entry in (_entry(team_role="reserve"), _entry(status="preliminary"), _entry(status="annulled")):
        assert not _counts(entry)
        assert _levels([entry], [], None) == {}
    # Any official result is the first level; an assigned rank and a squad raise it.
    assert _levels([_entry(place=30)], [], None) == {"product": "L1"}
    qualification = {"rank": "KMS", "discipline": "algorithmic"}
    assert _levels([_entry(place=30)], [qualification], None) == {"product": "L1", "algorithmic": "L4"}
    squad = {"discipline": "product", "squad": "main", "season": 2026}
    assert _levels([_entry()], [], squad) == {"product": "L5"}
    assert set(RANK_LEVEL.values()) == {"L1", "L2", "L3", "L4", "L5"}


def test_records_follow_the_rubric(records):
    for profile_id, record in records.items():
        profile = next(p for p in DATASET.profiles if p.id == profile_id)
        page = record.page
        assert page["page"]["totalPages"] == 1
        assert page["complete"] is True
        competitions = {c["id"]: c for c in page["competitions"]}
        assert {r["competitionId"] for r in page["results"]} <= set(competitions)
        for result in page["results"]:
            team = result.get("team")
            if result["status"] != "official" or (team and team["role"] == "reserve"):
                assert result["evskFulfilled"] is None
        # The role is grounded exactly when a counted product result names the person's role.
        grounded = any(
            result["status"] == "official"
            and competitions[result["competitionId"]]["discipline"] == "product"
            and (team := result.get("team"))
            and team["role"] != "reserve"
            and SPECIALIZATION_ROLE.get(team.get("specialization") or "") == profile.role
            for result in page["results"]
        )
        assert record.gold.role_grounded == grounded, profile_id
        assert record.gold.role == profile.role
    # The layer holds people of every kind, grounded roles and several levels.
    golds = [record.gold for record in records.values()]
    assert any(g.role_grounded for g in golds)
    assert len({level for g in golds for _, level in g.levels}) >= 3
