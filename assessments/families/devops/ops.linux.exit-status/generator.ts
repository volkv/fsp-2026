// Exit statuses in bash: `&&`/`||` lists, `$?` after a pipeline, `!`, subshells, functions, `set -e` with its
// exceptions, `set -o pipefail` and `PIPESTATUS`. The script is built as a small tree, printed as bash and evaluated by
// an interpreter of exactly those rules; a misconception is the same interpreter with one rule read wrong. The gate runs
// the printed script with the real bash of the sandbox image and appends its exit status as the last line.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';
import { bashProbe } from '../../_lib/shell.ts';

const descriptor = readDescriptor(import.meta.url);

type Node =
	| { t: 'true' }
	| { t: 'false' }
	/** `( exit n )` */
	| { t: 'sub'; n: number }
	| { t: 'echo'; text: string }
	/** `echo "<label> $?"` */
	| { t: 'rc'; label: string }
	/** `echo "<label> ${PIPESTATUS[@]}"` */
	| { t: 'pipestatus'; label: string }
	| { t: 'call'; name: string }
	| { t: 'not'; c: Node }
	| { t: 'pipe'; cs: Node[] }
	| { t: 'list'; cs: Node[]; ops: ('&&' | '||')[] }
	| { t: 'if'; cond: Node; then: Node[]; else: Node[] }
	/** `[local |export ]<name>=$(<cmd>)` */
	| { t: 'assign'; name: string; cmd: Node; kw: '' | 'local' | 'export' }
	| { t: 'sete' }
	| { t: 'pipefail' }
	| { t: 'return'; n: number };

interface Fn {
	name: string;
	body: Node[];
}

/** One rule read wrong; the interpreter with no flag is bash. */
interface Reading {
	andTighter?: boolean;
	skipRestOnFail?: boolean;
	pipeFirst?: boolean;
	pipeAny?: boolean;
	notIgnored?: boolean;
	subshellExitEnds?: boolean;
	echoKeepsStatus?: boolean;
	funcStatusZero?: boolean;
	seteIgnored?: boolean;
	seteInList?: boolean;
	seteInIf?: boolean;
	seteInCondFunction?: boolean;
	setePipeAny?: boolean;
	pipefailLeftmost?: boolean;
	pipefailIgnored?: boolean;
	pipefailMax?: boolean;
	pipestatusPersists?: boolean;
	pipestatusNegated?: boolean;
	localKeepsStatus?: boolean;
	assignZero?: boolean;
}

// ----- Printing -----------------------------------------------------------------------------------------------

function show(n: Node): string {
	switch (n.t) {
		case 'true':
		case 'false':
			return n.t;
		case 'sub':
			return `( exit ${n.n} )`;
		case 'echo':
			return `echo ${n.text}`;
		case 'rc':
			return `echo "${n.label} $?"`;
		case 'pipestatus':
			return `echo "${n.label} \${PIPESTATUS[@]}"`;
		case 'call':
			return n.name;
		case 'not':
			return `! ${show(n.c)}`;
		case 'pipe':
			return n.cs.map(show).join(' | ');
		case 'list':
			return n.cs.map((c, i) => (i === 0 ? show(c) : `${n.ops[i - 1]} ${show(c)}`)).join(' ');
		case 'if':
			return `if ${show(n.cond)}; then ${n.then.map(show).join('; ')};${n.else.length ? ` else ${n.else.map(show).join('; ')};` : ''} fi`;
		case 'assign':
			// A subshell inside `$( )` is written without its parentheses: `$((` would start arithmetic.
			return `${n.kw ? `${n.kw} ` : ''}${n.name}=$(${n.cmd.t === 'sub' ? `exit ${n.cmd.n}` : show(n.cmd)})`;
		case 'sete':
			return 'set -e';
		case 'pipefail':
			return 'set -o pipefail';
		case 'return':
			return `return ${n.n}`;
	}
}

function render(fns: readonly Fn[], main: readonly Node[]): string {
	const lines: string[] = [];
	for (const fn of fns) lines.push(`${fn.name}() {`, ...fn.body.map((b) => `\t${show(b)}`), '}');
	lines.push(...main.map(show));
	return lines.join('\n');
}

// ----- Interpreting -------------------------------------------------------------------------------------------

/** The script ends with a code (`exit`, `set -e`). */
class Exit extends Error {
	readonly code: number;
	constructor(code: number) {
		super(`exit ${code}`);
		this.code = code;
	}
}

