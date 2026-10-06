// Fields and edits of text: what `cut`, `tr`, `sed`, `awk`, `paste` and `join` print on generated files. The model
// computes the output by the rules of GNU coreutils, GNU sed and POSIX awk in the C locale; the gate runs the shown
// script with the real tools of the sandbox image (its awk is mawk, so the scripts use only portable awk).
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';
import { bashProbe, type ShellFile } from '../../_lib/shell.ts';

const descriptor = readDescriptor(import.meta.url);

const byteCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const SHELLS = ['/bin/bash', '/bin/sh', '/usr/sbin/nologin', '/bin/zsh'] as const;
const ROLES = ['dev', 'ops', 'qa', 'admin', 'audit', 'deploy'] as const;
const HOST_KINDS = ['web', 'db', 'cache', 'queue', 'api', 'auth'] as const;
const ENVS = ['prod', 'stage', 'dev'] as const;
const SERVICES = ['nginx', 'redis', 'postgres', 'kafka', 'minio', 'grafana'] as const;
const JOBS = ['build', 'test', 'deploy', 'backup', 'migrate', 'lint'] as const;
const STEPS = ['fetch', 'compile', 'pack', 'upload', 'verify', 'notify', 'cleanup'] as const;

interface Scenario {
	files: ShellFile[];
	/** The files as the statement shows them, in order. */
	shown: string[];
	/** Misconceptions this instance must expose beyond those of its class. */
	required?: string[];
	script: string[];
	answer: string[];
	wrong: Record<string, string[]>;
}

const file = (path: string, lines: readonly string[]): ShellFile => ({ path, content: `${lines.join('\n')}\n` });

function hostName(rng: Rng): string {
	return `${rng.pick(HOST_KINDS)}-${String(rng.int(1, 29)).padStart(2, '0')}.${rng.pick(ENVS)}`;
}

/** Distinct values from a drawing function. */
function distinct<T>(count: number, draw: () => T): T[] {
	const seen = new Map<string, T>();
	for (let i = 0; seen.size < count && i < count * 50; i += 1) {
		const v = draw();
		seen.set(JSON.stringify(v), v);
	}
	if (seen.size < count) throw new Error('not enough distinct values');
	return [...seen.values()];
}

// ----- Intern -----------------------------------------------------------------------------------------------

/** `cut -d: -f<b>,<a>` over a passwd-like file with a comment line: fields come in file order, the comment whole. */
function cutFields(rng: Rng): Scenario {
	const names = rng.sample(PERSON_NAMES, rng.int(4, 5));
	const rows = names.map((name, i) => {
		const uid = 1000 + i * rng.int(1, 7) + rng.int(0, 3);
		return [name, 'x', String(uid), String(1000 + rng.int(0, 9)), rng.pick(ROLES), `/home/${name}`, rng.pick(SHELLS)];
	});
	const comment = `# ${rng.pick(['service', 'staff', 'contractor'])} accounts`;
	const lines = rows.map((r) => r.join(':'));
	lines.splice(rng.int(1, lines.length - 1), 0, comment);
	const [a, b] = rng.sample([1, 3, 5, 6, 7], 2).sort((x, y) => x - y) as [number, number];
	const suppress = rng.bool(0.4);
	// `keepPlain`: whether a line without the delimiter is printed (it is, unless `-s`).
	const run = (order: number[], keepPlain: boolean) =>
		lines.flatMap((line) => {
			if (!line.includes(':')) return keepPlain ? [line] : [];
			const f = line.split(':');
			return [order.map((i) => f[i - 1] ?? '').join(':')];
		});
	const path = rng.pick(['users.txt', 'accounts.txt', 'passwd.txt']);
	return {
		files: [file(path, lines)],
		shown: [path],
		script: [`cut${suppress ? ' -s' : ''} -d: -f${b},${a} ${path}`],
		answer: run([a, b], !suppress),
		wrong: {
			'cut-reorders': run([b, a], !suppress),
			...(suppress ? { 'cut-s-ignored': run([a, b], true) } : { 'cut-skips-nodelim': run([a, b], false) })
		}
	};
}

