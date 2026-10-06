// A pipeline over a generated access log: what `grep`, `cut`, `sort`, `uniq`, `head` and `tail` print. The model
// below computes the output with the rules of GNU coreutils in the C locale; the gate runs the shown script with the
// real tools of the sandbox image.
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

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
const PATHS = [
	'/api/orders',
	'/api/users',
	'/api/items',
	'/api/cart',
	'/login',
	'/logout',
	'/health',
	'/metrics',
	'/static/app.js',
	'/static/main.css',
	'/search',
	'/admin'
] as const;
const STATUSES = [200, 201, 204, 301, 304, 400, 401, 403, 404, 500, 502, 503] as const;
const LOG_NAMES = ['access.log', 'nginx.log', 'requests.log', 'gateway.log'] as const;

interface Entry {
	ip: string;
	method: string;
	path: string;
	status: number;
	bytes: number;
}

const line = (e: Entry): string => `${e.ip} ${e.method} ${e.path} ${e.status} ${e.bytes}`;
const fieldsOf = (text: string): string[] => text.split(' ');

/** Byte order of the C locale; the generated text is ASCII. */
const byteCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A sort key as `-t' ' -kF[,L][n][r]` gives it: fields F..L of a space-separated line (L = null — to the end). */
interface SortKey {
	from: number;
	to: number | null;
	numeric: boolean;
	reverse: boolean;
}

function keyText(text: string, key: SortKey): string {
	const f = fieldsOf(text);
	return f.slice(key.from - 1, key.to === null ? f.length : key.to).join(' ');
}

/** The leading number of a key, as `sort -n` reads it; no number reads as zero. */
function numberOf(text: string): number {
	const m = /^\s*(-?\d+)/.exec(text);
	return m ? Number(m[1]) : 0;
}

function compareKeys(a: string, b: string, keys: readonly SortKey[]): number {
	for (const key of keys) {
		const [x, y] = [keyText(a, key), keyText(b, key)];
		let c = key.numeric ? Math.sign(numberOf(x) - numberOf(y)) : byteCmp(x, y);
		if (key.reverse) c = -c;
		if (c !== 0) return c;
	}
	return 0;
}

/**
 * GNU `sort -t' '` with keys: equal keys fall back to the whole line in byte order unless `-s` (stable) or `-u`
 * (unique: the first line of each run of equal keys, in input order). Without keys the whole line is the key.
 */
function sortLines(
	input: readonly string[],
	opts: { keys?: readonly SortKey[]; numeric?: boolean; reverse?: boolean; stable?: boolean; unique?: boolean }
): string[] {
	const keys = opts.keys ?? [{ from: 1, to: null, numeric: opts.numeric ?? false, reverse: opts.reverse ?? false }];
	const indexed = input.map((text, i) => ({ text, i }));
	indexed.sort((a, b) => {
		const c = compareKeys(a.text, b.text, keys);
		if (c !== 0) return c;
		if (opts.stable || opts.unique) return a.i - b.i;
		const last = opts.keys ? byteCmp(a.text, b.text) : 0;
		return last !== 0 ? last : a.i - b.i;
	});
	const sorted = indexed.map((x) => x.text);
	if (!opts.unique) return sorted;
	return sorted.filter((text, i) => i === 0 || compareKeys(sorted[i - 1] ?? '', text, keys) !== 0);
}

/** `uniq -c`: runs of equal adjacent lines, as [count, line]. */
function uniqCount(input: readonly string[]): [number, string][] {
	const runs: [number, string][] = [];
	for (const text of input) {
		const last = runs[runs.length - 1];
		if (last && last[1] === text) last[0] += 1;
		else runs.push([1, text]);
	}
	return runs;
}

/** `uniq -c` as it prints: the count right-aligned in seven columns, a space, the line. */
const uniqLine = ([count, text]: [number, string]): string => `${String(count).padStart(7)} ${text}`;

