"""Healthy only when go-judge can build a sandbox and run a program in it, not merely answer HTTP."""

import json
import sys
import urllib.request

REQUEST = {
    "cmd": [
        {
            "args": ["/bin/true"],
            "env": ["PATH=/usr/bin:/bin"],
            "files": [{"content": ""}, {"name": "stdout", "max": 64}, {"name": "stderr", "max": 64}],
            "cpuLimit": 1_000_000_000,
            "clockLimit": 2_000_000_000,
            "memoryLimit": 64 << 20,
            "procLimit": 1,
        }
    ]
}

request = urllib.request.Request(
    "http://127.0.0.1:5050/run",
    data=json.dumps(REQUEST).encode(),
    headers={"content-type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=4) as response:
    results = json.load(response)
sys.exit(0 if results[0]["status"] == "Accepted" else 1)