/** A function returns with a code. */
class Return extends Error {
	readonly code: number;
	constructor(code: number) {
		super(`return ${code}`);
		this.code = code;
	}
}

/** Runs the script under a reading: the printed lines and the exit status. */
function interpret(fns: readonly Fn[], main: readonly Node[], r: Reading): string[] {
	const out: string[] = [];
	let status = 0;
	let pipestatus: number[] = [0];
	let errexit = false;
	let pipefail = false;

	const fail = (ignored: boolean) => {
		if (errexit && !r.seteIgnored && !ignored && status !== 0) throw new Exit(status);
	};

	/** A command in a context where `set -e` is ignored (`ignored`); `checked` — whether this node itself is checked. */
	function exec(n: Node, ignored: boolean): void {
		switch (n.t) {
			case 'true':
			case 'false':
				status = n.t === 'true' ? 0 : 1;
				pipestatus = [status];
				fail(ignored);
				return;
			case 'sub':
				status = n.n;
				pipestatus = [status];
				if (r.subshellExitEnds) throw new Exit(status);
				fail(ignored);
				return;
			case 'echo':
				out.push(n.text);
				if (!r.echoKeepsStatus) status = 0;
				if (!r.pipestatusPersists) pipestatus = [0];
				return;
			case 'rc':
				out.push(`${n.label} ${status}`);
				if (!r.echoKeepsStatus) status = 0;
				if (!r.pipestatusPersists) pipestatus = [0];
				return;
			case 'pipestatus':
				out.push(`${n.label} ${pipestatus.join(' ')}`);
				status = 0;
				if (!r.pipestatusPersists) pipestatus = [0];
				return;
			case 'call': {
				const fn = fns.find((f) => f.name === n.name);
				if (!fn) throw new Error(`no function ${n.name}`);
				const inner = ignored && !r.seteInCondFunction;
				let code: number | null = null;
				try {
					for (const b of fn.body) exec(b, inner);
				} catch (e) {
					if (!(e instanceof Return)) throw e;
					code = e.code;
				}
				status = code ?? (r.funcStatusZero ? 0 : status);
				pipestatus = [status];
				fail(ignored);
				return;
			}
			case 'return':
				status = n.n;
				throw new Return(n.n);
			case 'not': {
				exec(n.c, !r.notIgnored);
				const raw = pipestatus;
				status = status === 0 ? 1 : 0;
				pipestatus = r.pipestatusNegated ? raw.map((s) => (s === 0 ? 1 : 0)) : raw;
				fail(ignored || !r.notIgnored);
				return;
			}
			case 'pipe': {
				// Every member runs in its own subshell: `set -e` inside a member never ends the script.
				const codes = n.cs.map((c) => {
					if (c.t === 'true') return 0;
					if (c.t === 'false') return 1;
					if (c.t === 'sub') return c.n;
					throw new Error(`pipeline member ${c.t}`);
				});
				pipestatus = codes;
				const last = codes[codes.length - 1] ?? 0;
				const nonzero = codes.filter((c) => c !== 0);
				if (pipefail && !r.pipefailIgnored) {
					if (r.pipefailLeftmost) status = nonzero[0] ?? 0;
					else if (r.pipefailMax) status = Math.max(0, ...codes);
					else status = nonzero[nonzero.length - 1] ?? 0;
				} else if (r.pipeFirst) status = codes[0] ?? 0;
				else if (r.pipeAny) status = nonzero[nonzero.length - 1] ?? 0;
				else status = last;
				const anyFailed = r.setePipeAny && nonzero.length > 0;
				if (anyFailed && errexit && !ignored && !r.seteIgnored) throw new Exit(nonzero[nonzero.length - 1] ?? 1);
				fail(ignored);
				return;
			}
			case 'list': {
				if (r.andTighter) {
					// C-like precedence: groups joined by `&&` first, then `||` between the groups.
					const groups: Node[][] = [[n.cs[0] as Node]];
					n.ops.forEach((op, i) => {
						const c = n.cs[i + 1] as Node;
						if (op === '&&') groups[groups.length - 1]?.push(c);
						else groups.push([c]);
					});
					for (let g = 0; g < groups.length; g += 1) {
						const group = groups[g] ?? [];
						for (let i = 0; i < group.length; i += 1) {
							const last = g === groups.length - 1 && i === group.length - 1;
							exec(group[i] as Node, ignored || !last);
							if (status !== 0) break;
						}
						if (status === 0) return;
					}
					return;
				}
				exec(n.cs[0] as Node, ignored || (!r.seteInList && n.cs.length > 1));
				for (let i = 1; i < n.cs.length; i += 1) {
					const op = n.ops[i - 1];
					const run = op === '&&' ? status === 0 : status !== 0;
					if (!run) {
						if (r.skipRestOnFail && op === '&&') return;
						continue;
					}
					exec(n.cs[i] as Node, ignored || (!r.seteInList && i < n.cs.length - 1));
				}
				return;
			}
			case 'if': {
				exec(n.cond, !r.seteInIf);
				const branch = status === 0 ? n.then : n.else;
				if (branch.length === 0) {
					status = 0;
					return;
				}
				for (const b of branch) exec(b, ignored);
				return;
			}
			case 'assign': {
				exec(n.cmd, true);
				const inner = status;
				status = n.kw === '' ? (r.assignZero ? 0 : inner) : r.localKeepsStatus ? inner : 0;
				pipestatus = [status];
				fail(ignored);
				return;
			}
			case 'sete':
				errexit = true;
				status = 0;
				return;
			case 'pipefail':
				pipefail = true;
				status = 0;
				return;
		}
	}

	let code: number;
	try {
		for (const n of main) exec(n, false);
		code = status;
	} catch (e) {
		if (!(e instanceof Exit)) throw e;
		code = e.code;
	}
	return [...out, `exit ${code}`];
}