/** Counting by whole groups in order of first appearance — what `uniq -c` would do if it were not about neighbours. */
function groupCount(input: readonly string[]): [number, string][] {
	const counts = new Map<string, number>();
	for (const text of input) counts.set(text, (counts.get(text) ?? 0) + 1);
	return [...counts].map(([text, count]) => [count, text]);
}

function ipPool(rng: Rng, count: number): string[] {
	const net = rng.int(0, 9);
	const hosts = new Set<string>();
	while (hosts.size < count) hosts.add(`10.${net}.${rng.int(0, 3)}.${rng.int(2, 254)}`);
	return [...hosts];
}

/** A byte count with a random number of digits, so lexicographic and numeric order part ways. */
const bytesDraw = (rng: Rng): number => {
	const digits = rng.int(2, 5);
	return rng.int(10 ** (digits - 1), 10 ** digits - 1);
};

function entries(rng: Rng, count: number, ips: readonly string[], paths: readonly string[]): Entry[] {
	return Array.from({ length: count }, () => ({
		ip: rng.pick(ips),
		method: rng.pick(METHODS),
		path: rng.pick(paths),
		status: rng.pick(STATUSES),
		bytes: bytesDraw(rng)
	}));
}

interface Scenario {
	file: string;
	log: Entry[];
	script: string[];
	answer: string[];
	wrong: Record<string, string[]>;
}

// ----- Intern -----------------------------------------------------------------------------------------------

function lexSort(rng: Rng, file: string): Scenario {
	const log = entries(rng, rng.int(8, 11), ipPool(rng, 5), rng.sample(PATHS, 6));
	const status = rng.pick(log).status;
	const keep = log.filter((e) => e.status !== status);
	const bytes = keep.map((e) => String(e.bytes));
	const n = rng.int(3, 4);
	const end = rng.pick(['head', 'tail', 'reverse'] as const);
	const tailCmd =
		end === 'head' ? `sort | head -n ${n}` : end === 'tail' ? `sort | tail -n ${n}` : `sort -r | head -n ${n}`;
	const pick = (sorted: string[]): string[] =>
		end === 'head' ? sorted.slice(0, n) : end === 'tail' ? sorted.slice(-n) : [...sorted].reverse().slice(0, n);
	const lex = sortLines(bytes, {});
	const num = sortLines(bytes, { numeric: true });
	return {
		file,
		log,
		script: [`grep -v ' ${status} ' ${file} | cut -d' ' -f5 | ${tailCmd}`],
		answer: pick(lex),
		wrong: {
			'numeric-sort': pick(num),
			'grep-v-keeps': pick(
				sortLines(
					log.filter((e) => e.status === status).map((e) => String(e.bytes)),
					{}
				)
			)
		}
	};
}

function uniqAdjacent(rng: Rng, file: string): Scenario {
	const ips = ipPool(rng, 4);
	const count = rng.int(9, 12);
	const log: Entry[] = [];
	// Runs of one address, so `uniq` has neighbours to merge and repeats that are not neighbours.
	while (log.length < count) {
		const ip = rng.pick(ips);
		const run = rng.int(1, 3);
		for (let i = 0; i < run && log.length < count; i += 1) log.push(...entries(rng, 1, [ip], PATHS));
	}
	const filter = rng.bool();
	const method = rng.pick(METHODS);
	const selected = filter ? log.filter((e) => e.method !== method) : log;
	const ipsOut = selected.map((e) => e.ip);
	const fmt = (runs: [number, string][]) => runs.map(([c, ip]) => `${ip} ${c}`);
	return {
		file,
		log,
		script: [
			`${filter ? `grep -v ' ${method} ' ${file} | cut -d' ' -f1` : `cut -d' ' -f1 ${file}`} | uniq -c | awk '{print $2, $1}'`
		],
		answer: fmt(uniqCount(ipsOut)),
		wrong: {
			'uniq-groups-all': fmt(groupCount(ipsOut)),
			'uniq-sorts': fmt(uniqCount(sortLines(ipsOut, {})))
		}
	};
}

