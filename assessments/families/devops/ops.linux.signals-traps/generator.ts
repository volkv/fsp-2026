// Signals and traps in bash: handlers on EXIT, ERR and signals the script sends to itself, `exit` inside a handler,
// subshells that reset caught signals but keep ignored ones, `wait` on a background job killed by a signal. Every
// signal is sent synchronously (`kill` to the script itself or to a subshell, then `wait`), so the output never depends
// on timing. The model writes out the output by the rules of bash; the gate runs the script with the bash of the
// sandbox image (standard error is discarded) and appends its exit status.
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

/** Signal numbers on Linux x86-64. */
const SIGNALS: Record<string, number> = { HUP: 1, USR1: 10, USR2: 12, ALRM: 14, TERM: 15, KILL: 9 };
const num = (sig: string): number => SIGNALS[sig] ?? 0;
const WORDS = [
	'alpha',
	'bravo',
	'delta',
	'kilo',
	'lima',
	'oscar',
	'tango',
	'zulu',
	'golf',
	'hotel',
	'mike',
	'papa',
	'sierra',
	'victor'
] as const;

interface Scenario {
	script: string[];
	answer: string[];
	wrong: Record<string, string[]>;
}

/** Labels for one instance, all distinct. */
function labels(rng: Rng): () => string {
	const pool = rng.shuffle(WORDS);
	let i = 0;
	return () => pool[i++] ?? `w${i}`;
}

// ----- Junior -----------------------------------------------------------------------------------------------

/** A handler runs and the script goes on; the handler's text is expanded when it runs; EXIT runs at the normal end. */
function trapContinue(rng: Rng): Scenario {
	const next = labels(rng);
	const [w1, w2, w3, w4, bye] = [next(), next(), next(), next(), next()];
	const sig = rng.pick(['USR1', 'USR2', 'HUP']);
	const [a, b] = rng.sample(['10', '20', '30', '40', '50', '60', '70'], 2) as [string, string];
	const reset = rng.bool();
	const script = [
		`trap 'echo "${bye}"' EXIT`,
		`n=${a}`,
		`trap 'echo "${w1} $n"' ${sig}`,
		`kill -${sig} $$`,
		`n=${b}`,
		`echo "${w2} $n"`,
		`kill -${sig} $$`,
		`trap 'echo "${w3}"' ${sig}`,
		`kill -${sig} $$`,
		...(reset ? ['trap - EXIT'] : []),
		`echo "${w4}"`
	];
	const body = (o: { atSet?: boolean; appends?: boolean }) => [
		`${w1} ${a}`,
		`${w2} ${b}`,
		`${w1} ${o.atSet ? a : b}`,
		...(o.appends ? [`${w1} ${o.atSet ? a : b}`] : []),
		w3,
		w4
	];
	const wrong: Record<string, string[]> = {
		'trap-expands-at-set': [...body({ atSet: true }), ...(reset ? [] : [bye]), 'exit 0'],
		'signal-ends-script': [`${w1} ${a}`, bye, `exit ${128 + num(sig)}`],
		'trap-replace-appends': [...body({ appends: true }), ...(reset ? [] : [bye]), 'exit 0']
	};
	if (reset) wrong['trap-reset-ignored'] = [...body({}), bye, 'exit 0'];
	else wrong['exit-trap-errors-only'] = [...body({}), 'exit 0'];
	return { script, answer: [...body({}), ...(reset ? [] : [bye]), 'exit 0'], wrong };
}

