// Permission bits: what `stat -c '%a %n'` prints after `umask`, `touch`, `mkdir`, `chmod`, `cp` and `install`. The
// model applies the rules of GNU coreutils; the gate runs the shown script in the sandbox image, where it runs as root
// — so the script only creates files and reads their modes, it never relies on a permission being enforced.
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
import { bashProbe, type ShellFile } from '../../_lib/shell.ts';

const descriptor = readDescriptor(import.meta.url);

const oct = (mode: number): string => mode.toString(8);
const oct3 = (mode: number): string => mode.toString(8).padStart(3, '0');

/** Umasks with a zero owner digit: owner bits never depend on them. */
const UMASKS = [0o002, 0o007, 0o013, 0o017, 0o022, 0o023, 0o026, 0o027, 0o033, 0o037, 0o057, 0o077] as const;
const FILE_MODES = [0o600, 0o640, 0o644, 0o664, 0o660, 0o700, 0o744, 0o750, 0o755, 0o775, 0o604, 0o711] as const;
const NAMES = ['app', 'deploy', 'backup', 'notes', 'report', 'setup', 'config', 'data', 'cron', 'hook'] as const;

const WHO: Record<string, number> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 };
const PERM: Record<string, number> = { r: 0o444, w: 0o222, x: 0o111 };

/** One clause of a symbolic mode: who (empty — all but the umask) and its actions, each an operator and permissions. */
interface Clause {
	who: string;
	actions: { op: '+' | '-' | '='; perms: string }[];
}

/** How a misconception reads symbolic modes. */
interface Reading {
	/** `X` adds execute to every file. */
	xAlways?: boolean;
	/** `X` looks at the mode before the whole `chmod`, not after the clauses before it. */
	xOriginal?: boolean;
	/** `X` never adds execute to a regular file. */
	xDirsOnly?: boolean;
	/** `=` adds like `+`. */
	equalsAdds?: boolean;
	/** `+` and `-` set like `=`. */
	relativeAsAbsolute?: boolean;
	/** Without who, the umask is ignored (as if `a`). */
	noWhoAll?: boolean;
	/** Without who, only the owner changes. */
	noWhoUser?: boolean;
}

const parseClauses = (spec: string): Clause[] =>
	spec.split(',').map((part) => {
		const m = /^([ugoa]*)((?:[+=-][rwxXugo]*)+)$/.exec(part);
		if (!m) throw new Error(`bad clause ${part}`);
		const actions = [...(m[2] ?? '').matchAll(/([+=-])([rwxXugo]*)/g)].map((a) => ({
			op: a[1] as '+' | '-' | '=',
			perms: a[2] ?? ''
		}));
		return { who: m[1] ?? '', actions };
	});

/** GNU `chmod` with a symbolic mode: clauses apply in turn, `X` and copies read the mode as changed so far. */
function chmodSymbolic(mode: number, dir: boolean, spec: string, umask: number, reading: Reading = {}): number {
	const original = mode;
	let current = mode;
	for (const clause of parseClauses(spec)) {
		let mask = 0;
		for (const w of clause.who) mask |= WHO[w] ?? 0;
		if (clause.who === '') mask = reading.noWhoUser ? 0o700 : reading.noWhoAll ? 0o777 : 0o777 & ~umask;
		for (const action of clause.actions) {
			let bits = 0;
			for (const p of action.perms) {
				if (p === 'X') {
					const base = reading.xOriginal ? original : current;
					const on = reading.xAlways || dir || (!reading.xDirsOnly && (base & 0o111) !== 0);
					if (on) bits |= 0o111;
				} else if (p === 'u' || p === 'g' || p === 'o') {
					const shift = p === 'u' ? 6 : p === 'g' ? 3 : 0;
					bits |= ((current >> shift) & 7) * 0o111;
				} else bits |= PERM[p] ?? 0;
			}
			const op =
				reading.equalsAdds && action.op === '='
					? '+'
					: reading.relativeAsAbsolute && action.op !== '='
						? '='
						: action.op;
			if (op === '+') current |= bits & mask;
			else if (op === '-') current &= ~(bits & mask);
			else current = (current & ~mask) | (bits & mask);
		}
	}
	return current;
}

interface Scenario {
	files: ShellFile[];
	/** What the statement says about the files that exist before the script. */
	given: string[];
	script: string[];
	/** Paths in the order the final `stat` lists them, with their modes. */
	answer: [string, number][];
	wrong: Record<string, [string, number][]>;
}

