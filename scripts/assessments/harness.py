"""Runs Python programs of the bank's gates in the runtime of the sandbox image.

`serve` reads one JSON request per line and answers one JSON line:
- {"op": "run", "programs": [str], "runs": [{"program": int, "stdin": str}], "seconds": float}
  -> {"outputs": [{"stdout": str, "error": str | null}]}, one output per run, in order
- {"op": "mutate", "source": str} -> {"mutants": [{"id": str, "description": str, "source": str}]}
- {"op": "version"} -> {"python": str, "sqlite": str}

Programs run in worker processes (`worker`), each in a fresh namespace with its own stdin and stdout, under a timer
and a memory limit; a worker that hangs past its budget is killed and its runs report `timeout`.
"""

import ast
import copy
import io
import json
import os
import platform
import resource
import signal
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

OUTPUT_LIMIT = 64 * 1024
CHUNK = 64
WORKERS = int(os.environ.get("GATE_WORKERS", "3"))


class RunTimeout(Exception):
    pass


def _alarm(_signum, _frame):
    raise RunTimeout()


def run_one(code, stdin, seconds):
    out = io.StringIO()
    namespace = {"__name__": "__main__", "__builtins__": __builtins__}
    old_in, old_out = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = io.StringIO(stdin), out
    error = None
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        exec(code, namespace)
    except RunTimeout:
        error = "timeout"
    except BaseException as exc:  # the program's own failure is a result, not a failure of the harness
        error = f"{type(exc).__name__}: {exc}"[:500]
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        sys.stdin, sys.stdout = old_in, old_out
    text = out.getvalue()
    if len(text) > OUTPUT_LIMIT:
        text = text[:OUTPUT_LIMIT]
        error = error or "output_limit"
    return {"stdout": text, "error": error}


def worker():
    resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
    signal.signal(signal.SIGALRM, _alarm)
    request = json.load(sys.stdin)
    compiled = {}
    results = []
    for run in request["runs"]:
        index = run["program"]
        if index not in compiled:
            try:
                compiled[index] = compile(request["programs"][index], "main.py", "exec")
            except SyntaxError as exc:
                compiled[index] = exc
        code = compiled[index]
        if isinstance(code, SyntaxError):
            results.append({"stdout": "", "error": f"SyntaxError: {code}"})
        else:
            results.append(run_one(code, run["stdin"], request["seconds"]))
    sys.__stdout__.write(json.dumps(results))


def run_chunk(programs, runs, seconds):
    budget = seconds * len(runs) + 10
    try:
        done = subprocess.run(
            [sys.executable, "-I", os.path.abspath(__file__), "worker"],
            input=json.dumps({"programs": programs, "runs": runs, "seconds": seconds}),
            capture_output=True,
            text=True,
            timeout=budget,
        )
    except subprocess.TimeoutExpired:
        if len(runs) == 1:
            return [{"stdout": "", "error": "timeout"}]
        return [r for run in runs for r in run_chunk(programs, [run], seconds)]
    if done.returncode != 0:
        if len(runs) == 1:
            return [{"stdout": "", "error": f"worker exit {done.returncode}: {done.stderr[-300:]}"}]
        return [r for run in runs for r in run_chunk(programs, [run], seconds)]
    return json.loads(done.stdout)


def localize(programs, runs):
    """A chunk carries only the programs its runs use."""
    used = sorted({run["program"] for run in runs})
    index = {old: new for new, old in enumerate(used)}
    return [programs[i] for i in used], [{"program": index[r["program"]], "stdin": r["stdin"]} for r in runs]


def run_all(programs, runs, seconds):
    chunks = [localize(programs, runs[i : i + CHUNK]) for i in range(0, len(runs), CHUNK)]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(lambda chunk: run_chunk(*chunk, seconds), chunks))
    return [r for chunk in results for r in chunk]