/** `exit` in a signal handler ends the script with its code; the EXIT trap still runs and sees that code in `$?`. */
function exitInHandler(rng: Rng): Scenario {
	const next = labels(rng);
	const [x1, x2, x3, x4] = [next(), next(), next(), next()];
	const sig = rng.pick(['TERM', 'USR1', 'HUP', 'ALRM']);
	const code = rng.int(2, 9);
	const override = rng.bool(0.4) ? rng.int(10, 40) : null;
	const script = [
		`trap 'echo "${x1} $?"${override === null ? '' : `; exit ${override}`}' EXIT`,
		`trap 'echo "${x2}"; exit ${code}' ${sig}`,
		`echo "${x3}"`,
		`kill -${sig} $$`,
		`echo "${x4}"`
	];
	const final = (status: number) => override ?? status;
	return {
		script,
		answer: [x3, x2, `${x1} ${code}`, `exit ${final(code)}`],
		wrong: {
			'exit-skips-exit-trap': [x3, x2, `exit ${code}`],
			'exit-trap-status-zero': [x3, x2, `${x1} 0`, `exit ${final(code)}`],
			'handler-exit-ignored': [x3, x2, x4, `${x1} 0`, `exit ${final(0)}`],
			'status-128-plus': [x3, x2, `${x1} ${128 + num(sig)}`, `exit ${final(128 + num(sig))}`]
		}
	};
}

/** A subshell resets caught signals to the default (and dies of them) but keeps ignored ones ignored. */
function subshellReset(rng: Rng): Scenario {
	const next = labels(rng);
	const [p1, s1, s2, r1, s3, r2, e] = [next(), next(), next(), next(), next(), next(), next()];
	const [caught, ignored] = rng.sample(['USR1', 'USR2', 'HUP', 'ALRM'], 2) as [string, string];
	const parts = [
		[`( echo "${s1}"; kill -${caught} $BASHPID; echo "${s2}" )`, `echo "${r1} $?"`],
		[`trap '' ${ignored}`, `( kill -${ignored} $BASHPID; echo "${s3}" )`, `echo "${r2} $?"`]
	];
	const swapped = rng.bool();
	const script = [
		`trap 'echo "${p1}"' ${caught}`,
		...(swapped ? [...(parts[1] ?? []), ...(parts[0] ?? [])] : [...(parts[0] ?? []), ...(parts[1] ?? [])]),
		`kill -${caught} $$`,
		`echo "${e}"`
	];
	const run = (o: { inherits?: boolean; ignoreReset?: boolean; plainNumber?: boolean }) => {
		const died = (sig: string) => (o.plainNumber ? num(sig) : 128 + num(sig));
		const first = o.inherits ? [s1, p1, s2, `${r1} 0`] : [s1, `${r1} ${died(caught)}`];
		const second = o.ignoreReset ? [`${r2} ${died(ignored)}`] : [s3, `${r2} 0`];
		return [...(swapped ? [...second, ...first] : [...first, ...second]), p1, e, 'exit 0'];
	};
	return {
		script,
		answer: run({}),
		wrong: {
			'subshell-inherits-trap': run({ inherits: true }),
			'ignore-reset-in-subshell': run({ ignoreReset: true }),
			'status-signal-number': run({ plainNumber: true })
		}
	};
}

/** `wait` on a background job killed by a signal returns 128 + its number; on a job that exited — its code. */
function waitKilled(rng: Rng): Scenario {
	const [s1, s2] = rng.sample(['TERM', 'HUP', 'USR1', 'USR2', 'ALRM', 'KILL'], 2) as [string, string];
	const code = rng.int(2, 9);
	const [a, b, c] = rng.sample(['web', 'db', 'cache', 'queue', 'cron', 'mail'], 3) as [string, string, string];
	const jobs = [
		{ name: a, start: `sleep 5 & ${a}=$!`, kill: `kill -${s1} $${a}`, status: (o: Reading) => died(s1, o) },
		{ name: b, start: `sleep 5 & ${b}=$!`, kill: `kill -${s2} $${b}`, status: (o: Reading) => died(s2, o) },
		{ name: c, start: `( exit ${code} ) & ${c}=$!`, kill: null, status: () => code }
	];
	const order = rng.shuffle(jobs);
	const [last, ...rest] = [order[order.length - 1], ...order.slice(0, -1)];
	const script = [
		...jobs.map((j) => j.start),
		...jobs.flatMap((j) => (j.kill ? [j.kill] : [])),
		...rest.map((j) => `wait $${j.name}; echo "${j.name} $?"`),
		`wait $${last?.name ?? ''}`
	];
	const run = (o: Reading) => [...rest.map((j) => `${j.name} ${j.status(o)}`), `exit ${last?.status(o) ?? 0}`];
	return {
		script,
		answer: run({}),
		wrong: {
			'status-signal-number': run({ plainNumber: true }),
			'wait-killed-zero': run({ zero: true })
		}
	};
}

