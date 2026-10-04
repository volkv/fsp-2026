"""Resolves the language set at image build: runs each `versionCommand` and writes the version next to the commands.

The result is the file programs see at /etc/sandbox/languages.json; the application reads it from there, so the
language set and the toolchain versions always describe the image that runs the code.
"""

import json
import re
import subprocess
import sys

VERSION = re.compile(r"\d+(?:\.\d+)+")


def resolve_version(command: list[str]) -> str:
    completed = subprocess.run(command, capture_output=True, text=True, check=True)
    match = VERSION.search(completed.stdout + completed.stderr)
    if match is None:
        raise SystemExit(f"no version in the output of {command}")
    return match.group(0)


def main(source: str, target: str) -> None:
    with open(source, encoding="utf-8") as handle:
        config = json.load(handle)
    keys = [language["key"] for language in config["languages"]]
    if len(keys) != len(set(keys)):
        raise SystemExit(f"duplicate language keys in {source}")
    for language in config["languages"]:
        language["version"] = resolve_version(language.pop("versionCommand"))
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=1)
        handle.write("\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