const statLine = (paths: readonly string[]): string => `stat -c '%a %n' ${paths.join(' ')}`;
const given = (f: ShellFile): string => `\`${f.path}\` — права ${oct3(f.mode ?? 0)}`;
const content = (name: string): string => `# ${name}\n`;

// ----- Intern -----------------------------------------------------------------------------------------------

function umaskCreate(rng: Rng): Scenario {
	const [u1, u2] = rng.sample(UMASKS, 2) as [number, number];
	const [f1, f2] = rng.sample(NAMES, 2).map((n) => `${n}.txt`) as [string, string];
	const [d1, d2] = rng.sample(['logs', 'cache', 'tmp', 'run', 'spool', 'out'], 2) as [string, string];
	const steps: [string, boolean, number][] = rng.shuffle([
		[f1, false, u1],
		[d1, true, u1]
	]);
	const steps2: [string, boolean, number][] = rng.shuffle([
		[f2, false, u2],
		[d2, true, u2]
	]);
	const all = [...steps, ...steps2];
	const create = ([p, dir]: [string, boolean, number]) => (dir ? `mkdir ${p}` : `touch ${p}`);
	const order = rng.shuffle(all.map(([p]) => p));
	const model = (perm: (dir: boolean, u: number) => number) =>
		order.map((p) => {
			const [, dir, u] = all.find((s) => s[0] === p) ?? ['', false, 0];
			return [p, perm(dir, u)] as [string, number];
		});
	return {
		files: [],
		given: [],
		script: [`umask ${oct3(u1)}`, ...steps.map(create), `umask ${oct3(u2)}`, ...steps2.map(create), statLine(order)],
		answer: model((dir, u) => (dir ? 0o777 : 0o666) & ~u),
		wrong: {
			'umask-subtract': model((dir, u) => (dir ? 0o777 : 0o666) - u),
			'file-from-777': model((_dir, u) => 0o777 & ~u)
		}
	};
}

const SYMBOLIC_INTERN = [
	'g+w,o-r',
	'u=rx',
	'go-w',
	'a+x',
	'o=',
	'ug=rw',
	'u+x,g=r',
	'g-r,o+r',
	'a-x,u+w',
	'g=rw,o-rwx',
	'u-w',
	'o=r'
] as const;

function chmodSymbolicIntern(rng: Rng): Scenario {
	const count = rng.int(3, 4);
	const names = rng.sample(NAMES, count).map((n) => `${n}.${rng.pick(['sh', 'conf', 'txt', 'py'])}`);
	const files: ShellFile[] = names.map((path) => ({ path, content: content(path), mode: rng.pick(FILE_MODES) }));
	const specs = names.map(() => rng.pick(SYMBOLIC_INTERN));
	// One file gets an absolute numeric mode.
	const numeric = rng.int(0, count - 1);
	const numericMode = rng.pick(FILE_MODES);
	const run = (reading: Reading) =>
		files.map((f, i): [string, number] => [
			f.path,
			i === numeric ? numericMode : chmodSymbolic(f.mode ?? 0, false, specs[i] ?? '', 0o022, reading)
		]);
	return {
		files,
		given: files.map(given),
		script: [
			...files.map((f, i) => `chmod ${i === numeric ? oct3(numericMode) : specs[i]} ${f.path}`),
			statLine(names)
		],
		answer: run({}),
		wrong: { 'equals-adds': run({ equalsAdds: true }), 'relative-as-absolute': run({ relativeAsAbsolute: true }) }
	};
}

