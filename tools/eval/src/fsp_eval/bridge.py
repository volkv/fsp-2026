"""Client of the product's evaluation bridge (src/eval in the application): one Node process per request, JSON on stdin,
JSON on stdout. The bridge runs the product code of the checkout's build, so nothing measured here is a Python copy.
"""

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class BridgeError(Exception):
    pass


@dataclass(frozen=True)
class Bridge:
    """`node --env-file=<env> <repo>/.eval-build/main.js`."""

    repo: Path
    env_file: Path
    node: str = "node"
    timeout_s: float = 1800

    @property
    def script(self) -> Path:
        return self.repo / ".eval-build" / "main.js"

    def call(self, request: dict[str, Any]) -> Any:
        for path, what in ((self.script, "bridge build (pnpm eval:build)"), (self.env_file, "environment file")):
            if not path.is_file():
                raise BridgeError(f"{what} not found: {path}")
        completed = subprocess.run(
            [self.node, f"--env-file={self.env_file}", "--enable-source-maps", str(self.script)],
            input=json.dumps(request, ensure_ascii=False),
            capture_output=True,
            text=True,
            timeout=self.timeout_s,
            check=False,
            # The product reads its shipped references (`seeds/`) from the working directory: the checkout's root.
            cwd=self.repo,
        )
        if completed.returncode != 0:
            raise BridgeError(f"bridge {request['command']} failed ({completed.returncode}):\n{completed.stderr}")
        return json.loads(completed.stdout)