/** `tr -s`, `tr -d` with a range and `tr` with a shorter second set (GNU pads it with its last character). */
function trPipeline(rng: Rng): Scenario {
	const hosts = distinct(rng.int(4, 5), () => hostName(rng));
	const lines = hosts.map((h) => {
		const gap = ' '.repeat(rng.int(1, 4));
		return `${h}${gap}${rng.pick(['UP', 'DOWN', 'DRAIN'])}${' '.repeat(rng.int(1, 3))}${rng.int(1, 99)}`;
	});
	const path = rng.pick(['hosts.txt', 'status.txt', 'inventory.txt']);
	// The generated text is ASCII: splitting into UTF-16 units is splitting into characters.
	const del = (s: string, chars: string) =>
		s
			.split('')
			.filter((ch) => !chars.includes(ch))
			.join('');
	const upper = (s: string, dashToo: boolean) =>
		s
			.split('')
			.map((ch) => (ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch === '.' ? '_' : ch === '-' && dashToo ? '_' : ch))
			.join('');
	const first = lines.map((l) => l.replace(/ +/g, ' ').split(' ')[0] ?? '');
	return {
		files: [file(path, lines)],
		shown: [path],
		script: [`tr -s ' ' < ${path} | cut -d' ' -f1 | tr -d '0-9' | tr 'a-z.-' 'A-Z_'`],
		answer: first.map((h) => upper(del(h, '0123456789'), true)),
		wrong: {
			'tr-range-literal': first.map((h) => upper(del(h, '0-9'), true)),
			'tr-set2-no-pad': first.map((h) => upper(del(h, '0123456789'), false))
		}
	};
}

/** `sed` over a config: delete comments, then a substitution that is greedy, first-only or global; a line range. */
function sedEdits(rng: Rng): Scenario {
	const keys = rng.sample(['db_url', 'cache_url', 'mode', 'flags', 'opts', 'dsn', 'proxy', 'labels'], rng.int(4, 5));
	const values: Record<string, () => string> = {
		db_url: () => `postgres://app@db:5432/main?sslmode=${rng.pick(['disable', 'require'])}`,
		cache_url: () => `redis://cache:6379/${rng.int(0, 9)}?timeout=${rng.int(1, 9)}s`,
		mode: () => rng.pick(['fast', 'safe', 'debug']),
		flags: () => `a=${rng.int(1, 9)},b=${rng.int(1, 9)}`,
		opts: () => `retries=${rng.int(1, 5)}`,
		dsn: () => `host=db port=${rng.int(5000, 5999)}`,
		proxy: () => `http://proxy:${rng.int(3000, 3999)}`,
		labels: () => `env=${rng.pick(ENVS)}`
	};
	const lines = keys.map((k) => `${k}=${values[k]?.() ?? ''}`);
	lines.splice(rng.int(0, lines.length - 1), 0, `# ${rng.pick(['generated', 'edited by hand', 'defaults'])}`);
	const op = rng.pick(['greedy', 'first', 'global'] as const);
	const range = rng.bool(0.5);
	const path = rng.pick(['app.conf', 'service.env', 'settings.ini']);
	const data = lines.filter((l) => !l.startsWith('#'));
	const from = rng.int(2, Math.max(2, data.length - 1));
	const to = Math.min(data.length, from + rng.int(0, 1));
	const sub = (l: string, how: 'greedy' | 'lazy' | 'first' | 'global'): string => {
		if (how === 'greedy') return l.slice(l.lastIndexOf('=') + 1);
		if (how === 'lazy') return l.slice(l.indexOf('=') + 1);
		if (how === 'first') return l.replace('=', ' -> ');
		return l.replaceAll('=', ' -> ');
	};
	const deleteRange = (ls: string[], inclusive: boolean) =>
		range ? ls.filter((_, i) => (inclusive ? i + 1 < from || i + 1 > to : i + 1 <= from || i + 1 >= to)) : ls;
	const run = (how: 'greedy' | 'lazy' | 'first' | 'global', inclusive: boolean) =>
		deleteRange(data, inclusive).map((l) => sub(l, how));
	const expr = op === 'greedy' ? 's/.*=//' : op === 'first' ? 's/=/ -> /' : 's/=/ -> /g';
	const script = range
		? `sed '/^#/d' ${path} | sed '${from},${to}d' | sed '${expr}'`
		: `sed -e '/^#/d' -e '${expr}' ${path}`;
	const right = op;
	const wrong: Record<string, string[]> = {};
	if (op === 'greedy') wrong['sed-lazy-match'] = run('lazy', true);
	if (op === 'first') wrong['sed-replace-all'] = run('global', true);
	if (op === 'global') wrong['sed-g-ignored'] = run('first', true);
	if (range && to > from) wrong['sed-range-exclusive'] = run(right, false);
	return {
		files: [file(path, lines)],
		shown: [path],
		script: [script],
		answer: run(right, true),
		wrong,
		required: Object.keys(wrong)
	};
}

