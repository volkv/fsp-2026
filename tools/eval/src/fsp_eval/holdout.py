"""The journal of the holdout: every look at the holdout part of a dataset, written down before the run.

A holdout measures a product nobody tuned on it only while nobody has seen its numbers. Each run on it shows them to
whoever runs it, so the number of looks is part of the result: the journal (`reports/holdout/journal.json`, kept with
the code) lists them — dataset, mode, product revision, date, who and why, then the report and what it showed. A run on
the holdout is refused unless the journal already holds its entry: dataset and mode of the run, the revision the bridge
reports, today's date (UTC), who and why. The entry is written first and committed with the report after the run.
The revision must name a commit and nothing else: a bridge built from a checkout with uncommitted changes reports its
commit with `-dirty` (src/eval/bundle.config.ts), and the holdout is not looked at with code no commit holds.

A holdout is opened once: one revision, one run of each mode on it. A second look in a mode, a look at another
revision, or a look at a dataset the journal names in `status` (seen, withdrawn) is refused — its numbers would no
longer be an independent measure; the next one is a new dataset.
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


def _journal(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not path.is_file():
        raise HoldoutError(f"no holdout journal {path}: a run on the holdout is written into it first")
    content = json.loads(path.read_text(encoding="utf-8"))
    entries = content.get("accesses") if isinstance(content, dict) else None
    if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
        raise HoldoutError(f"{path}: `accesses` must be a list of entries")
    status = content.get("status", {})
    if not isinstance(status, dict):
        raise HoldoutError(f"{path}: `status` must map datasets to what happened to their holdout")
    return status, entries


def registered_access(repo: Path, *, dataset_id: str, mode: str, revision: str, today: date) -> Access:
    """The journal entry of this run on the holdout, or `HoldoutError` naming what the entry must say."""
    if not COMMIT.fullmatch(revision):
        raise HoldoutError(
            f"the bridge reports revision {revision!r}, not a commit: the holdout measures committed code only —"
            " commit the changes, rebuild the bridge (pnpm eval:build) and run again"
        )
    path = repo / JOURNAL
    status, entries = _journal(path)
    if dataset_id in status:
        raise HoldoutError(
            f"the holdout of {dataset_id} is no independent measure any more ({status[dataset_id]}): a new dataset is"
        )

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
    for other, earlier in enumerate(entries):
        if other == index or earlier.get("dataset_id") != dataset_id:
            continue
        if earlier.get("mode") == mode:
            raise HoldoutError(
                f"the holdout of {dataset_id} was looked at in mode {mode} already (entry {other}): it is opened once"
            )
        given = earlier.get("product_revision")
        if not (isinstance(given, str) and revision.startswith(given)):
            raise HoldoutError(
                f"the holdout of {dataset_id} was opened at revision {given} (entry {other}): it is opened once, at"
                " one revision"
            )
    return Access(
        index=index,
        by=str(entry["by"]),
        purpose=str(entry["purpose"]),
        looks_at_dataset=sum(e.get("dataset_id") == dataset_id for e in entries),
    )
