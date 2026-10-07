// Kotlin items: the generator models the semantics of the shown program (null safety, collections, scope functions,
// coroutines) and computes the answer itself; the gate proves the answer with the Kotlin compiler and the JVM of the
// sandbox image. Compiling one Kotlin program costs seconds — more than the time limit of one run of the gate's Python
// harness — so the shown programs are not compiled inside it: the gate takes the probe of an instance from
// `reference()`, and that call compiles and runs the program with the image's `kotlinc` and `java`
// (`kotlin_batch.py`, one container), then hands the gate a probe that prints what the JVM printed. The comparison with
// the model's answer is the gate's own, as with every other probe.
//
// Batches. A gate run builds every sample of a family first and then asks for their probes in the same order, so the
// programs are registered when an instance is built (held weakly: an instance nobody keeps costs nothing) and the
// first probe that has no output yet runs the programs registered from it on, up to `BATCH` of them, in one
// container: one compiler start for hundreds of programs. Programs built after the samples (the gate's extra seeds
// that are only generated) may ride along in the last batch of a family; their outputs are simply never asked for.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReferenceProbe } from './family.ts';

const SANDBOX_DIR = fileURLToPath(new URL('../../../services/sandbox', import.meta.url));
const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));
/** Programs of one container run. */
const BATCH = 1200;
/** Compiler and runner groups inside the container, each on its own processor. */
const WORKERS = 3;
/** Time limit of one program on the JVM. */
const RUN_SECONDS = 60;
/** Registrations between two prunings of the registry. */
const PRUNE_EVERY = 4096;

/** What the JVM printed for a program, or why it did not run to the end. */
export interface KotlinOutput {
	stdout: string;
	error: string | null;
}

/** A Kotlin program (a whole `Main.kt` with `fun main()`) whose output the gate needs. */
export class KotlinProgram {
	readonly source: string;
	output: KotlinOutput | null = null;

	constructor(source: string) {
		this.source = source;
	}
}

const registry: WeakRef<KotlinProgram>[] = [];
let sincePrune = 0;

/** A program registered for the next batch; build it when the instance is built, run it only through a probe. */
export function kotlinProgram(source: string): KotlinProgram {
	const program = new KotlinProgram(source);
	registry.push(new WeakRef(program));
	sincePrune += 1;
	if (sincePrune >= PRUNE_EVERY) {
		sincePrune = 0;
		let kept = 0;
		for (const ref of registry) {
			const live = ref.deref();
			if (live && live.output === null) registry[kept++] = ref;
		}
		registry.length = kept;
	}
	return program;
}

/** The tag of the sandbox image built from the current sources of `services/sandbox`. */
function imageTag(): string {
	const hash = createHash('sha256');
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else hash.update(path.slice(SANDBOX_DIR.length)).update('\0').update(readFileSync(path)).update('\0');
		}
	};
	walk(SANDBOX_DIR);
	return `fsp-sandbox:kotlin-${hash.digest('hex').slice(0, 12)}`;
}

let image: string | null = null;

function ensureImage(): string {
	if (image !== null) return image;
	const tag = imageTag();
	// Built once per change of the sandbox sources; a missing image is built here, a broken Docker fails the build.
	if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status !== 0)
		execFileSync('docker', ['build', '--quiet', '--tag', tag, SANDBOX_DIR], { stdio: ['ignore', 'ignore', 'inherit'] });
	image = tag;
	return tag;
}

/** Compiles and runs programs in one container of the sandbox image; outputs in the order of the programs. */
export function runKotlin(sources: readonly string[]): KotlinOutput[] {
	if (sources.length === 0) return [];
	const stdout = execFileSync(
		'docker',
		[
			'run',
			'--rm',
			'-i',
			'--network',
			'none',
			'--cpus',
			String(WORKERS),
			'--memory',
			'5g',
			'--entrypoint',
			'python3',
			'-v',
			`${LIB_DIR}:/k:ro`,
			ensureImage(),
			'-I',
			'/k/kotlin_batch.py'
		],
		{
			input: JSON.stringify({ programs: sources, workers: WORKERS, seconds: RUN_SECONDS }),
			maxBuffer: 1 << 30,
			stdio: ['pipe', 'pipe', 'inherit']
		}
	).toString('utf8');
	const outputs = JSON.parse(stdout) as KotlinOutput[];
	if (outputs.length !== sources.length)
		throw new Error(`kotlin batch: ${outputs.length} of ${sources.length} outputs`);
	return outputs;
}