/** `awk -F,` summing by key in an associative array; the header line is not skipped and sums to 0. */
function awkSum(rng: Rng): Scenario {
	const services = rng.sample(SERVICES, rng.int(3, 4));
	const rows = Array.from({ length: rng.int(6, 8) }, () => [
		rng.pick(services),
		rng.pick(ENVS),
		String(rng.int(1, 999))
	]);
	for (const s of services) if (!rows.some((r) => r[0] === s)) rows.push([s, rng.pick(ENVS), String(rng.int(1, 999))]);
	const header = rng.pick([
		['service', 'env', 'mb'],
		['name', 'stage', 'size']
	]);
	const path = rng.pick(['traffic.csv', 'usage.csv', 'disk.csv']);
	const lines = [header.join(','), ...rows.map((r) => r.join(','))];
	const sums = new Map<string, number>();
	for (const r of rows) sums.set(r[0] ?? '', (sums.get(r[0] ?? '') ?? 0) + Number(r[2]));
	const out = (withHeader: boolean) =>
		[...(withHeader ? [`${header[0]} 0`] : []), ...[...sums].map(([k, v]) => `${k} ${v}`)].sort(byteCmp);
	return {
		files: [file(path, lines)],
		shown: [path],
		script: [`awk -F, '{ sum[$1] += $3 } END { for (k in sum) print k, sum[k] }' ${path} | sort`],
		answer: out(true),
		wrong: { 'awk-header-skipped': out(false) }
	};
}

// ----- Junior -----------------------------------------------------------------------------------------------

/** `paste -d:` of files of different lengths and `paste -sd` with a list of delimiters used in turn. */
function pasteFiles(rng: Rng): Scenario {
	const n = rng.int(4, 5);
	const hosts = distinct(n, () => hostName(rng));
	const ports = distinct(n, () => String(rng.pick([22, 80, 443, 3000, 5432, 6379, 8080, 9090, 9100])));
	const hostsShort = rng.bool();
	const hostLines = hostsShort ? hosts.slice(0, n - rng.int(1, 2)) : hosts;
	const portLines = hostsShort ? ports : ports.slice(0, n - rng.int(1, 2));
	const delims = rng.pick([',;', ';,', '+-', '|,']);
	const [h, p] = rng.pick([
		['hosts.txt', 'ports.txt'],
		['nodes.txt', 'listen.txt']
	]);
	const rows = Math.max(hostLines.length, portLines.length);
	const pasted = Array.from({ length: rows }, (_, i) => `${hostLines[i] ?? ''}:${portLines[i] ?? ''}`);
	const short = Math.min(hostLines.length, portLines.length);
	const serial = (cycle: boolean) =>
		portLines.reduce(
			(acc, v, i) => (i === 0 ? v : `${acc}${cycle ? (delims[(i - 1) % delims.length] ?? '') : delims}${v}`),
			''
		);
	return {
		files: [file(h, hostLines), file(p, portLines)],
		shown: [h, p],
		script: [`paste -d: ${h} ${p}`, `paste -sd'${delims}' ${p}`],
		answer: [...pasted, serial(true)],
		wrong: {
			'paste-stops-short': [...pasted.slice(0, short), serial(true)],
			'paste-delims-whole': [...pasted, serial(false)]
		}
	};
}

