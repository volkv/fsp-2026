// Redirections in bash: the order of `>f` and `2>&1`, `>>`, groups, pipes that carry only stdout, `|&`, here-docs,
// `exec` with numbered descriptors, redirections of functions and loops, two descriptors on one file. The script is a
// small tree printed as bash and evaluated by a model of open file descriptions (shared offsets, O_APPEND, truncation);
// the terminal is one stream that stdout and stderr share in the order of writing. A misconception is the same model
// with one rule read wrong. The gate runs the script with the bash of the sandbox image, stderr merged into stdout.
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

/** A redirection: `n>file`, `n>>file`, `n>&m`, `n>&-`; the file `/dev/null` discards. */
type Redir =
	{ fd: number; op: '>' | '>>'; file: string } | { fd: number; op: 'dup'; to: number } | { fd: number; op: 'close' };

type Cmd =
	| { t: 'echo'; text: string; r: Redir[] }
	/** `emit X`: prints `out-X` to stdout and `err-X` to stderr. */
	| { t: 'emit'; arg: string; r: Redir[] }
	/** A call of a function defined with a redirection after its body. */
	| { t: 'call'; name: string; arg: string; r: Redir[] }
	| { t: 'group'; body: Cmd[]; r: Redir[] }
	/** `for v in items; do echo "<prefix> $v" [r_inner]; done [r]` */
	| { t: 'for'; v: string; items: string[]; prefix: string; inner: Redir[]; r: Redir[] }
	/** `left | right` or `left |& right`; right is `tr a-z A-Z` or `tee file`. */
	| { t: 'pipe'; left: Cmd; both: boolean; right: { kind: 'tr' } | { kind: 'tee'; file: string }; r: Redir[] }
	| { t: 'cat'; file: string; r: Redir[] }
	| { t: 'exec'; r: Redir[] }
	/** `cat <<[']EOF' > file`: the body as written and as bash expands it. */
	| { t: 'heredoc'; quoted: boolean; body: string[]; expanded: string[]; file: string }
	/** `tr a-z A-Z <<< "text"` */
	| { t: 'herestring'; shown: string; value: string };

/** A function defined with a redirection: `name() { echo "<prefix> $1"; } <r>`. */
interface Fn {
	name: string;
	prefix: string;
	r: Redir[];
}

interface Reading {
	/** `2>&1` is applied after the file redirections, wherever it is written. */
	dupLast?: boolean;
	/** A pipe carries stderr too. */
	pipeCarriesStderr?: boolean;
	/** A redirection of a group's stdout takes its stderr too. */
	groupTakesStderr?: boolean;
	/** `>` does not truncate an existing file. */
	noTruncate?: boolean;
	/** A function's redirection is opened once, at the first call. */
	functionOnce?: boolean;
	/** A loop's redirection is opened again on every iteration. */
	loopEachIteration?: boolean;
	/** Two descriptors opened on one file write after each other, as if appending. */
	separateAppend?: boolean;
	/** `exec` with a redirection affects only the next command. */
	execOnce?: boolean;
	/** After `exec 2>&1`, stderr follows stdout when stdout is moved again. */
	stderrFollows?: boolean;
	/** `<<'EOF'` expands like `<<EOF`. */
	quotedExpands?: boolean;
	/** `<<EOF` does not expand. */
	unquotedLiteral?: boolean;
}

// ----- Printing -----------------------------------------------------------------------------------------------

function showRedir(r: Redir): string {
	const n = (fd: number, def: number) => (fd === def ? '' : String(fd));
	if (r.op === 'dup') return `${n(r.fd, 1)}>&${r.to}`;
	if (r.op === 'close') return `${r.fd}>&-`;
	return `${n(r.fd, 1)}${r.op} ${r.file}`;
}
const redirs = (rs: readonly Redir[]): string => rs.map((r) => ` ${showRedir(r)}`).join('');