/** The output of a registered program: runs it together with the programs registered after it that have no output. */
function outputOf(program: KotlinProgram): KotlinOutput {
	if (program.output) return program.output;
	let at = registry.findIndex((ref) => ref.deref() === program);
	if (at === -1) {
		registry.push(new WeakRef(program));
		at = registry.length - 1;
	}
	const batch: KotlinProgram[] = [];
	const bySource = new Map<string, KotlinProgram[]>();
	for (let i = at; i < registry.length && bySource.size < BATCH; i += 1) {
		const live = registry[i]?.deref();
		if (!live || live.output !== null) continue;
		const same = bySource.get(live.source);
		if (same) same.push(live);
		else {
			bySource.set(live.source, [live]);
			batch.push(live);
		}
	}
	const outputs = runKotlin(batch.map((p) => p.source));
	batch.forEach((p, i) => {
		const output = outputs[i] as KotlinOutput;
		for (const same of bySource.get(p.source) ?? []) same.output = output;
	});
	let kept = 0;
	for (const ref of registry) {
		const live = ref.deref();
		if (live && live.output === null) registry[kept++] = ref;
	}
	registry.length = kept;
	return program.output as unknown as KotlinOutput;
}

const passes = (output: KotlinOutput): boolean =>
	output.error === null && output.stdout.trim().split('\n').at(-1)?.trim() === 'ok';

/** A variant of a defect program that does not compile proves nothing: every variant must compile. */
const compiles = (output: KotlinOutput): boolean => !output.error?.startsWith('compile error');

/** A Python probe that prints a text or fails with a reason. */
function printingProbe(result: { text: string } | { failure: string }): ReferenceProbe {
	return {
		kind: 'output',
		stdin: '',
		source: [
			'# What the JVM of the sandbox image printed for the shown program, compiled by its kotlinc.',
			'import json',
			'import sys',
			'text = json.loads(' + JSON.stringify(JSON.stringify('text' in result ? result.text : '')) + ')',
			...('failure' in result ? [`raise AssertionError(${JSON.stringify(result.failure)})`] : []),
			'sys.stdout.write(text)'
		].join('\n')
	};
}

/**
 * The probe of a trace: the shown program, compiled and run on the JVM; the gate reads what it printed as the answer.
 * The program must finish without an exception; its own failure is a failure of the reference.
 */
export function kotlinOutputProbe(program: KotlinProgram): ReferenceProbe {
	const output = outputOf(program);
	return output.error === null
		? printingProbe({ text: output.stdout })
		: printingProbe({ failure: `kotlin: ${output.error}` });
}

/** The shown program with one line (1-based) replaced. */
export function replaceKotlinLine(source: string, line: number, replacement: string): string {
	const lines = source.split('\n');
	if (line < 1 || line > lines.length) throw new Error(`line ${line} is outside a program of ${lines.length} lines`);
	lines[line - 1] = replacement;
	return lines.join('\n');
}

/**
 * A defect of a shown Kotlin program: the program is declarations without `main`; `check` is Kotlin appended after it
 * — a `fun main()` that runs the checks of the specification and prints `ok` as its last line when all of them hold.
 */
export interface KotlinDefect {
	source: string;
	check: string;
	line: number;
	fix: string;
	/** A wrong line the misconception names with the change it makes there: the program stays wrong. */
	distractors: readonly { line: number; replacement: string }[];
}

/** The programs of a defect probe, registered when the instance is built. */
export interface KotlinDefectRuns {
	defect: KotlinDefect;
	buggy: KotlinProgram;
	fixed: KotlinProgram;
	distractors: readonly KotlinProgram[];
}

export function kotlinDefectRuns(defect: KotlinDefect): KotlinDefectRuns {
	if (defect.distractors.some((d) => d.line === defect.line)) throw new Error('a distractor on the defect line');
	const variant = (text: string): KotlinProgram => kotlinProgram(`${text}\n${defect.check}`);
	return {
		defect,
		buggy: variant(defect.source),
		fixed: variant(replaceKotlinLine(defect.source, defect.line, defect.fix)),
		distractors: defect.distractors.map((d) => variant(replaceKotlinLine(defect.source, d.line, d.replacement)))
	};
}

/**
 * The probe of a defect line (`bug_locate` with `line_no`): the program with the checks fails, with the defect line
 * fixed it passes, and changing any of the distractor lines does not repair it. When all of that holds the probe prints
 * the defect line, and the gate compares it with the answer; otherwise it fails with the reason.
 */
export function kotlinDefectProbe(runs: KotlinDefectRuns): ReferenceProbe {
	const { defect } = runs;
	const buggy = outputOf(runs.buggy);
	const variants = [runs.buggy, runs.fixed, ...runs.distractors].map(outputOf);
	const broken = variants.find((output) => !compiles(output));
	if (broken) return printingProbe({ failure: `a variant of the program does not compile: ${broken.error ?? ''}` });
	if (passes(buggy)) return printingProbe({ failure: 'the program with the defect passes its checks' });
	const fixed = outputOf(runs.fixed);
	if (!passes(fixed))
		return printingProbe({
			failure: `the program with line ${defect.line} fixed fails its checks: ${fixed.error ?? fixed.stdout.slice(-300)}`
		});
	for (const [i, program] of runs.distractors.entries()) {
		if (passes(outputOf(program)))
			return printingProbe({
				failure: `the program with line ${defect.distractors[i]?.line ?? 0} changed instead passes its checks`
			});
	}
	return printingProbe({ text: `${defect.line}\n` });
}
