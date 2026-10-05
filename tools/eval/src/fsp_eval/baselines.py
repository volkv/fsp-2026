"""Baselines the product is compared with, on the same inputs.

- skills in a resume: canonical skill names of the taxonomy looked up as whole words in the parsed text — no
  spellings, no fuzzy matching, no sections, no negation;
- normalization: a spelling equal to a canonical name (case aside) is that skill, anything else is not a skill;
"""

import json
import re
from pathlib import Path

from fsp_eval.lexicon import fold_spelling


def taxonomy_names(taxonomy_dir: Path) -> dict[str, str]:
    """Canonical name (case-folded) → skill key."""
    skills = json.loads((taxonomy_dir / "skills.json").read_text(encoding="utf-8"))["skills"]
    return {skill["name"].casefold(): skill["key"] for skill in skills}


def taxonomy_spellings(taxonomy_dir: Path) -> set[str]:
    """Every spelling the taxonomy knows — the canonical names and the aliases of its skills — folded. A spelling of the
    lexicon outside this set is one the taxonomy could not have been fitted to."""
    skills = json.loads((taxonomy_dir / "skills.json").read_text(encoding="utf-8"))["skills"]
    return {fold_spelling(spelling) for skill in skills for spelling in (skill["name"], *skill.get("aliases", []))}


class NameDictionary:
    def __init__(self, names: dict[str, str]) -> None:
        self._names = names
        # Longest names first, so «Spring Boot» is not read as «Spring»; a name is a whole word of the text.
        ordered = sorted(names, key=len, reverse=True)
        self._pattern = re.compile(
            "|".join(rf"(?<![\w+#.]){re.escape(name)}(?![\w+#])" for name in ordered), re.IGNORECASE
        )

    def skills_in(self, text: str) -> set[str]:
        return {self._names[match.group(0).casefold()] for match in self._pattern.finditer(text)}

    def normalize(self, surface: str) -> str | None:
        return self._names.get(surface.strip().casefold())