// ----- Scenarios ----------------------------------------------------------------------------------------------

const WORDS = ['alpha', 'bravo', 'delta', 'mike', 'golf', 'hotel', 'kilo', 'lima', 'oscar', 'tango', 'zulu'] as const;
const FN_NAMES = ['check', 'probe', 'verify', 'deploy', 'sync', 'cleanup', 'fetch', 'rotate'] as const;

interface Scenario {
	fns: Fn[];
	main: Node[];
	readings: Record<string, Reading>;
}

const T: Node = { t: 'true' };
const F: Node = { t: 'false' };
const bool = (rng: Rng): Node => (rng.bool() ? T : F);
const sub = (rng: Rng): Node => ({ t: 'sub', n: rng.int(2, 9) });
const simple = (rng: Rng): Node => (rng.bool(0.25) ? sub(rng) : bool(rng));

/** Labels in order, drawn once per instance. */
function labels(rng: Rng): () => string {
	const pool = rng.shuffle(WORDS);
	let i = 0;
	return () => pool[i++ % pool.length] ?? 'x';
}

function andOr(rng: Rng): Scenario {
	const next = labels(rng);
	const main: Node[] = [];
	for (let i = 0; i < rng.int(3, 4); i += 1) {
		const len = rng.int(2, 3);
		const ops = Array.from({ length: len }, () => rng.pick(['&&', '||'] as const));
		const cs: Node[] = [simple(rng), ...ops.map((): Node => ({ t: 'echo', text: next() }))];
		// Mixed operators make precedence matter.
		if (ops.every((o) => o === ops[0])) ops[ops.length - 1] = ops[0] === '&&' ? '||' : '&&';
		main.push({ t: 'list', cs, ops });
	}
	main.push({ t: 'list', cs: [simple(rng), { t: 'echo', text: next() }], ops: [rng.pick(['&&', '||'] as const)] });
	return {
		fns: [],
		main,
		readings: { 'and-binds-tighter': { andTighter: true }, 'fail-skips-line': { skipRestOnFail: true } }
	};
}

function pipelines(rng: Rng): Scenario {
	const next = labels(rng);
	const main: Node[] = [];
	for (let i = 0; i < rng.int(3, 4); i += 1) {
		const cs = Array.from({ length: rng.int(2, 3) }, () => simple(rng));
		const pipe: Node = { t: 'pipe', cs };
		main.push(rng.bool(0.3) ? { t: 'not', c: pipe } : pipe, { t: 'rc', label: next() });
	}
	main.push({ t: 'pipe', cs: [simple(rng), simple(rng)] });
	return {
		fns: [],
		main,
		readings: {
			'pipe-first-status': { pipeFirst: true },
			'pipe-any-failure': { pipeAny: true },
			'echo-keeps-status': { echoKeepsStatus: true }
		}
	};
}