# Template mutants of a reference program: one operator changed at one place.
COMPARE_SWAPS = {
    ast.Lt: [ast.LtE, ast.GtE],
    ast.LtE: [ast.Lt, ast.Gt],
    ast.Gt: [ast.GtE, ast.LtE],
    ast.GtE: [ast.Gt, ast.Lt],
    ast.Eq: [ast.NotEq],
    ast.NotEq: [ast.Eq],
    ast.In: [ast.NotIn],
    ast.NotIn: [ast.In],
    ast.Is: [ast.IsNot],
    ast.IsNot: [ast.Is],
}
BINOP_SWAPS = {
    ast.Add: [ast.Sub],
    ast.Sub: [ast.Add],
    ast.Mult: [ast.Add],
    ast.FloorDiv: [ast.Mult],
    ast.Div: [ast.Mult],
    ast.Mod: [ast.FloorDiv],
}
NAME_SWAPS = {"min": "max", "max": "min"}


def mutation_sites(tree):
    sites = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            for i, op in enumerate(node.ops):
                for repl in COMPARE_SWAPS.get(type(op), []):
                    sites.append((node, "compare", i, repl))
        elif isinstance(node, (ast.BinOp, ast.AugAssign)):
            for repl in BINOP_SWAPS.get(type(node.op), []):
                sites.append((node, "binop", None, repl))
        elif isinstance(node, ast.BoolOp):
            sites.append((node, "boolop", None, ast.Or if isinstance(node.op, ast.And) else ast.And))
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            sites.append((node, "not", None, None))
        elif isinstance(node, ast.Constant) and type(node.value) is int:
            sites.append((node, "const", None, node.value + 1))
            sites.append((node, "const", None, node.value - 1))
        elif isinstance(node, ast.Name) and node.id in ("min", "max") and isinstance(node.ctx, ast.Load):
            sites.append((node, "name", None, NAME_SWAPS[node.id]))
        elif isinstance(node, ast.Constant) and type(node.value) is bool:
            sites.append((node, "const", None, not node.value))
        elif isinstance(node, (ast.Break, ast.Continue)):
            sites.append((node, "jump", None, None))
    return sites


class Replace(ast.NodeTransformer):
    def __init__(self, target, kind, index, repl):
        self.target, self.kind, self.index, self.repl = target, kind, index, repl

    def generic_visit(self, node):
        node = super().generic_visit(node)
        if node is not self.target:
            return node
        if self.kind == "compare":
            node.ops[self.index] = self.repl()
        elif self.kind == "binop":
            node.op = self.repl()
        elif self.kind == "boolop":
            node.op = self.repl()
        elif self.kind == "not":
            return node.operand
        elif self.kind == "const":
            node.value = self.repl
        elif self.kind == "name":
            node.id = self.repl
        elif self.kind == "jump":
            return ast.Pass()
        return node


def mutate(source):
    tree = ast.parse(source)
    count = len(mutation_sites(tree))
    mutants = []
    seen = {ast.unparse(tree)}
    for n in range(count):
        clone = copy.deepcopy(tree)
        node, kind, index, repl = mutation_sites(clone)[n]
        line = getattr(node, "lineno", 0)
        label = repl.__name__ if isinstance(repl, type) else repr(repl)
        mutated = ast.fix_missing_locations(Replace(node, kind, index, repl).visit(clone))
        text = ast.unparse(mutated)
        if text in seen:
            continue
        seen.add(text)
        mutants.append({"id": f"m{n}", "description": f"line {line}: {kind} -> {label}", "source": text})
    return mutants


def serve():
    for line in sys.stdin:
        request = json.loads(line)
        op = request["op"]
        if op == "run":
            response = {"outputs": run_all(request["programs"], request["runs"], request["seconds"])}
        elif op == "mutate":
            response = {"mutants": mutate(request["source"])}
        elif op == "version":
            response = {"python": platform.python_version(), "sqlite": sqlite3.sqlite_version}
        else:
            raise ValueError(f"unknown op {op}")
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "serve"
    {"serve": serve, "worker": worker}[mode]()