function grepCount(rng: Rng, file: string): Scenario {
	const net = rng.int(1, 8);
	// Addresses of the subnet `10.<net>.`, and look-alikes the unescaped dot also matches: `10.<net>5.`, `10.<net>x`.
	const prefix = `10.${net}.`;
	const lookalikes = [`10.${net}${rng.int(0, 9)}.${rng.int(0, 3)}.${rng.int(2, 254)}`];
	lookalikes.push(`10.${net}${rng.int(0, 9)}.${rng.int(0, 3)}.${rng.int(2, 254)}`);
	const own = Array.from({ length: 3 }, () => `${prefix}${rng.int(0, 3)}.${rng.int(2, 254)}`);
	const others = Array.from({ length: 2 }, () => `172.16.${rng.int(0, 9)}.${rng.int(2, 254)}`);
	const ips = [...own, ...lookalikes, ...others];
	const log = entries(rng, rng.int(9, 12), ips, PATHS);
	const status = rng.pick(log).status;
	const word = rng.pick(['api', 'static'] as const);
	// Some requests repeat the word in the query, so matching lines and matches differ.
	for (const e of log) if (e.path.includes(word) && rng.bool(0.5)) e.path = `${e.path}?src=${word}`;
	if (!log.some((e) => e.path.split(word).length > 2)) {
		const target = rng.pick(log);
		target.path = `/${word}/v${rng.int(1, 3)}?src=${word}`;
	}
	const method = rng.pick(METHODS);
	const pattern = `^10.${net}.`;
	const count = (pred: (e: Entry) => boolean) => String(log.filter(pred).length);
	const occurrences = String(log.reduce((n, e) => n + e.path.split(word).length - 1, 0));
	const regexDot = new RegExp(`^10.${net}.`);
	const literal = (e: Entry) => e.ip.startsWith(prefix);
	return {
		file,
		log,
		script: [
			`echo "status ${status}: $(grep -c ' ${status} ' ${file})"`,
			`echo "net: $(grep -c '${pattern}' ${file})"`,
			`echo "${word}: $(grep -c '${word}' ${file})"`,
			`echo "not ${method}: $(grep -vc ' ${method} ' ${file})"`
		],
		answer: [
			`status ${status}: ${count((e) => e.status === status)}`,
			`net: ${count((e) => regexDot.test(line(e)))}`,
			`${word}: ${count((e) => e.path.includes(word))}`,
			`not ${method}: ${count((e) => e.method !== method)}`
		],
		wrong: {
			'dot-literal': [
				`status ${status}: ${count((e) => e.status === status)}`,
				`net: ${count(literal)}`,
				`${word}: ${count((e) => e.path.includes(word))}`,
				`not ${method}: ${count((e) => e.method !== method)}`
			],
			'count-occurrences': [
				`status ${status}: ${count((e) => e.status === status)}`,
				`net: ${count((e) => regexDot.test(line(e)))}`,
				`${word}: ${occurrences}`,
				`not ${method}: ${count((e) => e.method !== method)}`
			],
			'grep-v-keeps': [
				`status ${status}: ${count((e) => e.status === status)}`,
				`net: ${count((e) => regexDot.test(line(e)))}`,
				`${word}: ${count((e) => e.path.includes(word))}`,
				`not ${method}: ${count((e) => e.method === method)}`
			]
		}
	};
}

function tailHead(rng: Rng, file: string): Scenario {
	const log = entries(rng, rng.int(9, 12), ipPool(rng, 6), PATHS);
	const from = rng.int(3, 5);
	const m = rng.int(3, 4);
	const take = (start: number) => log.slice(start, start + m).map((e) => `${e.path} ${e.status}`);
	return {
		file,
		log,
		script: [`tail -n +${from} ${file} | head -n ${m} | cut -d' ' -f3,4`],
		answer: take(from - 1),
		wrong: {
			'tail-plus-skips': take(from),
			'tail-plus-last': log
				.slice(-from)
				.slice(0, m)
				.map((e) => `${e.path} ${e.status}`)
		}
	};
}

