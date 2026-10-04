"""The journal of the holdout: every look at the holdout part of a dataset, written down before the run.

A holdout measures a product nobody tuned on it only while nobody has seen its numbers. Each run on it shows them to
whoever runs it, so the number of looks is part of the result: the journal (`reports/holdout/journal.json`, kept with
the code) lists them — dataset, mode, product revision, date, who and why, then the report and what it showed. A run on
the holdout is refused unless the journal already holds its entry: dataset and mode of the run, the revision the bridge
reports, today's date (UTC), who and why. The entry is written first and committed with the report after the run.
The revision must name a commit and nothing else: a bridge built from a checkout with uncommitted changes reports its
commit with `-dirty` (src/eval/bundle.config.ts), and the holdout is not looked at with code no commit holds.
"""

import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

JOURNAL = Path("tools") / "eval" / "reports" / "holdout" / "journal.json"
# Characters of a revision an entry must give at least: a short commit hash names one commit of the checkout.
MIN_REVISION = 12
# What the bridge reports for a build of one commit and nothing more: its hash, at least `MIN_REVISION` characters.
COMMIT = re.compile(rf"[0-9a-f]{{{MIN_REVISION},40}}")


class HoldoutError(Exception):
    pass


@dataclass(frozen=True)
class Access:
    """A look at the holdout the run is: the entry of the journal and how many looks at the dataset it lists."""

    index: int
    by: str
    purpose: str
    looks_at_dataset: int

    def to_json(self) -> dict[str, Any]:
        return {
            "journal_entry": self.index,
            "by": self.by,
            "purpose": self.purpose,
            "looks_at_dataset": self.looks_at_dataset,
        }


def _entries(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise HoldoutError(f"no holdout journal {path}: a run on the holdout is written into it first")
    content = json.loads(path.read_text(encoding="utf-8"))
    entries = content.get("accesses") if isinstance(content, dict) else None
    if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
        raise HoldoutError(f"{path}: `accesses` must be a list of entries")
    return entries


def registered_access(repo: Path, *, dataset_id: str, mode: str, revision: str, today: date) -> Access:
    """The journal entry of this run on the holdout, or `HoldoutError` naming what the entry must say."""
    if not COMMIT.fullmatch(revision):
        raise HoldoutError(
            f"the bridge reports revision {revision!r}, not a commit: the holdout measures committed code only —"
            " commit the changes, rebuild the bridge (pnpm eval:build) and run again"
        )
    path = repo / JOURNAL
    entries = _entries(path)

    def matches(entry: dict[str, Any]) -> bool:
        given = entry.get("product_revision")
        return (
            entry.get("dataset_id") == dataset_id
            and entry.get("mode") == mode
            and isinstance(given, str)
            and len(given) >= MIN_REVISION
            and revision.startswith(given)
            and entry.get("date") == today.isoformat()
            and bool(entry.get("by"))
            and bool(entry.get("purpose"))
        )

    found = [index for index, entry in enumerate(entries) if matches(entry)]
    if not found:
        raise HoldoutError(
            f"{path} has no entry for this run on the holdout: add "
            + json.dumps(
                {
                    "dataset_id": dataset_id,
                    "mode": mode,
                    "product_revision": revision[:MIN_REVISION],
                    "date": today.isoformat(),
                    "by": "<who runs it>",
                    "purpose": "<why the holdout, not dev>",
                    "report": None,
                    "seen": None,
                },
                ensure_ascii=False,
            )
            + " before the run and commit it with the report after"
        )
    index = found[-1]
    entry = entries[index]
    return Access(
        index=index,
        by=str(entry["by"]),
        purpose=str(entry["purpose"]),
        looks_at_dataset=sum(e.get("dataset_id") == dataset_id for e in entries),
    )