function show(c: Cmd): string[] {
	switch (c.t) {
		case 'echo':
			return [`echo "${c.text}"${redirs(c.r)}`];
		case 'emit':
			return [`emit ${c.arg}${redirs(c.r)}`];
		case 'call':
			return [`${c.name} ${c.arg}${redirs(c.r)}`];
		case 'group':
			return [`{ ${c.body.flatMap(show).join('; ')}; }${redirs(c.r)}`];
		case 'for':
			return [
				`for ${c.v} in ${c.items.join(' ')}; do echo "${c.prefix} $${c.v}"${redirs(c.inner)}; done${redirs(c.r)}`
			];
		case 'pipe': {
			const right = c.right.kind === 'tr' ? 'tr a-z A-Z' : `tee ${c.right.file}`;
			return [`${show(c.left).join('')} ${c.both ? '|&' : '|'} ${right}${redirs(c.r)}`];
		}
		case 'cat':
			return [`cat ${c.file}${redirs(c.r)}`];
		case 'exec':
			return [`exec${redirs(c.r)}`];
		case 'heredoc':
			return [`cat <<${c.quoted ? "'EOF'" : 'EOF'} > ${c.file}`, ...c.body, 'EOF'];
		case 'herestring':
			return [`tr a-z A-Z <<< "${c.shown}"`];
	}
}

// ----- Model --------------------------------------------------------------------------------------------------

type Ofd =
	| { kind: 'tty' }
	| { kind: 'null' }
	| { kind: 'file'; name: string; offset: number; append: boolean }
	| { kind: 'pipe'; buf: string[] };

class World {
	readonly terminal: string[] = [];
	readonly files = new Map<string, string>();
	readonly r: Reading;

	constructor(r: Reading) {
		this.r = r;
	}

	write(o: Ofd | undefined, text: string): void {
		if (!o || o.kind === 'null') return;
		if (o.kind === 'tty') this.terminal.push(text);
		else if (o.kind === 'pipe') o.buf.push(text);
		else {
			const content = this.files.get(o.name) ?? '';
			if (o.append) this.files.set(o.name, content + text);
			else {
				this.files.set(o.name, content.slice(0, o.offset) + text + content.slice(o.offset + text.length));
				o.offset += text.length;
			}
		}
	}

	open(file: string, append: boolean): Ofd {
		if (file === '/dev/null') return { kind: 'null' };
		const truncate = !append && !(this.r.noTruncate && this.files.has(file));
		if (truncate || !this.files.has(file)) this.files.set(file, truncate ? '' : (this.files.get(file) ?? ''));
		if (this.r.separateAppend) return { kind: 'file', name: file, offset: 0, append: true };
		return { kind: 'file', name: file, offset: 0, append: append || (!!this.r.noTruncate && !truncate) };
	}

	/** Applies redirections to a copy of the table, left to right (a misconception may move the dups last). */
	apply(table: Map<number, Ofd>, rs: readonly Redir[], dupLast = !!this.r.dupLast): Map<number, Ofd> {
		const t = new Map(table);
		const ordered = dupLast ? [...rs.filter((r) => r.op !== 'dup'), ...rs.filter((r) => r.op === 'dup')] : rs;
		for (const r of ordered) {
			if (r.op === 'dup') {
				const target = t.get(r.to);
				if (target) t.set(r.fd, target);
				else t.delete(r.fd);
			} else if (r.op === 'close') t.delete(r.fd);
			else t.set(r.fd, this.open(r.file, r.op === '>>'));
		}
		return t;
	}
}

const upper = (s: string): string => s.replace(/[a-z]/g, (ch) => ch.toUpperCase());

