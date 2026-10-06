// Which paths a glob or `find` selects in a generated tree of files with sizes and modification times. The model
// applies the rules of bash pathname expansion and GNU find; the gate builds the same tree in the sandbox image and
// runs the shown script with the real tools.
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

const STEMS = ['app', 'api', 'db', 'web', 'cron', 'audit', 'error', 'access', 'debug', 'sync'] as const;
const DIRS = ['logs', 'conf', 'data', 'tmp', 'old', 'cache', 'jobs', 'run'] as const;
const EXTS = ['log', 'conf', 'txt', 'tmp', 'gz', 'json'] as const;
/** Stems of directories named like files; files never use them, so the names never clash. */
const DIR_STEMS = ['archive', 'backup', 'rotated', 'snapshot'] as const;

interface Entry {
	path: string;
	size: number;
	/** Seconds from a base day. */
	time: number;
}

const BASE = Date.UTC(2026, 8, 1, 0, 0, 0);
const stamp = (t: number): string => new Date(BASE + t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const human = (t: number): string => stamp(t).replace('T', ' ').replace('Z', '');

/** Shell pattern matching for `*`, `?` and literal characters; `period` — a leading dot must be matched literally. */
function fnmatch(pattern: string, name: string, period: boolean): boolean {
	if (period && name.startsWith('.') && !pattern.startsWith('.')) return false;
	const re = new RegExp(
		`^${pattern
			.split('')
			.map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
			.join('')}$`
	);
	return re.test(name);
}

const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const depth = (path: string): number => path.split('/').length;

/** Every directory of the tree (without `.`). */
function dirsOf(entries: readonly Entry[]): string[] {
	const dirs = new Set<string>();
	for (const e of entries) {
		const parts = e.path.split('/');
		for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
	}
	return [...dirs];
}

function content(size: number): string {
	if (size === 0) return '';
	return `${'x'.repeat(size - 1)}\n`;
}

/** A tree: a few files at the top (one hidden), a few in directories one and two levels down. */
function tree(rng: Rng, exts: readonly string[]): Entry[] {
	const entries: Entry[] = [];
	const used = new Set<string>();
	const add = (path: string) => {
		if (used.has(path)) return;
		used.add(path);
		entries.push({ path, size: rng.pick([0, 120, 700, 1024, 1500, 2048, 3100]), time: rng.int(0, 20) * 3600 });
	};
	const [d1, d2] = rng.sample(DIRS, 2) as [string, string];
	const sub = rng.pick(DIRS.filter((d) => d !== d1 && d !== d2));
	for (let i = 0; i < rng.int(3, 4); i += 1) add(`${rng.pick(STEMS)}.${rng.pick(exts)}`);
	add(`.${rng.pick(STEMS)}.${rng.pick(exts)}`);
	for (let i = 0; i < rng.int(2, 3); i += 1) add(`${d1}/${rng.pick(STEMS)}.${rng.pick(exts)}`);
	for (let i = 0; i < rng.int(1, 2); i += 1) add(`${d2}/${rng.pick(STEMS)}.${rng.pick(exts)}`);
	for (let i = 0; i < rng.int(1, 2); i += 1) add(`${d1}/${sub}/${rng.pick(STEMS)}.${rng.pick(exts)}`);
	if (rng.bool(0.5)) add(`${d2}/.${rng.pick(STEMS)}.${rng.pick(exts)}`);
	return entries;
}

interface Scenario {
	entries: Entry[];
	script: string;
	answer: string[];
	wrong: Record<string, string[]>;
	/** Show sizes and times in the statement. */
	details: boolean;
}

/** `printf '%s\n'` with globs: `*` skips hidden names, a glob without matches stays as typed, `*` stays in its level. */
function globs(rng: Rng): Scenario {
	const exts = rng.sample(EXTS, 3);
	const entries = tree(rng, exts);
	const top = entries.filter((e) => depth(e.path) === 1).map((e) => e.path);
	const dirs = dirsOf(entries);
	const ext = rng.pick(exts);
	const missing = rng.pick([...EXTS.filter((e) => !entries.some((x) => x.path.endsWith(`.${e}`))), 'bak', 'old']);
	const dir = rng.pick(dirs.filter((d) => depth(d) === 1));
	const inDir = entries.filter((e) => e.path.startsWith(`${dir}/`) && depth(e.path) === 2).map((e) => e.path);
	const ext2 = rng.pick(exts);
	const patterns = [`*.${ext}`, `${dir}/*.${ext2}`, `*.${missing}`];
	const expand = (o: { hidden?: boolean; vanish?: boolean; recursive?: boolean }) =>
		patterns.flatMap((p) => {
			let found: string[];
			if (p.startsWith(`${dir}/`)) {
				const pat = p.slice(dir.length + 1);
				found = inDir.filter((path) => fnmatch(pat, base(path), !o.hidden));
			} else {
				const pool = o.recursive ? entries.map((e) => e.path) : top;
				found = pool.filter((path) => fnmatch(p, base(path), !o.hidden));
			}
			return found.length ? found : o.vanish ? [] : [p];
		});
	return {
		entries,
		script: `printf '%s\\n' ${patterns.join(' ')}`,
		answer: expand({}),
		wrong: {
			'glob-matches-hidden': expand({ hidden: true }),
			'glob-empty-vanishes': expand({ vanish: true }),
			'glob-recursive': expand({ recursive: true })
		},
		details: false
	};
}

/** `find -maxdepth/-mindepth -type f -name`: `-name` sees the base name and its `*` matches a leading dot. */
function findName(rng: Rng): Scenario {
	const exts = rng.sample(EXTS, 3);
	const entries = tree(rng, exts);
	const ext = rng.pick(exts);
	// A directory named like the pattern, so `-type f` matters.
	const dirName = `${rng.pick(DIR_STEMS)}.${ext}`;
	entries.push({ path: `${dirName}/part1.txt`, size: 10, time: 0 });
	const form = rng.pick(['max1', 'max2', 'min2'] as const);
	const limit = form === 'max1' ? '-maxdepth 1 ' : form === 'max2' ? '-maxdepth 2 ' : '-mindepth 2 ';
	const select = (o: { hidden?: boolean; shift?: number }) =>
		entries
			.filter((e) => {
				const d = depth(e.path);
				const s = o.shift ?? 0;
				if (form === 'max1' && d > 1 + s) return false;
				if (form === 'max2' && d > 2 + s) return false;
				if (form === 'min2' && d < 2 + s) return false;
				return fnmatch(`*.${ext}`, base(e.path), !!o.hidden);
			})
			.map((e) => `./${e.path}`);
	return {
		entries,
		script: `find . ${limit}-type f -name '*.${ext}'`,
		answer: select({}),
		wrong: { 'find-skips-hidden': select({ hidden: true }), 'depth-off-by-one': select({ shift: 1 }) },
		details: false
	};
}

/** `find -size` rounds the size up to whole units; `-newer` is strictly newer than the reference file. */
function findSizeNewer(rng: Rng): Scenario {
	const exts = rng.sample(EXTS, 3);
	const entries = tree(rng, exts);
	const ref = rng.pick(entries.filter((e) => !base(e.path).startsWith('.')));
	// Some files share the reference's time to the second.
	for (const e of rng.sample(entries, 2)) if (e !== ref) e.time = ref.time;
	const size = rng.pick(['-1k', '-2k', '+1k', '+2k'] as const);
	const n = Number(size.slice(1, 2));
	const units = (bytes: number) => Math.ceil(bytes / 1024);
	const sizeOk = (bytes: number, exact: boolean) =>
		size.startsWith('-') ? (exact ? bytes < n * 1024 : units(bytes) < n) : exact ? bytes > n * 1024 : units(bytes) > n;
	const select = (o: { exact?: boolean; orEqual?: boolean }) =>
		entries
			.filter((e) => sizeOk(e.size, !!o.exact) && (o.orEqual ? e.time >= ref.time && e !== ref : e.time > ref.time))
			.map((e) => `./${e.path}`);
	return {
		entries,
		script: `find . -type f -newer ${ref.path} -size ${size}`,
		answer: select({}),
		wrong: { 'size-in-bytes': select({ exact: true }), 'newer-or-equal': select({ orEqual: true }) },
		details: true
	};
}

/** `-a` binds tighter than `-o`: `A -o B -type f` is `A -o (B -a -type f)`. */
function findOperators(rng: Rng): Scenario {
	const exts = rng.sample(EXTS, 3);
	const entries = tree(rng, exts);
	const [e1, e2] = rng.sample(exts, 2) as [string, string];
	// Directories named like both patterns.
	const [s1, s2] = rng.sample(DIR_STEMS, 2) as [string, string];
	const d1 = `${s1}.${e1}`;
	const d2 = `${s2}.${e2}`;
	entries.push({ path: `${d1}/part1.txt`, size: 10, time: 0 }, { path: `${d2}/part2.txt`, size: 10, time: 0 });
	const typeFirst = rng.bool();
	const all = [
		...entries.map((e) => ({ path: e.path, dir: false })),
		...dirsOf(entries).map((path) => ({ path, dir: true }))
	];
	const select = (pred: (x: { path: string; dir: boolean }) => boolean) => all.filter(pred).map((x) => `./${x.path}`);
	const n1 = (x: { path: string }) => fnmatch(`*.${e1}`, base(x.path), false);
	const n2 = (x: { path: string }) => fnmatch(`*.${e2}`, base(x.path), false);
	const file = (x: { dir: boolean }) => !x.dir;
	return {
		entries,
		script: typeFirst
			? `find . -type f -name '*.${e1}' -o -name '*.${e2}'`
			: `find . -name '*.${e1}' -o -name '*.${e2}' -type f`,
		answer: typeFirst ? select((x) => (file(x) && n1(x)) || n2(x)) : select((x) => n1(x) || (n2(x) && file(x))),
		wrong: {
			'or-left-to-right': typeFirst
				? select((x) => file(x) && (n1(x) || n2(x)))
				: select((x) => (n1(x) || n2(x)) && file(x)),
			'find-skips-hidden': typeFirst
				? select((x) => (file(x) && n1(x)) || n2(x)).filter((p) => !base(p).startsWith('.'))
				: select((x) => n1(x) || (n2(x) && file(x))).filter((p) => !base(p).startsWith('.'))
		},
		details: false
	};
}

const MAKERS: Record<string, (rng: Rng) => Scenario> = {
	glob: globs,
	'find-name': findName,
	'find-size-newer': findSizeNewer,
	'find-operators': findOperators
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	glob: ['glob-matches-hidden', 'glob-empty-vanishes'],
	'find-name': ['find-skips-hidden', 'depth-off-by-one'],
	'find-size-newer': ['size-in-bytes', 'newer-or-equal'],
	'find-operators': ['or-left-to-right']
};

const asSet = (paths: readonly string[]): string[] => [...new Set(paths)].sort();

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = MAKERS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.classId}`);
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const s = make(rng);
		const answer = asSet(s.answer);
		if (answer.length < 2) continue;
		const key = JSON.stringify(answer);
		const wrong = Object.fromEntries(
			descriptor.wrongSolutions.map(({ id }) => {
				const paths = s.wrong[id];
				const value = paths === undefined ? null : asSet(paths);
				return [id, value === null || JSON.stringify(value) === key ? null : value];
			})
		);
		const required = REQUIRED[input.classId] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const files: ShellFile[] = s.entries.map((e) => ({ path: e.path, content: content(e.size), mtime: stamp(e.time) }));
		const sorted = [...s.entries].sort((a, b) => (a.path < b.path ? -1 : 1));
		const listing = s.details
			? [
					'| Файл | Размер, байт | Изменён (UTC) |',
					'| --- | --- | --- |',
					...sorted.map((e) => `| \`${e.path}\` | ${e.size} | ${human(e.time)} |`)
				]
			: ['```', ...sorted.map((e) => e.path), '```'];
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					'В текущем каталоге лежат файлы (вложенные каталоги видны по путям, других файлов и каталогов нет):',
					'',
					...listing,
					'',
					'Скрипт запущен в bash с настройками по умолчанию. Какие строки он напечатает? Порядок не важен: введите по строке на путь, ровно в том виде, как его печатает команда (например, `./logs/app.log` у `find` или `logs/app.log` у `printf`). Если не напечатает ничего — введите `-`.'
				].join('\n'),
				code: { language: 'shell', source: s.script }
			},
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => bashProbe({ script: `${s.script}\n`, files }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
