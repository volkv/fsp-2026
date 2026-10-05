// Sorting with keys: stability on equal keys, reverse=True against a reversed result, tuple keys, sorting in several
// passes, and which of the equal elements min and max return.
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

const descriptor = readDescriptor(import.meta.url);

interface Rules {
	tiesAlpha: boolean;
	sortReturnsList: boolean;
	reverseFlipsTies: boolean;
	sliceReverseStable: boolean;
	firstFieldOnly: boolean;
	lastPassOnly: boolean;
	firstPassPrimary: boolean;
	maxLast: boolean;
	numericStrings: boolean;
	caseInsensitiveDefault: boolean;
	sortCopies: boolean;
}

const RIGHT: Rules = {
	tiesAlpha: false,
	sortReturnsList: false,
	reverseFlipsTies: false,
	sliceReverseStable: false,
	firstFieldOnly: false,
	lastPassOnly: false,
	firstPassPrimary: false,
	maxLast: false,
	numericStrings: false,
	caseInsensitiveDefault: false,
	sortCopies: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'ties-alpha': { tiesAlpha: true },
	'sort-returns-list': { sortReturnsList: true },
	'reverse-flips-ties': { reverseFlipsTies: true },
	'slice-reverse-stable': { sliceReverseStable: true },
	'first-field-only': { firstFieldOnly: true },
	'last-pass-only': { lastPassOnly: true },
	'first-pass-primary': { firstPassPrimary: true },
	'max-last': { maxLast: true },
	'numeric-strings': { numericStrings: true },
	'case-insensitive-default': { caseInsensitiveDefault: true },
	'sort-copies': { sortCopies: true }
};