interface Reading {
	plainNumber?: boolean;
	zero?: boolean;
}

function died(sig: string, o: Reading): number {
	if (o.zero) return 0;
	return o.plainNumber ? num(sig) : 128 + num(sig);
}

// ----- Middle -----------------------------------------------------------------------------------------------

/** ERR with `set -e`: no ERR and no exit in a condition; without `set -E` a function does not run the ERR trap. */
function errTrap(rng: Rng): Scenario {
	const next = labels(rng);
	const [f1, f2, ok, rec, err, ex, never] = [next(), next(), next(), next(), next(), next(), next()];
	const fn = rng.pick(['probe', 'check', 'verify', 'sync']);
	const errtrace = rng.bool(0.4);
	const finalSub = errtrace && rng.bool();
	const code = rng.int(2, 9);
	const script = [
		'set -e',
		...(errtrace ? ['set -E'] : []),
		`trap 'echo "${err}"' ERR`,
		`trap 'echo "${ex} $?"' EXIT`,
		`${fn}() { echo "${f1}"; false; echo "${f2}"; }`,
		`if ${fn}; then echo "${ok}"; fi`,
		`false || echo "${rec}"`,
		finalSub ? `( exit ${code} )` : fn,
		`echo "${never}"`
	];
	const status = finalSub ? code : 1;
	const run = (o: {
		errInFunctions?: boolean;
		errInCondition?: boolean;
		errexitInCondFn?: boolean;
		noExitTrap?: boolean;
	}) => {
		const fnErr = errtrace || o.errInFunctions;
		const cond = o.errexitInCondFn
			? [f1, ...(fnErr && o.errInCondition ? [err] : [])]
			: [f1, ...(fnErr && o.errInCondition ? [err] : []), f2, ok];
		if (o.errexitInCondFn) return [...cond, ...(o.noExitTrap ? [] : [`${ex} 1`]), 'exit 1'];
		const recovered = [...(o.errInCondition ? [err] : []), rec];
		const tail = finalSub ? [err] : [f1, ...(fnErr ? [err] : [])];
		return [...cond, ...recovered, ...tail, ...(o.noExitTrap ? [] : [`${ex} ${status}`]), `exit ${status}`];
	};
	return {
		script,
		answer: run({}),
		wrong: {
			'err-in-functions': run({ errInFunctions: true }),
			'err-in-condition': run({ errInCondition: true }),
			'errexit-in-condition-function': run({ errexitInCondFn: true }),
			'exit-trap-skipped-on-errexit': run({ noExitTrap: true })
		}
	};
}