/** `join -t,` of two key-sorted files: only paired keys (or `-a1`, `-v2`), a key twice in one file pairs twice. */
function joinFiles(rng: Rng): Scenario {
	const users: string[] = rng.sample(PERSON_NAMES, rng.int(4, 5)).sort(byteCmp);
	const mode = rng.pick(['plain', 'a1', 'v2'] as const);
	const left: [string, string][] = users.map((u) => [u, String(rng.int(1000, 1999))]);
	// Roles: some users have none, one has two, and some roles belong to unknown users.
	const withRoles = rng.sample(users, users.length - rng.int(1, 2));
	const twice = rng.pick(withRoles);
	const strangers = rng.sample(
		PERSON_NAMES.filter((p) => !users.includes(p)),
		rng.int(1, 2)
	);
	const right: [string, string][] = [
		...withRoles.map((u): [string, string] => [u, rng.pick(ROLES)]),
		[twice, rng.pick(ROLES)],
		...strangers.map((s): [string, string] => [s, rng.pick(ROLES)])
	];
	// Sorted by the key, then the role, so equal keys are in a known order.
	right.sort((a, b) => byteCmp(a[0], b[0]) || byteCmp(a[1], b[1]));
	const rolesOf = (u: string, firstOnly: boolean) => {
		const all = right.filter((r) => r[0] === u);
		return firstOnly ? all.slice(0, 1) : all;
	};
	/** Output lines keyed by the join field, merged in key order (stable for equal keys). */
	const merge = (rows: [string, string][]) => rows.sort((a, b) => byteCmp(a[0], b[0])).map((r) => r[1]);
	const pairedRows = (firstOnly: boolean): [string, string][] =>
		left.flatMap(([u, uid]) => rolesOf(u, firstOnly).map((r): [string, string] => [u, `${u},${uid},${r[1]}`]));
	const unpairedLeftRows = left
		.filter(([u]) => rolesOf(u, false).length === 0)
		.map(([u, uid]): [string, string] => [u, `${u},${uid}`]);
	const unpairedRightRows = right
		.filter(([u]) => !users.includes(u))
		.map(([u, role]): [string, string] => [u, `${u},${role}`]);
	const opt = mode === 'plain' ? '' : mode === 'a1' ? ' -a1' : ' -v2';
	const [lf, rf] = rng.pick([
		['users.csv', 'roles.csv'],
		['accounts.csv', 'grants.csv']
	] as const);
	let answer: string[];
	const wrong: Record<string, string[]> = {};
	if (mode === 'plain') {
		answer = merge(pairedRows(false));
		wrong['join-first-match'] = merge(pairedRows(true));
		wrong['join-keeps-unpaired'] = merge([...pairedRows(false), ...unpairedLeftRows]);
	} else if (mode === 'a1') {
		answer = merge([...pairedRows(false), ...unpairedLeftRows]);
		wrong['join-first-match'] = merge([...pairedRows(true), ...unpairedLeftRows]);
		wrong['join-a-only-unpaired'] = merge(unpairedLeftRows);
	} else {
		answer = merge(unpairedRightRows);
		wrong['join-v-file-one'] = merge(unpairedLeftRows);
		wrong['join-a-only-unpaired'] = merge([...pairedRows(false), ...unpairedRightRows]);
	}
	return {
		files: [
			file(
				lf,
				left.map((r) => r.join(','))
			),
			file(
				rf,
				right.map((r) => r.join(','))
			)
		],
		shown: [lf, rf],
		script: [`join -t,${opt} ${lf} ${rf}`],
		answer,
		wrong,
		required: Object.keys(wrong)
	};
}

/** `sed -n '/start/,/end/p'`: the range is printed with both ends and starts again at every later start line. */
function sedRanges(rng: Rng): Scenario {
	const jobs = rng.sample(JOBS, 3);
	const lines: string[] = [];
	const noise = () => `info ${rng.pick(['tick', 'heartbeat', 'gc', 'poll'])} ${rng.int(1, 99)}`;
	const unfinished = rng.bool(0.4);
	jobs.forEach((job, j) => {
		if (rng.bool(0.7)) lines.push(noise());
		lines.push(`start ${job}`);
		for (const step of rng.sample(STEPS, rng.int(1, 2))) lines.push(`step ${step}`);
		if (!(unfinished && j === jobs.length - 1)) lines.push(`done ${job}`);
	});
	if (!unfinished) lines.push(noise());
	const path = rng.pick(['deploy.log', 'ci.log', 'runner.log']);
	const ranges = (once: boolean, endInclusive: boolean) => {
		const out: string[] = [];
		let inside = false;
		let used = false;
		for (const l of lines) {
			if (!inside) {
				if (l.startsWith('start ') && !(once && used)) {
					inside = true;
					used = true;
					out.push(l);
				}
			} else if (l.startsWith('done ')) {
				inside = false;
				if (endInclusive) out.push(l);
			} else out.push(l);
		}
		return out;
	};
	return {
		files: [file(path, lines)],
		shown: [path],
		script: [`sed -n '/^start /,/^done /p' ${path}`],
		answer: ranges(false, true),
		wrong: { 'sed-range-once': ranges(true, true), 'sed-range-exclusive': ranges(false, false) }
	};
}