// ----- Junior -----------------------------------------------------------------------------------------------

function keyNumeric(rng: Rng, file: string): Scenario {
	const ips = ipPool(rng, 7);
	const log = entries(rng, rng.int(9, 11), ips, PATHS);
	// Equal byte counts at the top, on different addresses, so the second key decides.
	const top = Math.max(...log.map((e) => e.bytes));
	const tied = rng.sample(log, rng.int(2, 3));
	for (const e of tied) e.bytes = top;
	const n = rng.int(4, 5);
	const lines = log.map(line);
	const keys = (bytesNumeric: boolean, ipReverse: boolean): SortKey[] => [
		{ from: 5, to: 5, numeric: bytesNumeric, reverse: true },
		{ from: 1, to: 1, numeric: false, reverse: ipReverse }
	];
	const fmt = (sorted: string[]) =>
		sorted.slice(0, n).map((l) => {
			const f = fieldsOf(l);
			return `${f[0]} ${f[4]}`;
		});
	const fileOrder = [...lines].sort((a, b) => numberOf(fieldsOf(b)[4] ?? '') - numberOf(fieldsOf(a)[4] ?? ''));
	return {
		file,
		log,
		script: [`sort -t' ' -k5,5nr -k1,1 ${file} | head -n ${n} | cut -d' ' -f1,5`],
		answer: fmt(sortLines(lines, { keys: keys(true, false) })),
		wrong: {
			'key-as-text': fmt(sortLines(lines, { keys: keys(false, false) })),
			'reverse-all-keys': fmt(sortLines(lines, { keys: keys(true, true) })),
			'ties-file-order': fmt(fileOrder)
		}
	};
}

function countRank(rng: Rng, file: string): Scenario {
	const paths = rng.sample(PATHS, 6);
	const log = entries(rng, rng.int(11, 14), ipPool(rng, 6), paths);
	const n = rng.int(3, 4);
	const sorted = sortLines(
		log.map((e) => e.path),
		{}
	);
	const counted = uniqCount(sorted).map(uniqLine);
	// `uniq -c` pads the count; `sort -k` without `-t` counts the blanks into the first field, `awk` drops them.
	const fmt = (lines: string[]) =>
		lines.slice(0, n).map((l) => {
			const [count, path] = l.trim().split(/\s+/);
			return `${path} ${count}`;
		});
	const rank = (tieReverse: boolean) =>
		[...counted].sort((a, b) => {
			const [ca, pa] = a.trim().split(/\s+/);
			const [cb, pb] = b.trim().split(/\s+/);
			const c = Number(cb) - Number(ca);
			if (c !== 0) return c;
			return tieReverse ? byteCmp(pb ?? '', pa ?? '') : byteCmp(pa ?? '', pb ?? '');
		});
	const firstSeen = log.map((e) => e.path).filter((p, i, all) => all.indexOf(p) === i);
	const byFirstSeen = [...counted].sort((a, b) => {
		const [ca, pa] = a.trim().split(/\s+/);
		const [cb, pb] = b.trim().split(/\s+/);
		const c = Number(cb) - Number(ca);
		return c !== 0 ? c : firstSeen.indexOf(pa ?? '') - firstSeen.indexOf(pb ?? '');
	});
	return {
		file,
		log,
		script: [`cut -d' ' -f3 ${file} | sort | uniq -c | sort -k1,1nr -k2,2 | head -n ${n} | awk '{print $2, $1}'`],
		answer: fmt(rank(false)),
		wrong: { 'reverse-all-keys': fmt(rank(true)), 'ties-file-order': fmt(byFirstSeen) }
	};
}

