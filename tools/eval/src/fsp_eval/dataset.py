"""A dataset: its manifest (committed) and the profiles, labels and files the manifest regenerates.

The manifest fixes the seed, size, reference date and split, and the hash of every profile with its labels. Files are
not committed: they are rendered on each run from the profiles, and the hash check refuses a generator that no longer
produces the labels the manifest was made with — a changed generator is a new dataset id, not a silent drift.
"""

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

from fsp_eval.families import Split, families_of
from fsp_eval.gold import Gold, gold_of
from fsp_eval.profiles import Profile, generate_profiles
from fsp_eval.render import render

GENERATOR_VERSION = 2
DATASETS_DIR = Path(__file__).resolve().parents[2] / "datasets"


class DatasetError(Exception):
    pass


@dataclass(frozen=True)
class Manifest:
    id: str
    provenance: str
    generator: int
    seed: int
    profiles: int
    as_of: str
    holdout_percent: int
    labels_sha256: str
    splits: dict[str, dict[str, object]]

    @property
    def as_of_month(self) -> tuple[int, int]:
        value = date.fromisoformat(self.as_of)
        return value.year, value.month


@dataclass(frozen=True)
class Dataset:
    manifest: Manifest
    profiles: tuple[Profile, ...]
    golds: dict[str, Gold]

    def split(self, split: Split) -> tuple[Profile, ...]:
        return tuple(profile for profile in self.profiles if profile.split == split)


def labels_digest(profiles: tuple[Profile, ...]) -> str:
    content = [{"profile": asdict(profile), "gold": gold_of(profile).to_json()} for profile in profiles]
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def new_manifest(dataset_id: str, seed: int, count: int, as_of: str, holdout_percent: int) -> dict[str, object]:
    """The manifest of a new dataset version, computed from the generator as it is now."""
    value = date.fromisoformat(as_of)
    profiles = generate_profiles(seed, count, (value.year, value.month), holdout_percent)
    splits: dict[str, dict[str, object]] = {}
    for split in ("dev", "holdout"):
        members = [p for p in profiles if p.split == split]
        splits[split] = {
            "profiles": len(members),
            "families": [family.key for family in families_of(split)],
        }
    return {
        "id": dataset_id,
        "provenance": "synthetic",
        "generator": GENERATOR_VERSION,
        "seed": seed,
        "profiles": count,
        "as_of": as_of,
        "holdout_percent": holdout_percent,
        "labels_sha256": labels_digest(profiles),
        "splits": splits,
    }


def load_manifest(dataset_id: str, directory: Path = DATASETS_DIR) -> Manifest:
    path = directory / dataset_id / "manifest.json"
    if not path.is_file():
        raise DatasetError(f"no manifest {path}")
    return Manifest(**json.loads(path.read_text(encoding="utf-8")))


def build(manifest: Manifest) -> Dataset:
    if manifest.generator != GENERATOR_VERSION:
        raise DatasetError(
            f"{manifest.id} was made by generator {manifest.generator}, this is generator {GENERATOR_VERSION}"
        )
    profiles = generate_profiles(manifest.seed, manifest.profiles, manifest.as_of_month, manifest.holdout_percent)
    digest = labels_digest(profiles)
    if digest != manifest.labels_sha256:
        raise DatasetError(
            f"{manifest.id}: the generator no longer reproduces the labels of the manifest "
            f"({digest[:12]} ≠ {manifest.labels_sha256[:12]}); a changed generator needs a new dataset id"
        )
    return Dataset(manifest, profiles, {profile.id: gold_of(profile) for profile in profiles})


@dataclass(frozen=True)
class DocumentFile:
    profile_id: str
    path: Path
    declared_name: str
    sha256: str


def write_documents(dataset: Dataset, split: Split, directory: Path) -> list[DocumentFile]:
    directory.mkdir(parents=True, exist_ok=True)
    files = []
    for profile in dataset.split(split):
        content, extension = render(profile, dataset.manifest.as_of_month)
        path = directory / f"{profile.id}.{extension}"
        path.write_bytes(content)
        files.append(
            DocumentFile(profile.id, path, f"resume-{profile.id}.{extension}", hashlib.sha256(content).hexdigest())
        )
    return files