function cpMode(rng: Rng): Scenario {
	const umask = rng.pick(UMASKS);
	const srcMode = rng.pick([0o755, 0o775, 0o664, 0o777, 0o744, 0o666]);
	const oldMode = rng.pick([0o600, 0o640, 0o644, 0o700]);
	const name = rng.pick(NAMES);
	const src = `${name}.sh`;
	const old = `${name}-old.sh`;
	const [copy, kept] = rng.sample(['copy.sh', 'dist.sh', 'release.sh', 'v2.sh'], 2) as [string, string];
	const files: ShellFile[] = [
		{ path: src, content: content(src), mode: srcMode },
		{ path: old, content: content(old), mode: oldMode }
	];
	const commands = rng.shuffle([`cp ${src} ${copy}`, `cp -p ${src} ${kept}`, `cp ${src} ${old}`]);
	const order = rng.shuffle([copy, kept, old]);
	const model = (newMode: number, overwriteMode: number) =>
		order.map((p) => [p, p === copy ? newMode : p === kept ? srcMode : overwriteMode] as [string, number]);
	return {
		files,
		given: files.map(given),
		script: [`umask ${oct3(umask)}`, ...commands, statLine(order)],
		answer: model(srcMode & ~umask, oldMode),
		wrong: {
			'cp-preserves': model(srcMode, oldMode),
			'cp-as-new-file': model(0o666 & ~umask, oldMode),
			'cp-overwrites-mode': model(srcMode & ~umask, srcMode & ~umask)
		}
	};
}

function mkdirMode(rng: Rng): Scenario {
	const umask = rng.pick(UMASKS);
	const exact = rng.pick([0o700, 0o750, 0o711, 0o770, 0o755, 0o777, 0o705]);
	const nested = rng.pick([0o700, 0o750, 0o770, 0o710]);
	const [single, p1, p2] = rng.sample(['secret', 'data', 'out', 'build', 'share', 'state'], 3) as [
		string,
		string,
		string
	];
	const [c1, c2] = rng.sample(['raw', 'tmp', 'keys', 'v1', 'logs'], 2) as [string, string];
	const plain = 0o777 & ~umask;
	// `mkdir -p` makes parents with the umask applied, then adds owner write and search.
	const parent = plain | 0o300;
	const order = [single, p1, `${p1}/${c1}`, p2, `${p2}/${c2}`];
	const model = (single_: number, p2Parent: number, p2Child: number) =>
		order.map(
			(p) =>
				[p, p === single ? single_ : p === p1 || p === `${p1}/${c1}` ? plain : p === p2 ? p2Parent : p2Child] as [
					string,
					number
				]
		);
	return {
		files: [],
		given: [],
		script: [
			`umask ${oct3(umask)}`,
			`mkdir -m ${oct3(exact)} ${single}`,
			`mkdir -p ${p1}/${c1}`,
			`mkdir -p -m ${oct3(nested)} ${p2}/${c2}`,
			statLine(order)
		],
		answer: model(exact, parent, nested),
		wrong: {
			'mkdir-m-masked': model(exact & ~umask, parent, nested & ~umask),
			'mkdir-m-all-parents': model(exact, nested, nested)
		}
	};
}

// ----- Junior -----------------------------------------------------------------------------------------------

/** Recursive specs; the group and others are set absolutely, so the starting mode of the directories does not matter. */
const RECURSIVE_SPECS = [
	'u=rwX,g=rX,o=',
	'u+x,g=rX,o=',
	'g=rX,u+x,o=',
	'u=rw,g=r,o=,a+X',
	'a=rX,u+w',
	'u+w,go=rX',
	'g=rwX,o=',
	'o=,g=X,u+x'
] as const;

function chmodRecursive(rng: Rng): Scenario {
	const root = rng.pick(['app', 'site', 'tool', 'svc']);
	const dirs = rng.sample(['bin', 'conf', 'lib', 'docs', 'data'], 2);
	const files: ShellFile[] = [
		...dirs.flatMap((d) =>
			Array.from({ length: rng.int(1, 2) }, (_, i) => {
				const path = `${root}/${d}/${rng.pick(NAMES)}${i}.${rng.pick(['sh', 'yml', 'txt'])}`;
				return { path, content: content(path), mode: rng.pick(FILE_MODES) };
			})
		),
		{ path: `${root}/README`, content: content('README'), mode: rng.pick([0o644, 0o664, 0o600]) }
	];
	// One executable and one plain file at least.
	const [first] = files;
	const last = files[files.length - 1];
	if (first && !files.some((f) => ((f.mode ?? 0) & 0o111) !== 0)) first.mode = 0o744;
	if (last && !files.some((f) => ((f.mode ?? 0) & 0o111) === 0)) last.mode = 0o644;
	const spec = rng.pick(RECURSIVE_SPECS);
	const dirPaths = [root, ...dirs.map((d) => `${root}/${d}`)];
	const listed = rng.shuffle([...rng.sample(dirPaths, 2), ...files.map((f) => f.path)]);
	const run = (reading: Reading) =>
		listed.map((p) => {
			const f = files.find((x) => x.path === p);
			// Directories start as 755 or 775; every spec sets their owner to rwx and their group and others absolutely.
			return [
				p,
				f ? chmodSymbolic(f.mode ?? 0, false, spec, 0o022, reading) : chmodSymbolic(0o755, true, spec, 0o022, reading)
			] as [string, number];
		});
	return {
		files,
		given: [...files.map(given), 'каталоги — права 755'],
		script: [`chmod -R ${spec} ${root}`, statLine(listed)],
		answer: run({}),
		wrong: {
			'X-as-x': run({ xAlways: true }),
			'X-original-mode': run({ xOriginal: true }),
			'X-dirs-only': run({ xDirsOnly: true })
		}
	};
}