function stableSort(rng: Rng, file: string): Scenario {
	const log = entries(rng, rng.int(8, 10), ipPool(rng, 7), PATHS);
	const lines = log.map(line);
	const key: SortKey = { from: 2, to: 2, numeric: false, reverse: false };
	const n = rng.int(5, 6);
	const fmt = (sorted: string[]) =>
		sorted.slice(0, n).map((l) => {
			const f = fieldsOf(l);
			return `${f[0]} ${f[1]}`;
		});
	return {
		file,
		log,
		script: [`sort -s -t' ' -k2,2 ${file} | head -n ${n} | cut -d' ' -f1,2`],
		answer: fmt(sortLines(lines, { keys: [key], stable: true })),
		wrong: {
			'stable-ignored': fmt(sortLines(lines, { keys: [key] })),
			'key-to-end': fmt(sortLines(lines, { keys: [{ ...key, to: null }], stable: true }))
		}
	};
}

function uniqueKey(rng: Rng, file: string): Scenario {
	const log = entries(rng, rng.int(9, 11), ipPool(rng, 8), rng.sample(PATHS, 4));
	const lines = log.map(line);
	const key: SortKey = { from: 3, to: 3, numeric: false, reverse: false };
	const fmt = (sorted: string[]) =>
		sorted.map((l) => {
			const f = fieldsOf(l);
			return `${f[0]} ${f[2]}`;
		});
	const smallestLine = sortLines(lines, { keys: [key] }).filter(
		(l, i, all) => i === 0 || compareKeys(all[i - 1] ?? '', l, [key]) !== 0
	);
	const lastOfRun = [...sortLines([...lines].reverse(), { keys: [key], unique: true })];
	return {
		file,
		log,
		script: [`sort -u -t' ' -k3,3 ${file} | cut -d' ' -f1,3`],
		answer: fmt(sortLines(lines, { keys: [key], unique: true })),
		wrong: {
			'unique-after-full-sort': fmt(smallestLine),
			'unique-keeps-last': fmt(lastOfRun)
		}
	};
}

const MAKERS: Record<string, (rng: Rng, file: string) => Scenario> = {
	'lex-sort': lexSort,
	'uniq-adjacent': uniqAdjacent,
	'grep-count': grepCount,
	'tail-head': tailHead,
	'key-numeric': keyNumeric,
	'count-rank': countRank,
	stable: stableSort,
	'unique-key': uniqueKey
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'lex-sort': ['numeric-sort'],
	'uniq-adjacent': ['uniq-groups-all', 'uniq-sorts'],
	'grep-count': ['dot-literal', 'count-occurrences'],
	'tail-head': ['tail-plus-skips', 'tail-plus-last'],
	'key-numeric': ['key-as-text', 'reverse-all-keys'],
	'count-rank': ['reverse-all-keys'],
	stable: ['stable-ignored'],
	'unique-key': ['unique-after-full-sort']
};

const valid = (answer: readonly string[]): boolean =>
	answer.length > 0 && answer.every((l) => l.length > 0 && l.trim() === l);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = MAKERS[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.classId}`);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const s = make(rng, rng.pick(LOG_NAMES));
		if (!valid(s.answer)) continue;
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
		const content = s.log.map(line).join('\n') + '\n';
		const files: ShellFile[] = [{ path: s.file, content }];
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					`В текущем каталоге лежит журнал доступа \`${s.file}\`. Поля разделены одним пробелом: адрес клиента, метод, путь, код ответа, размер ответа в байтах.`,
					'',
					'```',
					...s.log.map(line),
					'```',
					'',
					'Скрипт запущен в bash с локалью `LC_ALL=C` (строки сравниваются побайтно). Что он напечатает? Введите вывод построчно, как он появится на экране.'
				].join('\n'),
				code: { language: 'shell', source: script }
			},
			answer: { kind: 'sequence', value: s.answer }
		});
		return {
			instance,
			reference: () => bashProbe({ script: `${script}\n`, files }),
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