/** Runs the script under a reading: the lines of the terminal. */
function run(fns: readonly Fn[], main: readonly Cmd[], r: Reading): string[] {
	const w = new World(r);
	let shell = new Map<number, Ofd>([
		[1, { kind: 'tty' }],
		[2, { kind: 'tty' }]
	]);
	/** `execOnce`: a one-command table that the next command uses instead of the shell's. */
	const pending: { once: Map<number, Ofd> | null } = { once: null };
	const fnOpened = new Map<string, Map<number, Ofd>>();

	function exec(c: Cmd, table: Map<number, Ofd>): void {
		switch (c.t) {
			case 'echo': {
				const t = w.apply(table, c.r);
				w.write(t.get(1), `${c.text}\n`);
				return;
			}
			case 'emit': {
				const t = w.apply(table, c.r);
				w.write(t.get(1), `out-${c.arg}\n`);
				w.write(t.get(2), `err-${c.arg}\n`);
				return;
			}
			case 'call': {
				const fn = fns.find((f) => f.name === c.name);
				if (!fn) throw new Error(`no function ${c.name}`);
				let t = w.apply(table, c.r);
				if (r.functionOnce) {
					const opened = fnOpened.get(fn.name) ?? w.apply(t, fn.r);
					fnOpened.set(fn.name, opened);
					t = opened;
				} else t = w.apply(t, fn.r);
				w.write(t.get(1), `${fn.prefix} ${c.arg}\n`);
				return;
			}
			case 'group': {
				let t = w.apply(table, c.r);
				if (r.groupTakesStderr && c.r.some((x) => x.fd === 1 && x.op !== 'dup'))
					t = w.apply(t, [{ fd: 2, op: 'dup', to: 1 }], false);
				for (const b of c.body) exec(b, t);
				return;
			}
			case 'for': {
				if (r.loopEachIteration) {
					for (const item of c.items) {
						const t = w.apply(table, c.r);
						w.write(w.apply(t, c.inner).get(1), `${c.prefix} ${item}\n`);
					}
					return;
				}
				const t = w.apply(table, c.r);
				for (const item of c.items) w.write(w.apply(t, c.inner).get(1), `${c.prefix} ${item}\n`);
				return;
			}
			case 'pipe': {
				const pipe = { kind: 'pipe' as const, buf: [] as string[] };
				const left = new Map(table);
				left.set(1, pipe);
				if (c.both || r.pipeCarriesStderr) left.set(2, pipe);
				exec(c.left, left);
				const t = w.apply(table, c.r);
				const data = pipe.buf.join('');
				if (c.right.kind === 'tr') w.write(t.get(1), upper(data));
				else {
					const f = w.open(c.right.file, false);
					w.write(f, data);
					w.write(t.get(1), data);
				}
				return;
			}
			case 'cat': {
				const t = w.apply(table, c.r);
				const content = w.files.get(c.file);
				if (content) w.write(t.get(1), content);
				return;
			}
			case 'exec': {
				if (r.execOnce) {
					pending.once = w.apply(shell, c.r);
					return;
				}
				const before = shell;
				shell = w.apply(shell, c.r);
				// The misconception: stderr was made to follow stdout, so it moves back with it.
				if (r.stderrFollows && before.get(2) === before.get(1) && c.r.some((x) => x.fd === 1))
					shell.set(2, shell.get(1) as Ofd);
				return;
			}
			case 'heredoc': {
				const expand = c.quoted ? !!r.quotedExpands : !r.unquotedLiteral;
				const f = w.open(c.file, false);
				w.write(f, (expand ? c.expanded : c.body).map((l) => `${l}\n`).join(''));
				return;
			}
			case 'herestring':
				w.write(table.get(1), `${upper(c.value)}\n`);
				return;
		}
	}

	for (const c of main) {
		const table = pending.once ?? shell;
		pending.once = null;
		exec(c, table);
	}
	return w.terminal
		.join('')
		.split('\n')
		.filter((l, i, all) => i < all.length - 1 || l !== '');
}

// ----- Scenarios ----------------------------------------------------------------------------------------------

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
	'romeo'
] as const;
const EMIT = 'emit() { echo "out-$1"; echo "err-$1" >&2; }';

interface Scenario {
	fns: Fn[];
	main: Cmd[];
	/** Files whose contents the script prints at the end. */
	shown: string[];
	readings: Record<string, Reading>;
	usesEmit: boolean;
	/** Assignments before the commands. */
	prelude?: string[];
}

const to = (fd: number, file: string, append = false): Redir => ({ fd, op: append ? '>>' : '>', file });
const dup = (fd: number, target: number): Redir => ({ fd, op: 'dup', to: target });
const close = (fd: number): Redir => ({ fd, op: 'close' });

function labels(rng: Rng): () => string {
	const pool = rng.shuffle(WORDS);
	let i = 0;
	return () => pool[i++] ?? `w${i}`;
}