function installMode(rng: Rng): Scenario {
	const umask = rng.pick(UMASKS);
	const name = rng.pick(NAMES);
	const conf = `${name}.conf`;
	const script = `${name}.sh`;
	const confMode = rng.pick([0o600, 0o644, 0o664, 0o640]);
	const scriptMode = rng.pick([0o700, 0o744, 0o750, 0o775, 0o777]);
	const old = 'current.conf';
	const oldMode = rng.pick([0o600, 0o640, 0o644]);
	const m1 = rng.pick([0o640, 0o600, 0o644, 0o660, 0o604]);
	const m2 = rng.pick([0o750, 0o700, 0o770, 0o711]);
	const files: ShellFile[] = [
		{ path: conf, content: content(conf), mode: confMode },
		{ path: script, content: content(script), mode: scriptMode },
		{ path: old, content: content(old), mode: oldMode }
	];
	const [a, b, c, d] = ['etc.conf', 'run.sh', 'cache', 'logs'];
	const lines = rng.shuffle([
		`install -m ${oct3(m1)} ${conf} ${a}`,
		`install ${script} ${b}`,
		`install -d -m ${oct3(m2)} ${c}`,
		`install -d ${d}`,
		`cp ${conf} ${old}`
	]);
	const order = rng.shuffle([a, b, c, d, old]);
	const model = (m: Record<string, number>) => order.map((p) => [p, m[p] ?? 0] as [string, number]);
	const right = { [a]: m1, [b]: 0o755, [c]: m2, [d]: 0o755, [old]: oldMode };
	return {
		files,
		given: files.map(given),
		script: [`umask ${oct3(umask)}`, ...lines, statLine(order)],
		answer: model(right),
		wrong: {
			'install-like-cp': model({ ...right, [b]: scriptMode & ~umask, [d]: 0o777 & ~umask }),
			'install-m-masked': model({ ...right, [a]: m1 & ~umask, [c]: m2 & ~umask }),
			'cp-overwrites-mode': model({ ...right, [old]: confMode & ~umask })
		}
	};
}

function subshellUmask(rng: Rng): Scenario {
	const [u1, u2, u3, u4] = rng.sample(UMASKS, 4) as [number, number, number, number];
	const fn = rng.pick(['strict', 'set_mask', 'private_mode', 'lockdown']);
	const [a, b, c, d, e] = ['a.log', 'b.log', 'c.log', 'd.log', 'e.log'];
	const [t1, t2] = ['tmp1', 'tmp2'];
	const script = [
		`umask ${oct3(u1)}`,
		`( umask ${oct3(u2)}; touch ${a}; mkdir ${t1} )`,
		`touch ${b}`,
		`${fn}() { umask ${oct3(u3)}; }`,
		fn,
		`touch ${c}`,
		`mkdir ${t2}`,
		`out=$(umask ${oct3(u4)}; touch ${d})`,
		`touch ${e}`
	];
	const order = [a, t1, b, c, t2, d, e];
	const model = (after: { b: number; c: number; e: number }) =>
		order.map((p) => {
			const m: Record<string, number> = {
				[a]: 0o666 & ~u2,
				[t1]: 0o777 & ~u2,
				[b]: 0o666 & ~after.b,
				[c]: 0o666 & ~after.c,
				[t2]: 0o777 & ~after.c,
				[d]: 0o666 & ~u4,
				[e]: 0o666 & ~after.e
			};
			return [p, m[p] ?? 0] as [string, number];
		});
	return {
		files: [],
		given: [],
		script: [...script, statLine(order)],
		answer: model({ b: u1, c: u3, e: u3 }),
		wrong: {
			'subshell-leaks': model({ b: u2, c: u3, e: u4 }),
			'function-scoped': model({ b: u1, c: u1, e: u1 })
		}
	};
}