function functionsSubshell(rng: Rng): Scenario {
	const next = labels(rng);
	const [f1, f2] = rng.sample(FN_NAMES, 2) as [string, string];
	const fns: Fn[] = [
		{
			name: f1,
			body: [
				{ t: 'echo', text: next() },
				{ t: 'return', n: rng.int(2, 9) }
			]
		},
		// No `return`: the status of the last command.
		{ name: f2, body: [simple(rng), F] }
	];
	const main: Node[] = rng
		.shuffle([
			[
				{ t: 'call', name: f1 },
				{ t: 'rc', label: next() }
			] as Node[],
			[
				{ t: 'call', name: f2 },
				{ t: 'rc', label: next() }
			] as Node[],
			// `( exit N )` does not end the script, and the `echo` after it resets `$?`.
			[sub(rng), { t: 'echo', text: next() }, { t: 'rc', label: next() }] as Node[]
		])
		.flat();
	main.push(rng.pick([{ t: 'call', name: f1 }, sub(rng)] as Node[]));
	return {
		fns,
		main,
		readings: {
			'subshell-exit-ends-script': { subshellExitEnds: true },
			'echo-keeps-status': { echoKeepsStatus: true },
			'function-status-zero': { funcStatusZero: true }
		}
	};
}

function seteBasic(rng: Rng): Scenario {
	const next = labels(rng);
	const main: Node[] = [{ t: 'sete' }, { t: 'echo', text: next() }];
	const safe = rng.shuffle<Node>([
		{ t: 'list', cs: [F, { t: 'echo', text: next() }], ops: ['||'] },
		{ t: 'if', cond: F, then: [{ t: 'echo', text: next() }], else: [{ t: 'echo', text: next() }] },
		{ t: 'list', cs: [F, { t: 'echo', text: next() }], ops: ['&&'] }
	]);
	main.push(...safe.slice(0, 2), { t: 'echo', text: next() }, sub(rng), { t: 'echo', text: next() });
	return {
		fns: [],
		main,
		readings: {
			'set-e-ignored': { seteIgnored: true },
			'set-e-exits-in-list': { seteInList: true },
			'set-e-exits-in-if': { seteInIf: true }
		}
	};
}

function seteExceptions(rng: Rng): Scenario {
	const next = labels(rng);
	const fn = rng.pick(FN_NAMES);
	const fns: Fn[] = [{ name: fn, body: [F, { t: 'echo', text: next() }, sub(rng)] }];
	const main: Node[] = [
		{ t: 'sete' },
		...rng
			.shuffle([
				[
					{
						t: 'if',
						cond: { t: 'call', name: fn },
						then: [{ t: 'echo', text: next() }],
						else: [{ t: 'echo', text: next() }]
					}
				] as Node[],
				[
					{ t: 'list', cs: [F, { t: 'echo', text: next() }], ops: ['&&'] },
					{ t: 'rc', label: next() }
				] as Node[],
				[
					{ t: 'pipe', cs: [F, T] },
					{ t: 'echo', text: next() }
				] as Node[],
				[
					{ t: 'not', c: T },
					{ t: 'echo', text: next() }
				] as Node[]
			])
			.flat(),
		rng.pick([
			{ t: 'call', name: fn },
			{ t: 'pipe', cs: [T, sub(rng)] }
		] as Node[]),
		{ t: 'echo', text: next() }
	];
	return {
		fns,
		main,
		readings: {
			'set-e-exits-in-list': { seteInList: true },
			'set-e-in-condition-function': { seteInCondFunction: true },
			'set-e-pipeline-any': { setePipeAny: true },
			'set-e-exits-on-not': { notIgnored: true }
		}
	};
}

function pipefailRun(rng: Rng): Scenario {
	const next = labels(rng);
	const main: Node[] = [];
	if (rng.bool()) main.push({ t: 'pipe', cs: [sub(rng), T] }, { t: 'rc', label: next() });
	main.push({ t: 'pipefail' });
	for (let i = 0; i < rng.int(3, 4); i += 1) {
		const cs = Array.from({ length: rng.int(2, 4) }, () => (rng.bool(0.6) ? sub(rng) : bool(rng)));
		main.push({ t: 'pipe', cs }, { t: 'rc', label: next() });
	}
	main.push({ t: 'pipe', cs: [sub(rng), sub(rng), T] });
	return {
		fns: [],
		main,
		readings: {
			'pipefail-leftmost': { pipefailLeftmost: true },
			'pipefail-ignored': { pipefailIgnored: true },
			'pipefail-max': { pipefailMax: true }
		}
	};
}