/** `>f 2>&1` against `2>&1 >f`, `&>`-like forms, `2>` and `/dev/null`. */
function redirectOrder(rng: Rng): Scenario {
	const next = labels(rng);
	const files = rng.sample(['a.log', 'b.log', 'c.log', 'd.log'], 3) as [string, string, string];
	const forms: Cmd[] = rng.shuffle([
		{ t: 'emit', arg: next(), r: [to(1, files[0]), dup(2, 1)] },
		{ t: 'emit', arg: next(), r: [dup(2, 1), to(1, files[1])] },
		{ t: 'emit', arg: next(), r: [to(2, files[2])] },
		{ t: 'emit', arg: next(), r: [dup(2, 1), to(1, '/dev/null')] }
	]);
	return {
		fns: [],
		main: [{ t: 'echo', text: next(), r: [] }, ...forms],
		shown: files,
		readings: { 'redirect-order-irrelevant': { dupLast: true } },
		usesEmit: true
	};
}

/** `>` truncates, `>>` appends; a group's redirection covers every command in it, but only the named descriptor. */
function appendGroup(rng: Rng): Scenario {
	const next = labels(rng);
	const [log, out] = rng.sample(['app.log', 'run.log', 'out.txt', 'all.txt'], 2) as [string, string];
	const main: Cmd[] = [
		{ t: 'echo', text: next(), r: [to(1, log)] },
		{ t: 'echo', text: next(), r: [to(1, log, true)] },
		{
			t: 'group',
			body: [
				{ t: 'echo', text: next(), r: [] },
				{ t: 'emit', arg: next(), r: [] }
			],
			r: [to(1, out)]
		},
		{ t: 'echo', text: next(), r: [to(1, log)] },
		{ t: 'group', body: [{ t: 'emit', arg: next(), r: [] }], r: [to(1, out, true), dup(2, 1)] },
		{ t: 'echo', text: next(), r: [to(1, log, true)] }
	];
	return {
		fns: [],
		main,
		shown: [log, out],
		readings: { 'truncate-appends': { noTruncate: true }, 'group-takes-stderr': { groupTakesStderr: true } },
		usesEmit: true
	};
}

/** A pipe carries stdout only: stderr of the left side goes where it went before; `|&` and `2>&1 >/dev/null |`. */
function pipes(rng: Rng): Scenario {
	const next = labels(rng);
	const [up, both, tee] = ['up.txt', 'both.txt', 'copy.txt'];
	const main: Cmd[] = rng.shuffle([
		{ t: 'pipe', left: { t: 'emit', arg: next(), r: [] }, both: false, right: { kind: 'tr' }, r: [to(1, up)] },
		{ t: 'pipe', left: { t: 'emit', arg: next(), r: [] }, both: true, right: { kind: 'tr' }, r: [to(1, both)] },
		{
			t: 'pipe',
			left: { t: 'emit', arg: next(), r: [dup(2, 1), to(1, '/dev/null')] },
			both: false,
			right: { kind: 'tr' },
			r: []
		},
		{
			t: 'pipe',
			left: { t: 'emit', arg: next(), r: [to(2, '/dev/null')] },
			both: false,
			right: { kind: 'tee', file: tee },
			r: []
		}
	] as Cmd[]);
	return {
		fns: [],
		main,
		shown: [up, both, tee],
		readings: { 'pipe-carries-stderr': { pipeCarriesStderr: true }, 'redirect-order-irrelevant': { dupLast: true } },
		usesEmit: true
	};
}

/** Here-documents: `<<EOF` expands parameters, arithmetic and `\$`; `<<'EOF'` keeps the text as is; here-strings. */
function heredocs(rng: Rng): Scenario {
	const name = rng.pick(['web', 'api', 'db', 'cache']);
	const port = rng.int(8000, 8999);
	const add = rng.int(1, 9);
	const [f1, f2] = rng.sample(['app.conf', 'site.conf', 'unit.conf', 'svc.conf'], 2) as [string, string];
	const body = [
		`host=$name`,
		`port=$((PORT + ${add}))`,
		'home=\\$HOME',
		`label=${rng.pick(['main', 'edge', 'core'])}-$name`
	];
	const expanded = [`host=${name}`, `port=${port + add}`, 'home=$HOME', body[3]?.replace('$name', name) ?? ''];
	const body2 = [`user=$name`, `port=$PORT`];
	const expanded2 = [`user=${name}`, `port=${port}`];
	const firstQuoted = rng.bool();
	const main: Cmd[] = [
		{ t: 'echo', text: 'start', r: [] },
		{ t: 'heredoc', quoted: firstQuoted, body, expanded, file: f1 },
		{ t: 'heredoc', quoted: !firstQuoted, body: body2, expanded: expanded2, file: f2 },
		{ t: 'herestring', shown: `$name:$PORT`, value: `${name}:${port}` }
	];
	return {
		fns: [],
		main,
		shown: [f1, f2],
		readings: { 'quoted-heredoc-expands': { quotedExpands: true }, 'heredoc-no-expansion': { unquotedLiteral: true } },
		usesEmit: false,
		prelude: [`name=${name}`, `PORT=${port}`]
	};
}