/** `awk -F'[ :]'` with `$NF-1` (the last field minus one, not the field before it) summed by key, sorted by sum. */
function awkFields(rng: Rng): Scenario {
	const services = rng.sample(SERVICES, 3);
	const rows = Array.from({ length: rng.int(5, 7) }, () => ({
		svc: rng.pick(services),
		host: hostName(rng),
		ms: rng.int(10, 400),
		count: rng.int(2, 60)
	}));
	for (const s of services)
		if (!rows.some((r) => r.svc === s))
			rows.push({ svc: s, host: hostName(rng), ms: rng.int(10, 400), count: rng.int(2, 60) });
	const lines = rows.map((r) => `${r.svc}:${r.host} ${r.ms} ${r.count}`);
	const path = rng.pick(['latency.txt', 'timings.txt']);
	const sums = (value: (r: (typeof rows)[number]) => number) => {
		const m = new Map<string, number>();
		for (const r of rows) m.set(r.svc, (m.get(r.svc) ?? 0) + value(r));
		return [...m];
	};
	const order = (entries: [string, number][], numeric: boolean) =>
		entries
			.sort((a, b) =>
				numeric ? b[1] - a[1] || byteCmp(a[0], b[0]) : byteCmp(String(b[1]), String(a[1])) || byteCmp(a[0], b[0])
			)
			.map(([k, v]) => `${k} ${v}`);
	const right = sums((r) => r.count - 1);
	return {
		files: [file(path, lines)],
		shown: [path],
		script: [`awk -F'[ :]' '{ t[$1] += $NF-1 } END { for (k in t) print k, t[k] }' ${path} | sort -t' ' -k2,2nr -k1,1`],
		answer: order(right, true),
		wrong: {
			'awk-nf-minus-one-field': order(
				sums((r) => r.ms),
				true
			),
			'key-as-text': order(right, false)
		}
	};
}

const MAKERS: Record<string, (rng: Rng) => Scenario> = {
	cut: cutFields,
	tr: trPipeline,
	sed: sedEdits,
	'awk-sum': awkSum,
	paste: pasteFiles,
	join: joinFiles,
	'sed-ranges': sedRanges,
	'awk-fields': awkFields
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	cut: ['cut-reorders'],
	tr: ['tr-range-literal', 'tr-set2-no-pad'],
	sed: [],
	'awk-sum': ['awk-header-skipped'],
	paste: ['paste-stops-short', 'paste-delims-whole'],
	join: [],
	'sed-ranges': ['sed-range-once', 'sed-range-exclusive'],
	'awk-fields': ['awk-nf-minus-one-field']
};

const valid = (answer: readonly string[]): boolean =>
	answer.length > 0 && answer.every((l) => l.length > 0 && l.trim() === l);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = MAKERS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.classId}`);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const s = make(rng);
		if (!valid(s.answer)) continue;
		const key = JSON.stringify(s.answer);
		const wrong = Object.fromEntries(
			descriptor.wrongSolutions.map(({ id }) => {
				const value = s.wrong[id];
				return [id, value === undefined || JSON.stringify(value) === key ? null : value];
			})
		);
		const required = [...(REQUIRED[input.classId] ?? []), ...(s.required ?? [])];
		if (required.some((id) => wrong[id] === null)) continue;
		// At least one misconception shows on every instance.
		if (Object.values(wrong).every((v) => v === null)) continue;
		const script = s.script.join('\n');
		const shown = s.shown.flatMap((path) => {
			const f = s.files.find((x) => x.path === path);
			return ['', `\`${path}\`:`, '', '```', ...(f ? f.content.replace(/\n$/, '').split('\n') : []), '```'];
		});
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					`В текущем каталоге лежат файлы (пробелы внутри строк сохранены как есть):`,
					...shown,
					'',
					'Скрипт запущен в bash с локалью `LC_ALL=C` (строки сравниваются побайтно). Что он напечатает? Введите вывод построчно, как он появится на экране.'
				].join('\n'),
				code: { language: 'shell', source: script }
			},
			answer: { kind: 'sequence', value: s.answer }
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