const REQUIRED: Record<string, string[]> = {
	'intern/stable-key': ['ties-alpha', 'sort-returns-list'],
	'intern/reverse-ties': ['reverse-flips-ties', 'slice-reverse-stable'],
	'intern/tuple-key': ['first-field-only'],
	'junior/multi-pass': ['last-pass-only', 'first-pass-primary'],
	'junior/reverse-pass': ['reverse-flips-ties', 'last-pass-only'],
	'junior/min-max-ties': ['max-last'],
	'intern/string-order': ['numeric-strings', 'case-insensitive-default'],
	'junior/alias-sort': ['sort-copies', 'reverse-flips-ties']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

interface Rec {
	name: string;
	dept: string;
	n: number;
}

type Key = (r: Rec) => number | string;

const cmp = (x: number | string, y: number | string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * A stable sort by a key, as Python does it. `reverse` keeps equal elements in their order unless the misconception
 * of sorting and then reversing is on; `tiesAlpha` breaks ties by name.
 */
function sortBy(rs: readonly Rec[], key: Key, reverse: boolean, rules: Rules): Rec[] {
	const tie = (a: Rec, b: Rec) => (rules.tiesAlpha ? cmp(a.name, b.name) : 0);
	if (reverse && rules.reverseFlipsTies) return [...rs].sort((a, b) => cmp(key(a), key(b)) || tie(a, b)).reverse();
	const sign = reverse ? -1 : 1;
	return [...rs].sort((a, b) => sign * cmp(key(a), key(b)) || tie(a, b));
}

const names = (rs: readonly Rec[]) => rs.map((r) => r.name).join(' ');

/** Records with distinct names, numeric fields with ties, and an input order that is not alphabetical among ties. */
function records(rng: Rng, count: number, distinctValues: number, depts: readonly string[] = []): Rec[] {
	const people = rng.sample(PERSON_NAMES, count);
	const values = rng.sample(
		Array.from({ length: 60 }, (_, i) => i + 20),
		distinctValues
	);
	return people.map((name) => ({ name, dept: depts.length ? rng.pick(depts) : '', n: rng.pick(values) }));
}

const tupleText = (r: Rec, withDept: boolean) =>
	withDept ? `('${r.name}', '${r.dept}', ${r.n})` : `('${r.name}', ${r.n})`;

function stableKey(rng: Rng): Program {
	const rs = records(rng, rng.int(6, 7), 3);
	const [data, res] = rng.pick([
		['scores', 'ranked'],
		['orders', 'by_total'],
		['players', 'table'],
		['tickets', 'queue']
	] as const);
	const nameList = rng.pick(['tags', 'words', 'labels']);
	const words = rng.sample(['api', 'db', 'cache', 'queue', 'auth', 'log', 'cdn', 'mail', 'job'], 6);
	return {
		lines: [
			`${data} = [${rs.map((r) => tupleText(r, false)).join(', ')}]`,
			`${res} = sorted(${data}, key=lambda r: r[1])`,
			`print(' '.join(r[0] for r in ${res}))`,
			`${nameList} = [${words.map((w) => `'${w}'`).join(', ')}]`,
			`out = ${nameList}.sort(key=len)`,
			'print(out)',
			`print(' '.join(${nameList}))`
		],
		run: (rules) => {
			const sortedWords = [...words].sort((a, b) => a.length - b.length || (rules.tiesAlpha ? cmp(a, b) : 0));
			return [
				names(sortBy(rs, (r) => r.n, false, rules)),
				rules.sortReturnsList ? `[${sortedWords.map((w) => `'${w}'`).join(', ')}]` : 'None',
				sortedWords.join(' ')
			];
		}
	};
}

function reverseTies(rng: Rng): Program {
	const rs = records(rng, rng.int(6, 7), 3);
	const data = rng.pick(['scores', 'results', 'bids', 'votes']);
	return {
		lines: [
			`${data} = [${rs.map((r) => tupleText(r, false)).join(', ')}]`,
			`a = sorted(${data}, key=lambda r: r[1], reverse=True)`,
			`b = sorted(${data}, key=lambda r: -r[1])`,
			`c = sorted(${data}, key=lambda r: r[1])[::-1]`,
			'for res in (a, b, c):',
			"    print(' '.join(r[0] for r in res))"
		],
		run: (rules) => {
			const asc = sortBy(rs, (r) => r.n, false, rules);
			const reversedResult = rules.sliceReverseStable
				? sortBy(rs, (r) => r.n, true, { ...rules, reverseFlipsTies: false })
				: [...asc].reverse();
			return [
				names(sortBy(rs, (r) => r.n, true, rules)),
				names(sortBy(rs, (r) => -r.n, false, rules)),
				names(reversedResult)
			];
		}
	};
}

function tupleKey(rng: Rng): Program {
	const rs = records(rng, rng.int(6, 7), 3);
	const data = rng.pick(['scores', 'results', 'entries', 'stats']);
	const desc = rng.bool();
	const keyText = desc ? '(-r[1], r[0])' : '(r[1], r[0])';
	const words = rng.sample(['api', 'db', 'cache', 'queue', 'auth', 'log', 'cdn', 'mail', 'job', 'web'], 6);
	return {
		lines: [
			`${data} = [${rs.map((r) => tupleText(r, false)).join(', ')}]`,
			`print(' '.join(r[0] for r in sorted(${data}, key=lambda r: ${keyText})))`,
			`words = [${words.map((w) => `'${w}'`).join(', ')}]`,
			"print(' '.join(sorted(words, key=lambda w: (len(w), w))))"
		],
		run: (rules) => {
			const second = (a: Rec, b: Rec) => (rules.firstFieldOnly ? 0 : cmp(a.name, b.name));
			const sign = desc ? -1 : 1;
			const byTuple = [...rs].sort((a, b) => sign * cmp(a.n, b.n) || second(a, b));
			const byLen = [...words].sort((a, b) => a.length - b.length || (rules.firstFieldOnly ? 0 : cmp(a, b)));
			return [names(byTuple), byLen.join(' ')];
		}
	};
}

const DEPTS = ['ops', 'dev', 'qa', 'hr', 'pm', 'sec'] as const;

/** One pass of a multi-pass sort: the field and the direction. */
interface Pass {
	field: 'name' | 'dept' | 'n';
	reverse: boolean;
}

const fieldIndex: Record<Pass['field'], number> = { name: 0, dept: 1, n: 2 };

function passProgram(rng: Rng, withReverse: boolean): Program {
	const depts = rng.sample(DEPTS, 3);
	const rs = records(rng, rng.int(6, 8), 3, depts);
	const data = rng.pick(['staff', 'team', 'people', 'members']);
	const passes: Pass[] = rng.bool()
		? [
				{ field: 'n', reverse: false },
				{ field: 'dept', reverse: withReverse }
			]
		: [
				{ field: 'name', reverse: false },
				{ field: 'n', reverse: withReverse && rng.bool() },
				{ field: 'dept', reverse: withReverse }
			];
	if (withReverse && !passes.some((p) => p.reverse)) (passes[passes.length - 1] as Pass).reverse = true;
	const key =
		(p: Pass): Key =>
		(r) =>
			r[p.field];
	return {
		lines: [
			`${data} = [`,
			...rs.map((r) => `    ${tupleText(r, true)},`),
			']',
			...passes.map((p) => `${data}.sort(key=lambda r: r[${fieldIndex[p.field]}]${p.reverse ? ', reverse=True' : ''})`),
			`print(' '.join(r[0] for r in ${data}))`
		],
		run: (rules) => {
			let current = [...rs];
			if (rules.lastPassOnly) {
				const last = passes[passes.length - 1] as Pass;
				current = sortBy(current, key(last), last.reverse, rules);
			} else {
				const order = rules.firstPassPrimary ? [...passes].reverse() : passes;
				for (const p of order) current = sortBy(current, key(p), p.reverse, rules);
			}
			return [names(current)];
		}
	};
}

function minMaxTies(rng: Rng): Program {
	const rs = records(rng, rng.int(6, 7), 3);
	const data = rng.pick(['scores', 'bids', 'latency', 'loads']);
	const top = Math.max(...rs.map((r) => r.n));
	const bottom = Math.min(...rs.map((r) => r.n));
	const keyText = 'key=lambda r: r[1]';
	return {
		lines: [
			`${data} = [${rs.map((r) => tupleText(r, false)).join(', ')}]`,
			`print(max(${data}, ${keyText})[0], min(${data}, ${keyText})[0])`,
			`print(sorted(${data}, ${keyText})[-1][0], sorted(${data}, ${keyText})[0][0])`,
			`print(sorted(${data}, ${keyText}, reverse=True)[0][0])`
		],
		run: (rules) => {
			const tops = rs.filter((r) => r.n === top);
			const bottoms = rs.filter((r) => r.n === bottom);
			const first = <T>(xs: readonly T[]) => xs[0] as T;
			const last = <T>(xs: readonly T[]) => xs[xs.length - 1] as T;
			const asc = sortBy(rs, (r) => r.n, false, rules);
			const desc = sortBy(rs, (r) => r.n, true, rules);
			return [
				`${(rules.maxLast ? last(tops) : first(tops)).name} ${first(bottoms).name}`,
				`${last(asc).name} ${first(asc).name}`,
				first(desc).name
			];
		}
	};
}

const quoted = (items: readonly string[]) => `[${items.map((x) => `'${x}'`).join(', ')}]`;

function stringOrder(rng: Rng): Program {
	const [ids, users] = rng.pick([
		['ids', 'users'],
		['codes', 'authors'],
		['ports', 'owners'],
		['builds', 'names']
	] as const);
	const numbers = rng
		.sample(
			Array.from({ length: 300 }, (_, i) => i + 1),
			5
		)
		.map(String);
	const people = rng.sample(PERSON_NAMES, 5).map((n) => (rng.bool() ? n.charAt(0).toUpperCase() + n.slice(1) : n));
	return {
		lines: [
			`${ids} = ${quoted(numbers)}`,
			`print(sorted(${ids}))`,
			`print(sorted(${ids}, key=int))`,
			`${users} = ${quoted(people)}`,
			`print(sorted(${users}))`,
			`print(sorted(${users}, key=str.lower))`
		],
		run: (rules) => {
			const numeric = [...numbers].sort((x, y) => Number(x) - Number(y));
			const lower = [...people].sort((x, y) => cmp(x.toLowerCase(), y.toLowerCase()));
			return [
				quoted(rules.numericStrings ? numeric : [...numbers].sort(cmp)),
				quoted(numeric),
				quoted(rules.caseInsensitiveDefault ? lower : [...people].sort(cmp)),
				quoted(lower)
			];
		}
	};
}

function aliasSort(rng: Rng): Program {
	const rs = records(rng, rng.int(6, 7), 3);
	const [team, view, top] = rng.pick([
		['team', 'view', 'top'],
		['bids', 'ranked', 'best'],
		['orders', 'by_sum', 'largest'],
		['servers', 'by_load', 'busiest']
	] as const);
	const k = rng.int(3, 4);
	return {
		lines: [
			`${team} = [${rs.map((r) => tupleText(r, false)).join(', ')}]`,
			`${view} = ${team}`,
			`${view}.sort(key=lambda r: r[1])`,
			`${top} = sorted(${team}, key=lambda r: r[1], reverse=True)[:${k}]`,
			`print(' '.join(r[0] for r in ${team}))`,
			`print(' '.join(r[0] for r in ${top}))`
		],
		run: (rules) => {
			const sortedTeam = sortBy(rs, (r) => r.n, false, rules);
			const current = rules.sortCopies ? rs : sortedTeam;
			return [names(current), names(sortBy(current, (r) => r.n, true, rules).slice(0, k))];
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'intern/stable-key': stableKey,
	'intern/reverse-ties': reverseTies,
	'intern/tuple-key': tupleKey,
	'junior/multi-pass': (rng) => passProgram(rng, false),
	'junior/reverse-pass': (rng) => passProgram(rng, true),
	'junior/min-max-ties': minMaxTies,
	'intern/string-order': stringOrder,
	'junior/alias-sort': aliasSort
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const slot = `${input.grade}/${input.classId}`;
	const make = PROGRAMS[slot];
	if (!make) throw new Error(`${descriptor.key}: no program for ${slot}`);
	const required = REQUIRED[slot] ?? [];
	const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	// Programs are drawn until every misconception the class is about changes the output.
	for (let tries = 0; tries < 300; tries += 1) {
		const program = make(rng);
		const answer = program.run(RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = program.run({ ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const source = program.lines.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: 'Что напечатает программа на Python 3? Введите вывод построчно, как он появится на экране.',
				code: { language: 'python3', source }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source, stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no program for ${slot} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