const NO_WHO = ['+x', '-w', '+w', '-r', '+r', '-x'] as const;

function chmodNoWho(rng: Rng): Scenario {
	const umask = rng.pick([0o022, 0o027, 0o077, 0o037, 0o007, 0o026, 0o023, 0o033]);
	const names = rng.sample(NAMES, 3).map((n) => `${n}.${rng.pick(['sh', 'conf', 'txt'])}`);
	const files: ShellFile[] = names.map((path) => ({ path, content: content(path), mode: rng.pick(FILE_MODES) }));
	const [s1, s2] = rng.sample(NO_WHO, 2) as [string, string];
	const copy = rng.pick(['o=u', 'g=u', 'go=u', 'o=g', 'g=u-w', 'o=g-x']);
	const specs = [s1, s2, copy];
	const run = (reading: Reading) =>
		files.map(
			(f, i) => [f.path, chmodSymbolic(f.mode ?? 0, false, specs[i] ?? '', umask, reading)] as [string, number]
		);
	return {
		files,
		given: files.map(given),
		script: [`umask ${oct3(umask)}`, ...files.map((f, i) => `chmod ${specs[i]} ${f.path}`), statLine(names)],
		answer: run({}),
		wrong: { 'no-who-ignores-umask': run({ noWhoAll: true }), 'no-who-user-only': run({ noWhoUser: true }) }
	};
}

const MAKERS: Record<string, (rng: Rng) => Scenario> = {
	'umask-create': umaskCreate,
	'chmod-symbolic': chmodSymbolicIntern,
	'cp-mode': cpMode,
	'mkdir-m': mkdirMode,
	'chmod-recursive': chmodRecursive,
	install: installMode,
	'subshell-umask': subshellUmask,
	'chmod-no-who': chmodNoWho
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'umask-create': ['umask-subtract', 'file-from-777'],
	'chmod-symbolic': ['equals-adds', 'relative-as-absolute'],
	'cp-mode': ['cp-preserves', 'cp-overwrites-mode'],
	'mkdir-m': ['mkdir-m-masked', 'mkdir-m-all-parents'],
	'chmod-recursive': ['X-as-x'],
	install: ['install-like-cp', 'install-m-masked'],
	'subshell-umask': ['subshell-leaks', 'function-scoped'],
	'chmod-no-who': ['no-who-ignores-umask', 'no-who-user-only']
};

/** How many misconceptions an instance of a class must expose at least. */
const MIN_EXPOSED: Record<string, number> = { 'chmod-recursive': 2 };

const lines = (modes: readonly [string, number][]): string[] => modes.map(([p, m]) => `${oct(m)} ${p}`);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = MAKERS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.classId}`);
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const s = make(rng);
		const answer = lines(s.answer);
		const key = JSON.stringify(answer);
		const wrong = Object.fromEntries(
			descriptor.wrongSolutions.map(({ id }) => {
				const modes = s.wrong[id];
				const value = modes === undefined ? null : lines(modes);
				return [id, value === null || JSON.stringify(value) === key ? null : value];
			})
		);
		const required = REQUIRED[input.classId] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		if (Object.values(wrong).filter((v) => v !== null).length < (MIN_EXPOSED[input.classId] ?? 1)) continue;
		const script = s.script.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					s.given.length
						? `Скрипт запущен в GNU bash 5.2 в каталоге, где уже есть: ${s.given.join('; ')}.`
						: 'Скрипт запущен в GNU bash 5.2 в пустом каталоге.',
					'Утилиты — из GNU coreutils 9.',
					'',
					"`stat -c '%a %n'` печатает права файла восьмеричным числом без ведущих нулей (например, `640`, `0` для `000`) и через пробел — имя, по строке на файл в порядке аргументов.",
					...(s.script.some((l) => /^chmod .*X/.test(l))
						? [
								'Части символьного режима через запятую `chmod` применяет по очереди, и `X` смотрит на права, уже изменённые предыдущими частями того же режима.'
							]
						: []),
					'Что напечатает скрипт? Введите вывод построчно.'
				].join('\n'),
				code: { language: 'shell', source: script }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => bashProbe({ script: `${script}\n`, files: s.files }),
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
