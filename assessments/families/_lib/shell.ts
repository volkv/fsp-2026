// Shell items: the generator models what a script prints, and the gate script checks the model against the real tool —
// `bash` and the coreutils of the sandbox image run the shown script in a fresh directory holding the item's files.
// The run is pinned: `LC_ALL=C` (byte order in `sort`, ASCII classes), `TZ=UTC`, umask 022, `HOME` and the working
// directory in the temporary directory, a fixed `PATH`. Under the gate the script runs as root, so an item never
// depends on permission checks being enforced (`[ -w f ]`, a denied `cat`): modes are read with `stat`, not tested.

/** A file the script finds in its working directory: relative path, text, octal mode, modification time (UTC). */
export interface ShellFile {
	path: string;
	content: string;
	mode?: number;
	/** `YYYY-MM-DDTHH:MM:SSZ`. */
	mtime?: string;
}

export interface ShellRun {
	script: string;
	files?: readonly ShellFile[];
	/** Arguments of the script (`$1`, `$2`, …). */
	args?: readonly string[];
	stdin?: string;
	/** `merge` — standard error goes to the output too, interleaved as the script writes it; `drop` — discarded. */
	stderr?: 'merge' | 'drop';
	/** Append a last line `exit <code>` with the exit status of the script (killed by signal N — `128 + N`). */
	exitStatus?: boolean;
}

const PYTHON_RUNNER = `import calendar, json, os, subprocess, sys, tempfile, time

def run_script(spec):
    with tempfile.TemporaryDirectory() as root:
        work = os.path.join(root, "w")
        os.mkdir(work)
        for f in spec.get("files", []):
            path = os.path.join(work, f["path"])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="") as out:
                out.write(f["content"])
            if f.get("mode") is not None:
                os.chmod(path, f["mode"])
            if f.get("mtime") is not None:
                t = calendar.timegm(time.strptime(f["mtime"], "%Y-%m-%dT%H:%M:%SZ"))
                os.utime(path, (t, t))
        script = os.path.join(root, "script.sh")
        with open(script, "w", encoding="utf-8", newline="") as out:
            out.write(spec["script"])
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C", "TZ": "UTC", "HOME": work}
        merge = spec.get("stderr", "drop") == "merge"
        done = subprocess.run(
            ["bash", script, *spec.get("args", [])],
            cwd=work,
            env=env,
            input=spec.get("stdin", "").encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT if merge else subprocess.DEVNULL,
            preexec_fn=lambda: os.umask(0o022),
            timeout=5,
        )
        text = done.stdout.decode("utf-8", "replace")
        if spec.get("exitStatus"):
            if text and not text.endswith("\\n"):
                text += "\\n"
            # A script killed by a signal reports 128 + N, as a shell does; Python gives -N.
            code = done.returncode if done.returncode >= 0 else 128 - done.returncode
            text += "exit %d\\n" % code
        return text
`;

/**
 * A Python program for the gates (probe `output`): runs the script with real `bash` and prints exactly what it printed.
 * The run's description goes in on standard input as JSON.
 */
export function bashProbe(run: ShellRun): { kind: 'output'; source: string; stdin: string } {
	return {
		kind: 'output',
		source: `${PYTHON_RUNNER}\nsys.stdout.write(run_script(json.loads(sys.stdin.read())))\n`,
		stdin: JSON.stringify(run)
	};
}

/**
 * A Python program for the gates (probe `output`) of a shell `bug_locate` item: the shown script with its defect must
 * fail at least one case of the specification, and the script with line `line` replaced by `fix` must pass every
 * case; then the program prints `line`. Otherwise it prints why it did not, which never equals the expected line. Each
 * case is a run of the script with the output the specification demands (the generator's model computes it).
 */
export function bashBugProbe(
	source: string,
	line: number,
	fix: string,
	cases: readonly (Omit<ShellRun, 'script'> & { expected: string })[]
): { kind: 'output'; source: string; stdin: string } {
	const lines = source.split('\n');
	if (line < 1 || line > lines.length) throw new Error(`defect line ${line} is outside the script`);
	const fixed = lines.map((text, i) => (i === line - 1 ? fix : text)).join('\n');
	return {
		kind: 'output',
		source: `${PYTHON_RUNNER}
spec = json.loads(sys.stdin.read())

def passes(script):
    return [run_script({**case, "script": script}) == case["expected"] for case in spec["cases"]]

buggy = passes(spec["buggy"])
fixed = passes(spec["fixed"])
if all(buggy):
    print("the script with the defect passes every case")
elif not all(fixed):
    print("the fixed script fails cases %s" % [i for i, ok in enumerate(fixed) if not ok])
else:
    print(spec["line"])
`,
		stdin: JSON.stringify({ buggy: source, fixed, line, cases })
	};
}