/** Traps are global: an EXIT trap set in a function replaces the script's; `exit` in a function called from a handler ends the script; a handler runs right after `kill`. */
function nestedExit(rng: Rng): Scenario {
	const next = labels(rng);
	const [u, w1, w2, h, m] = [next(), next(), next(), next(), next()];
	const sig = rng.pick(['USR1', 'USR2', 'HUP']);
	const code = rng.int(2, 9);
	const innerLast = rng.bool();
	const script = [
		'cleanup() { echo "cleanup $1"; }',
		'stop() { echo "stop $1"; exit "$1"; }',
		`setup() { trap 'cleanup inner' EXIT; echo "${u}"; }`,
		`work() { echo "${w1}"; kill -${sig} $$; echo "${w2}"; }`,
		...(innerLast ? ["trap 'cleanup outer' EXIT", 'setup'] : ['setup', "trap 'cleanup outer' EXIT"]),
		`trap 'echo "${h}"; stop ${code}' ${sig}`,
		'work',
		`echo "${m}"`
	];
	const owner = (scoped: boolean) => (innerLast && !scoped ? 'cleanup inner' : 'cleanup outer');
	return {
		script,
		answer: [u, w1, h, `stop ${code}`, owner(false), `exit ${code}`],
		wrong: {
			'exit-trap-function-scoped': [u, w1, h, `stop ${code}`, owner(true), `exit ${code}`],
			'exit-in-function-returns': [u, w1, h, `stop ${code}`, w2, m, owner(false), 'exit 0'],
			'handler-deferred': [u, w1, w2, h, `stop ${code}`, owner(false), `exit ${code}`]
		}
	};
}

/** Subshells: their own EXIT trap runs when they exit, the parent's does not; `$(…)` captures its EXIT trap's output; `$$` in a subshell is the parent. */
function exitInSubshell(rng: Rng): Scenario {
	const next = labels(rng);
	const [pe, pu, se, s1, s2, s3, ce, v, end] = [next(), next(), next(), next(), next(), next(), next(), next(), next()];
	const [r1, r2, r3] = [next(), next(), next()];
	const sig = rng.pick(['USR1', 'USR2', 'HUP']);
	const [c1, c2] = [rng.int(2, 5), rng.int(6, 9)];
	const blocks = [
		{
			lines: [`( trap 'echo "${se}"' EXIT; echo "${s1}"; exit ${c1} ); echo "${r1} $?"`],
			out: () => [s1, se, `${r1} ${c1}`]
		},
		{
			lines: [`( echo "${s2}"; exit ${c2} ); echo "${r2} $?"`],
			out: (o: Reading2) => [s2, ...(o.parentExit ? [pe] : []), `${r2} ${c2}`]
		},
		{
			lines: [`val=$(trap 'echo "${ce}"' EXIT; echo ${v}); echo "val=[$val]"`],
			out: (o: Reading2) => (o.cmdsubstToTerminal ? [ce, `val=[${v}]`] : [`val=[${v}`, `${ce}]`])
		},
		{
			lines: [`( kill -${sig} $$; echo "${s3}" ); echo "${r3} $?"`],
			out: (o: Reading2) => (o.dollarIsSubshell ? [`${r3} ${128 + num(sig)}`] : [s3, pu, `${r3} 0`])
		}
	];
	const order = rng.shuffle(blocks);
	const script = [
		`trap 'echo "${pe}"' EXIT`,
		`trap 'echo "${pu}"' ${sig}`,
		...order.flatMap((b) => b.lines),
		`echo "${end}"`
	];
	const run = (o: Reading2) => [...order.flatMap((b) => b.out(o)), end, pe, 'exit 0'];
	return {
		script,
		answer: run({}),
		wrong: {
			'subshell-runs-parent-exit-trap': run({ parentExit: true }),
			'cmdsubst-exit-to-terminal': run({ cmdsubstToTerminal: true }),
			'dollar-is-subshell': run({ dollarIsSubshell: true })
		}
	};
}

interface Reading2 {
	parentExit?: boolean;
	cmdsubstToTerminal?: boolean;
	dollarIsSubshell?: boolean;
}