/** Several descriptors: `exec 3>file`, writes to `>&3`, swapping stdout and stderr through fd 3 inside a group. */
function fdJuggling(rng: Rng): Scenario {
	const next = labels(rng);
	const [log, swap, out] = rng.sample(['one.log', 'two.log', 'three.log', 'four.log'], 3) as [string, string, string];
	const main: Cmd[] = [
		{ t: 'exec', r: [to(3, log)] },
		{ t: 'echo', text: next(), r: [dup(1, 3)] },
		{ t: 'emit', arg: next(), r: [dup(2, 3)] },
		{ t: 'group', body: [{ t: 'emit', arg: next(), r: [dup(3, 1), dup(1, 2), dup(2, 3)] }], r: [to(2, swap)] },
		{ t: 'exec', r: [dup(4, 1), to(1, out)] },
		{ t: 'echo', text: next(), r: [] },
		{ t: 'emit', arg: next(), r: [] },
		{ t: 'exec', r: [dup(1, 4), close(4)] },
		{ t: 'echo', text: next(), r: [dup(1, 3)] },
		{ t: 'exec', r: [close(3)] }
	];
	return {
		fns: [],
		main,
		shown: [log, swap, out],
		readings: { 'redirect-order-irrelevant': { dupLast: true }, 'exec-one-command': { execOnce: true } },
		usesEmit: true
	};
}

/** A function's redirection is applied at every call; a loop's — once for the whole loop. */
function functionLoop(rng: Rng): Scenario {
	const next = labels(rng);
	const [fa, fr, lp, each] = ['calls.log', 'last.log', 'loop.txt', 'each.txt'];
	const [p1, p2, p3, p4] = [next(), next(), next(), next()];
	const fns: Fn[] = [
		{ name: 'note', prefix: p1, r: [to(1, fa, true)] },
		{ name: 'report', prefix: p2, r: [to(1, fr)] }
	];
	const args = rng.sample(['1', '2', '3', '4', '5', '6', '7'], 3) as [string, string, string];
	const items = rng.sample(['a', 'b', 'c', 'd', 'e'], rng.int(2, 3));
	const items2 = rng.sample(['x', 'y', 'z', 'w'], rng.int(2, 3));
	const main: Cmd[] = [
		{ t: 'call', name: 'note', arg: args[0], r: [] },
		{ t: 'call', name: 'report', arg: args[0], r: [] },
		{ t: 'call', name: 'note', arg: args[1], r: [] },
		{ t: 'call', name: 'report', arg: args[1], r: [] },
		{ t: 'call', name: 'report', arg: args[2], r: [] },
		{ t: 'for', v: 'i', items, prefix: p3, inner: [], r: [to(1, lp)] },
		{ t: 'for', v: 'j', items: items2, prefix: p4, inner: [to(1, each)], r: [] }
	];
	return {
		fns,
		main,
		shown: [fa, fr, lp, each],
		readings: {
			'function-redirect-once': { functionOnce: true },
			'loop-redirect-each-iteration': { loopEachIteration: true },
			'truncate-appends': { noTruncate: true }
		},
		usesEmit: false
	};
}