function pipestatusRun(rng: Rng): Scenario {
	const next = labels(rng);
	const main: Node[] = [];
	const member = () => (rng.bool(0.5) ? sub(rng) : bool(rng));
	main.push({ t: 'pipe', cs: [member(), member(), member()] }, { t: 'pipestatus', label: next() });
	main.push({ t: 'pipestatus', label: next() });
	main.push({ t: 'not', c: { t: 'pipe', cs: [member(), member()] } }, { t: 'pipestatus', label: next() });
	main.push(sub(rng), { t: 'pipestatus', label: next() });
	main.push({ t: 'not', c: { t: 'pipe', cs: [member(), member()] } }, { t: 'rc', label: next() });
	main.push({ t: 'pipe', cs: [member(), member()] });
	return {
		fns: [],
		main,
		readings: {
			'pipestatus-persists': { pipestatusPersists: true },
			'pipestatus-negated': { pipestatusNegated: true },
			'pipe-first-status': { pipeFirst: true }
		}
	};
}

function localMasks(rng: Rng): Scenario {
	const next = labels(rng);
	const fn = rng.pick(FN_NAMES);
	const [v1, v2, v3, v4] = rng.sample(['out', 'res', 'ver', 'tag', 'msg', 'val', 'ret'], 4) as [
		string,
		string,
		string,
		string
	];
	const fns: Fn[] = [
		{
			name: fn,
			body: rng
				.shuffle([
					[
						{ t: 'assign', name: v1, cmd: sub(rng), kw: 'local' },
						{ t: 'rc', label: next() }
					] as Node[],
					[
						{ t: 'assign', name: v2, cmd: sub(rng), kw: '' },
						{ t: 'rc', label: next() }
					] as Node[]
				])
				.flat()
		}
	];
	const main: Node[] = [
		{ t: 'call', name: fn },
		{ t: 'rc', label: next() },
		{ t: 'assign', name: v3, cmd: sub(rng), kw: 'export' },
		{ t: 'rc', label: next() },
		{ t: 'assign', name: v4, cmd: sub(rng), kw: '' }
	];
	return {
		fns,
		main,
		readings: { 'local-keeps-status': { localKeepsStatus: true }, 'assignment-zero': { assignZero: true } }
	};
}

const MAKERS: Record<string, (rng: Rng) => Scenario> = {
	'and-or': andOr,
	pipeline: pipelines,
	'functions-subshell': functionsSubshell,
	'set-e-basic': seteBasic,
	'set-e-exceptions': seteExceptions,
	pipefail: pipefailRun,
	pipestatus: pipestatusRun,
	'local-masks': localMasks
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'and-or': ['and-binds-tighter', 'fail-skips-line'],
	pipeline: ['pipe-first-status', 'pipe-any-failure'],
	'functions-subshell': ['subshell-exit-ends-script', 'echo-keeps-status', 'function-status-zero'],
	'set-e-basic': ['set-e-ignored'],
	'set-e-exceptions': ['set-e-exits-in-list', 'set-e-in-condition-function'],
	pipefail: ['pipefail-leftmost', 'pipefail-ignored'],
	pipestatus: ['pipestatus-persists'],
	'local-masks': ['local-keeps-status', 'assignment-zero']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = MAKERS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.classId}`);
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const s = make(rng);
		const answer = interpret(s.fns, s.main, {});
		const key = JSON.stringify(answer);
		const wrong = Object.fromEntries(
			descriptor.wrongSolutions.map(({ id }) => {
				const reading = s.readings[id];
				const value = reading ? interpret(s.fns, s.main, reading) : null;
				return [id, value === null || JSON.stringify(value) === key ? null : value];
			})
		);
		const required = REQUIRED[input.classId] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const script = render(s.fns, s.main);
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					'Скрипт запущен как `bash script.sh` (GNU bash 5.2, параметры оболочки по умолчанию). Что он напечатает? Введите вывод построчно, а последней строкой — код завершения скрипта в виде `exit N` (слово `exit`, один пробел, число).',
					'',
					'Например:',
					'',
					'```',
					'alpha',
					'bravo 1',
					'exit 0',
					'```'
				].join('\n'),
				code: { language: 'shell', source: script }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => bashProbe({ script: `${script}\n`, exitStatus: true }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