/** `trap ''` ignores, and subshells keep ignoring; a caught signal is reset in subshells; `trap -` restores the default. */
function ignoreReset(rng: Rng): Scenario {
	const next = labels(rng);
	const [i1, i2, h, i3, i4, t, never] = [next(), next(), next(), next(), next(), next(), next()];
	const sig = rng.pick(['USR1', 'USR2', 'HUP', 'ALRM']);
	const code = rng.int(2, 9);
	const dead = 128 + num(sig);
	const script = [
		`trap '' ${sig}`,
		`kill -${sig} $$; echo "${i1}"`,
		`( kill -${sig} $BASHPID; echo "${i2}" ); echo "r1 $?"`,
		`trap 'echo "${h}"' ${sig}`,
		`kill -${sig} $$`,
		`( kill -${sig} $BASHPID; echo "${i3}" ); echo "r2 $?"`,
		`trap - ${sig}`,
		`( kill -${sig} $BASHPID; echo "${i4}" ); echo "r3 $?"`,
		`trap 'echo "${t}"; exit ${code}' TERM`,
		'kill -TERM $$',
		`echo "${never}"`
	];
	const run = (o: { ignoreReset?: boolean; inherits?: boolean; resetIgnores?: boolean }) => [
		i1,
		...(o.ignoreReset ? [`r1 ${dead}`] : [i2, 'r1 0']),
		h,
		...(o.inherits ? [h, i3, 'r2 0'] : [`r2 ${dead}`]),
		...(o.resetIgnores ? [i4, 'r3 0'] : [`r3 ${dead}`]),
		t,
		`exit ${code}`
	];
	return {
		script,
		answer: run({}),
		wrong: {
			'ignore-reset-in-subshell': run({ ignoreReset: true }),
			'subshell-inherits-trap': run({ inherits: true }),
			'reset-means-ignore': run({ resetIgnores: true })
		}
	};
}

const MAKERS: Record<string, (rng: Rng) => Scenario> = {
	'trap-continue': trapContinue,
	'exit-in-handler': exitInHandler,
	'subshell-reset': subshellReset,
	'wait-killed': waitKilled,
	'err-trap': errTrap,
	'nested-exit': nestedExit,
	'exit-in-subshell': exitInSubshell,
	'ignore-reset': ignoreReset
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'trap-continue': ['trap-expands-at-set', 'signal-ends-script'],
	'exit-in-handler': ['exit-skips-exit-trap', 'exit-trap-status-zero'],
	'subshell-reset': ['subshell-inherits-trap', 'ignore-reset-in-subshell'],
	'wait-killed': ['status-signal-number', 'wait-killed-zero'],
	'err-trap': ['err-in-condition', 'errexit-in-condition-function'],
	'nested-exit': ['exit-in-function-returns', 'handler-deferred'],
	'exit-in-subshell': ['subshell-runs-parent-exit-trap', 'cmdsubst-exit-to-terminal', 'dollar-is-subshell'],
	'ignore-reset': ['ignore-reset-in-subshell', 'subshell-inherits-trap', 'reset-means-ignore']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = MAKERS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.classId}`);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const s = make(rng);
		const key = JSON.stringify(s.answer);
		const wrong = Object.fromEntries(
			descriptor.wrongSolutions.map(({ id }) => {
				const value = s.wrong[id];
				return [id, value === undefined || JSON.stringify(value) === key ? null : value];
			})
		);
		const required = REQUIRED[input.classId] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const script = s.script.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					'Скрипт запущен как `bash script.sh` в Linux; сообщения bash в stderr не показываются. Номера сигналов: ' +
						'HUP — 1, KILL — 9, USR1 — 10, USR2 — 12, ALRM — 14, TERM — 15. `$BASHPID` — PID текущей (под)оболочки.',
					'',
					'Что скрипт напечатает в stdout? Введите вывод построчно, а последней строкой — код завершения скрипта в виде `exit N`. Например:',
					'',
					'```',
					'alpha',
					'bravo 0',
					'exit 0',
					'```'
				].join('\n'),
				code: { language: 'shell', source: script }
			},
			answer: { kind: 'sequence', value: s.answer }
		});
		return {
			instance,
			reference: () => bashProbe({ script: `${script}\n`, stderr: 'drop', exitStatus: true }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
