// JavaScript and TypeScript items: the generator models the semantics of the shown program (event loop, closures,
// coercion) and computes the answer itself; the gate proves the answer by running the shown program with Node of the
// sandbox image. The gate's programs are Python, so the probe is a small Python driver that writes the program to a
// file and runs `node` on it. Node runs with `--jitless`: the harness limits the address space of its workers, and
// only the interpreter fits there; the order of events, coercion and output are the same as with the JIT.
//
// TypeScript is erased by Node's own strip-only mode (`stripTypeScriptTypes`, the compile step of the sandbox's
// `typescript` language) when the probe is built: the erasure keeps every position, so line numbers stay the same.
import { stripTypeScriptTypes } from 'node:module';
import type { ReferenceProbe } from './family.ts';

/** A language of shown Node programs. */
export type NodeLanguage = 'javascript' | 'typescript';

/** The JavaScript Node runs for a shown program. */
function runnable(source: string, language: NodeLanguage): string {
	return language === 'typescript' ? stripTypeScriptTypes(source, { mode: 'strip' }) : source;
}

/** The Python helper that runs one JavaScript program with Node and returns its completed process. */
const PYTHON_RUN_NODE = [
	'import json',
	'import os',
	'import shutil',
	'import subprocess',
	'import sys',
	'import tempfile',
	'from concurrent.futures import ThreadPoolExecutor',
	'',
	"NODE = shutil.which('node')",
	'if NODE is None:',
	"    raise RuntimeError('node is not on PATH')",
	'',
	'def run_node(source):',
	'    with tempfile.TemporaryDirectory() as work:',
	"        path = os.path.join(work, 'main.js')",
	"        with open(path, 'w', encoding='utf-8') as f:",
	'            f.write(source)',
	"        return subprocess.run([NODE, '--jitless', path], cwd=work, capture_output=True, text=True, timeout=10)",
	''
];

/**
 * The probe of a trace: the gate runs the shown program with Node and reads its standard output as the answer. The
 * program must exit with 0; its own failure is a failure of the reference.
 */
export function nodeOutputProbe(source: string, language: NodeLanguage): ReferenceProbe {
	return {
		kind: 'output',
		stdin: '',
		source: [
			...PYTHON_RUN_NODE,
			`done = run_node(${JSON.stringify(runnable(source, language))})`,
			'if done.returncode != 0:',
			"    raise RuntimeError(f'node exit {done.returncode}: {done.stderr[-400:]}')",
			'sys.stdout.write(done.stdout)'
		].join('\n')
	};
}

/** The shown program with one line (1-based) replaced. */
export function replaceSourceLine(source: string, line: number, replacement: string): string {
	const lines = source.split('\n');
	if (line < 1 || line > lines.length) throw new Error(`line ${line} is outside a program of ${lines.length} lines`);
	lines[line - 1] = replacement;
	return lines.join('\n');
}

/** A defect of a shown Node program: its line, the fix of that line and the plausible wrong lines with their changes. */
export interface NodeDefect {
	source: string;
	language: NodeLanguage;
	/**
	 * JavaScript appended to the program: checks of the specification that print `ok` as the last line of the output
	 * when all of them hold (asynchronous checks print it when they settle).
	 */
	check: string;
	line: number;
	fix: string;
	/** A wrong line the misconception names with the change it makes there: the program stays wrong. */
	distractors: readonly { line: number; replacement: string }[];
}

/**
 * The probe of a defect line (`bug_locate` with `line_no`): the program with the checks fails, with the defect line
 * fixed it passes, and changing any of the distractor lines does not repair it. When all of that holds the driver
 * prints the defect line, and the gate compares it with the answer; otherwise it fails with the reason.
 */
export function nodeDefectProbe(defect: NodeDefect): ReferenceProbe {
	const { source, language, check, line, fix, distractors } = defect;
	if (distractors.some((d) => d.line === line)) throw new Error('a distractor on the defect line');
	const variant = (text: string): string => `${runnable(text, language)}\n${check}`;
	const runs = [
		{ label: 'the program with the defect', source: variant(source), passes: false },
		{
			label: `the program with line ${line} fixed`,
			source: variant(replaceSourceLine(source, line, fix)),
			passes: true
		},
		...distractors.map((d) => ({
			label: `the program with line ${d.line} changed instead`,
			source: variant(replaceSourceLine(source, d.line, d.replacement)),
			passes: false
		}))
	];
	return {
		kind: 'output',
		stdin: '',
		source: [
			...PYTHON_RUN_NODE,
			'def passes(source):',
			'    done = run_node(source)',
			"    lines = done.stdout.strip().split('\\n')",
			"    return done.returncode == 0 and lines[-1].strip() == 'ok'",
			'',
			`RUNS = json.loads(${JSON.stringify(JSON.stringify(runs.map((r) => [r.label, r.source, r.passes])))})`,
			'# The variants are independent programs: they run at once, so the probe fits the time limit of one gate run.',
			'with ThreadPoolExecutor(max_workers=len(RUNS)) as pool:',
			'    results = list(pool.map(lambda run: passes(run[1]), RUNS))',
			'for (label, _, expected), passed in zip(RUNS, results):',
			'    if passed != expected:',
			"        raise AssertionError(f\"{label} {'fails' if expected else 'passes'} its checks\")",
			`print(${line})`
		].join('\n')
	};
}