/** Two descriptors on one file: `>f 2>f` have separate offsets and overwrite each other; `2>&1` shares; `>>` appends. */
function sharedFile(rng: Rng): Scenario {
	const next = labels(rng);
	const [s1, s2, s3, s4] = ['sep.txt', 'dup.txt', 'app.txt', 'fd.txt'];
	const long = `${next()}${next()}`;
	const short = next().slice(0, 3);
	const main: Cmd[] = rng.shuffle([
		{ t: 'emit', arg: next(), r: [to(1, s1), to(2, s1)] },
		{ t: 'emit', arg: next(), r: [to(1, s2), dup(2, 1)] },
		{ t: 'emit', arg: next(), r: [to(1, s3, true), to(2, s3, true)] }
	] as Cmd[]);
	main.push(
		{ t: 'exec', r: [to(5, s4), to(6, s4)] },
		{ t: 'echo', text: long, r: [dup(1, 5)] },
		{ t: 'echo', text: short, r: [dup(1, 6)] },
		{ t: 'exec', r: [close(5), close(6)] }
	);
	return {
		fns: [],
		main,
		shown: [s1, s2, s3, s4],
		readings: { 'separate-fds-append': { separateAppend: true }, 'redirect-order-irrelevant': { dupLast: true } },
		usesEmit: true
	};
}

/** `exec >file` moves stdout for the rest of the script; `exec 2>&1` copies where stdout points now, not later. */
function execPersist(rng: Rng): Scenario {
	const next = labels(rng);
	const log = rng.pick(['ex.log', 'all.log', 'session.log']);
	const main: Cmd[] = [
		{ t: 'echo', text: next(), r: [] },
		{ t: 'exec', r: [dup(3, 1)] },
		{ t: 'exec', r: [to(1, log)] },
		{ t: 'echo', text: next(), r: [] },
		{ t: 'emit', arg: next(), r: [] },
		{ t: 'exec', r: [dup(2, 1)] },
		{ t: 'emit', arg: next(), r: [] },
		{ t: 'exec', r: [dup(1, 3), close(3)] },
		{ t: 'echo', text: next(), r: [] },
		{ t: 'emit', arg: next(), r: [] }
	];
	return {
		fns: [],
		main,
		shown: [log],
		readings: { 'exec-one-command': { execOnce: true }, 'stderr-follows-stdout': { stderrFollows: true } },
		usesEmit: true
	};
}

const MAKERS: Record<string, (rng: Rng) => Scenario> = {
	'redirect-order': redirectOrder,
	'append-group': appendGroup,
	pipes,
	heredoc: heredocs,
	'fd-juggling': fdJuggling,
	'function-loop': functionLoop,
	'shared-file': sharedFile,
	'exec-persist': execPersist
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'redirect-order': ['redirect-order-irrelevant'],
	'append-group': ['truncate-appends', 'group-takes-stderr'],
	pipes: ['pipe-carries-stderr', 'redirect-order-irrelevant'],
	heredoc: ['quoted-heredoc-expands', 'heredoc-no-expansion'],
	'fd-juggling': ['redirect-order-irrelevant', 'exec-one-command'],
	'function-loop': ['function-redirect-once', 'loop-redirect-each-iteration'],
	'shared-file': ['separate-fds-append'],
	'exec-persist': ['exec-one-command', 'stderr-follows-stdout']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = MAKERS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.classId}`);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const s = make(rng);
		const prelude = s.prelude ?? [];
		const tail: Cmd[] = s.shown.flatMap((f) => [
			{ t: 'echo', text: `== ${f}`, r: [] },
			{ t: 'cat', file: f, r: [] }
		]);
		const main = [...s.main, ...tail];
		const answer = run(s.fns, main, {});
		if (answer.some((l) => l.length === 0 || l.trim() !== l)) continue;
		const key = JSON.stringify(answer);
		const wrong = Object.fromEntries(
			descriptor.wrongSolutions.map(({ id }) => {
				const reading = s.readings[id];
				const value = reading ? run(s.fns, main, reading) : null;
				return [id, value === null || JSON.stringify(value) === key ? null : value];
			})
		);
		const required = REQUIRED[input.classId] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const script = [
			...(s.usesEmit ? [EMIT] : []),
			...s.fns.map((f) => `${f.name}() { echo "${f.prefix} $1"; }${redirs(f.r)}`),
			...prelude,
			...main.flatMap(show)
		].join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					'Скрипт запущен как `bash script.sh` в пустом каталоге; stdout и stderr скрипта выводятся на один экран в том порядке, в каком команды пишут. ' +
						'Встроенная команда `echo` пишет сразу, без буферизации. Последние строки скрипта печатают содержимое созданных файлов.',
					'',
					'Что появится на экране? Введите вывод построчно.'
				].join('\n'),
				code: { language: 'shell', source: script }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => bashProbe({ script: `${script}\n`, stderr: 'merge' }),
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
