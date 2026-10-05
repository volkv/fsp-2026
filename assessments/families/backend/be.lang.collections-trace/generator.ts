// Everyday collections: counting with a dictionary and its insertion order, sorting by a key with ties, slices with
// negative indices and steps, zip and enumerate.
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
	dictSorted: boolean;
	stopInclusive: boolean;
	negativeOffByOne: boolean;
	zipLongest: boolean;
	enumerateFromZero: boolean;
	dictFirstWins: boolean;
	getStoresDefault: boolean;
}

const RIGHT: Rules = {
	tiesAlpha: false,
	dictSorted: false,
	stopInclusive: false,
	negativeOffByOne: false,
	zipLongest: false,
	enumerateFromZero: false,
	dictFirstWins: false,
	getStoresDefault: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'ties-alpha': { tiesAlpha: true },
	'dict-sorted': { dictSorted: true },
	'stop-inclusive': { stopInclusive: true },
	'negative-off-by-one': { negativeOffByOne: true },
	'zip-longest': { zipLongest: true },
	'enumerate-from-zero': { enumerateFromZero: true },
	'dict-first-wins': { dictFirstWins: true },
	'get-stores-default': { getStoresDefault: true }
};

const REQUIRED: Record<string, string[]> = {
	'intern/count-sort': ['ties-alpha', 'dict-sorted'],
	'intern/slices': ['stop-inclusive', 'negative-off-by-one'],
	'intern/zip-enumerate': ['zip-longest', 'enumerate-from-zero', 'dict-first-wins'],
	'intern/setdefault-get': ['get-stores-default', 'dict-sorted']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const strRepr = (s: string) => `'${s}'`;
const listRepr = (items: readonly string[]) => `[${items.join(', ')}]`;

const WORDS = ['tea', 'pie', 'jam', 'cake', 'soup', 'rice', 'milk', 'bread', 'salt', 'corn', 'plum', 'fig'] as const;

function countSort(rng: Rng): Program {
	const [words, counts, ranked] = rng.pick([
		['words', 'counts', 'ranked'],
		['tags', 'freq', 'top'],
		['events', 'seen', 'order'],
		['items', 'tally', 'by_count']
	] as const);
	const pool = rng.sample(WORDS, rng.int(4, 5));
	const stream = Array.from({ length: rng.int(8, 10) }, () => rng.pick(pool));
	const minFirst = rng.bool();
	const sortKey = minFirst ? `${counts}[w]` : `-${counts}[w]`;
	const head = rng.int(2, 3);
	return {
		lines: [
			`${words} = [${stream.map(strRepr).join(', ')}]`,
			`${counts} = {}`,
			`for w in ${words}:`,
			`    ${counts}[w] = ${counts}.get(w, 0) + 1`,
			`print(${counts})`,
			`${ranked} = sorted(${counts}, key=lambda w: ${sortKey})`,
			`print(${ranked})`,
			`print(${ranked}[:${head}])`
		],
		run: (rules) => {
			const tally = new Map<string, number>();
			for (const w of stream) tally.set(w, (tally.get(w) ?? 0) + 1);
			const keys = [...tally.keys()];
			const shown = rules.dictSorted ? [...keys].sort() : keys;
			const dict = `{${shown.map((k) => `${strRepr(k)}: ${tally.get(k) ?? 0}`).join(', ')}}`;
			const value = (k: string) => (minFirst ? 1 : -1) * (tally.get(k) ?? 0);
			const order = [...keys].sort((x, y) => value(x) - value(y) || (rules.tiesAlpha ? (x < y ? -1 : 1) : 0));
			return [dict, listRepr(order.map(strRepr)), listRepr(order.slice(0, head).map(strRepr))];
		}
	};
}

/** Python slicing with the misconceptions of the class as switches. */
function slice<T>(xs: readonly T[], start: number | null, stop: number | null, step: number, rules: Rules): T[] {
	const n = xs.length;
	const norm = (i: number) => (i < 0 ? n + i - (rules.negativeOffByOne ? 1 : 0) : i);
	const out: T[] = [];
	if (step > 0) {
		const from = Math.min(Math.max(start === null ? 0 : norm(start), 0), n);
		let to = Math.min(Math.max(stop === null ? n : norm(stop), 0), n);
		if (rules.stopInclusive && stop !== null) to = Math.min(to + 1, n);
		for (let i = from; i < to; i += step) out.push(xs[i] as T);
	} else {
		const from = Math.min(Math.max(start === null ? n - 1 : norm(start), -1), n - 1);
		let to = stop === null ? -1 : Math.min(Math.max(norm(stop), -1), n - 1);
		if (rules.stopInclusive && stop !== null) to = Math.max(to - 1, -1);
		for (let i = from; i > to; i += step) out.push(xs[i] as T);
	}
	return out;
}

interface SliceForm {
	text: string;
	start: number | null;
	stop: number | null;
	step: number;
}

function sliceForms(rng: Rng, n: number): SliceForm[] {
	const k = rng.int(2, 3);
	const a = rng.int(1, 2);
	const b = rng.int(1, 3);
	const forms: SliceForm[] = [
		{ text: `[-${k}:]`, start: -k, stop: null, step: 1 },
		{ text: `[:-${k}]`, start: null, stop: -k, step: 1 },
		{ text: `[${a}:-${b}]`, start: a, stop: -b, step: 1 },
		{ text: `[-${k + 2}:-${a}]`, start: -(k + 2), stop: -a, step: 1 },
		{ text: `[::-${k}]`, start: null, stop: null, step: -k },
		{ text: `[-1:-${k + 1}:-1]`, start: -1, stop: -(k + 1), step: -1 },
		{ text: `[${a}:${n - b}:2]`, start: a, stop: n - b, step: 2 },
		{ text: `[${n - a}:${b}:-2]`, start: n - a, stop: b, step: -2 }
	];
	return rng.sample(forms, 4);
}

function slices(rng: Rng): Program {
	const name = rng.pick(['xs', 'data', 'values', 'nums', 'queue']);
	const n = rng.int(7, 9);
	const xs = rng.sample(
		Array.from({ length: 90 }, (_, i) => i + 10),
		n
	);
	const forms = sliceForms(rng, n);
	return {
		lines: [`${name} = [${xs.join(', ')}]`, ...forms.map((f) => `print(${name}${f.text})`)],
		run: (rules) => forms.map((f) => listRepr(slice(xs, f.start, f.stop, f.step, rules).map(String)))
	};
}

function zipEnumerate(rng: Rng): Program {
	const [names, scores, table] = rng.pick([
		['names', 'scores', 'best'],
		['users', 'points', 'last'],
		['owners', 'sizes', 'latest'],
		['players', 'results', 'final']
	] as const);
	const people = rng.sample(PERSON_NAMES, 4);
	// Names repeat once, so a dict built from the pairs has a key with two values.
	const repeated = rng.pick(people.slice(0, 3));
	const nameList = rng.shuffle([...people, repeated]);
	const nNames = nameList.length;
	const longerNames = rng.bool();
	const nScores = longerNames ? nNames - rng.int(1, 2) : nNames + rng.int(1, 2);
	const scoreList = Array.from({ length: nScores }, () => rng.int(10, 99));
	const start = rng.int(1, 5);
	const pairs = Math.min(nNames, nScores);
	// The repeated name must sit twice inside the zipped part, else the dict trap is silent.
	const firstAt = nameList.indexOf(repeated);
	const lastAt = nameList.lastIndexOf(repeated);
	const effective = lastAt < pairs ? nameList : null;
	const zipped = effective ?? [...nameList];
	if (effective === null) {
		// Move the second occurrence into the zipped part.
		zipped.splice(lastAt, 1);
		zipped.splice(Math.min(firstAt + 1, pairs - 1), 0, repeated);
	}
	return {
		lines: [
			`${names} = [${zipped.map(strRepr).join(', ')}]`,
			`${scores} = [${scoreList.join(', ')}]`,
			`for i, (name, score) in enumerate(zip(${names}, ${scores}), start=${start}):`,
			'    print(i, name, score)',
			`${table} = dict(zip(${names}, ${scores}))`,
			`print(${table})`
		],
		run: (rules) => {
			const out: string[] = [];
			const len = rules.zipLongest ? Math.max(nNames, nScores) : pairs;
			const dict = new Map<string, string>();
			for (let i = 0; i < len; i += 1) {
				const name = zipped[i];
				const score = scoreList[i];
				const nameText = name === undefined ? 'None' : name;
				const scoreText = score === undefined ? 'None' : String(score);
				out.push(`${(rules.enumerateFromZero ? 0 : start) + i} ${nameText} ${scoreText}`);
				const key = name === undefined ? 'None' : strRepr(name);
				if (!(rules.dictFirstWins && dict.has(key))) dict.set(key, scoreText);
			}
			out.push(`{${[...dict].map(([k, v]) => `${k}: ${v}`).join(', ')}}`);
			return out;
		}
	};
}

function setdefaultGet(rng: Rng): Program {
	const [words, groups, firsts] = rng.pick([
		['words', 'by_len', 'by_first'],
		['tags', 'groups', 'index'],
		['items', 'buckets', 'starts'],
		['names', 'sizes', 'initials']
	] as const);
	const stream = rng.sample(WORDS, rng.int(5, 6));
	const missing = rng.pick([1, 2, 6, 7]);
	const extra = rng.pick(['x', 'new', 'tmp']);
	return {
		lines: [
			`${words} = [${stream.map(strRepr).join(', ')}]`,
			`${groups} = {}`,
			`${firsts} = {}`,
			`for w in ${words}:`,
			`    ${groups}.setdefault(len(w), []).append(w)`,
			`    ${firsts}.get(w[0], []).append(w)`,
			`print(${groups})`,
			`print(${firsts})`,
			`${groups}.get(${missing}, []).append('${extra}')`,
			`print(len(${groups}), ${groups}.get(${missing}))`
		],
		run: (rules) => {
			const byLen = new Map<number, string[]>();
			for (const w of stream) byLen.set(w.length, [...(byLen.get(w.length) ?? []), w]);
			const byFirst = new Map<string, string[]>();
			if (rules.getStoresDefault) {
				for (const w of stream) byFirst.set(w.charAt(0), [...(byFirst.get(w.charAt(0)) ?? []), w]);
			}
			const show = <K extends number | string>(m: Map<K, string[]>, key: (k: K) => string) => {
				const keys = [...m.keys()];
				const ordered = rules.dictSorted ? [...keys].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)) : keys;
				return `{${ordered.map((k) => `${key(k)}: ${listRepr((m.get(k) ?? []).map(strRepr))}`).join(', ')}}`;
			};
			// No word has the missing length: get() returns a fresh list that nobody keeps.
			const last = rules.getStoresDefault ? `${byLen.size + 1} ${listRepr([strRepr(extra)])}` : `${byLen.size} None`;
			return [show(byLen, String), show(byFirst, strRepr), last];
		}
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'intern/count-sort': countSort,
	'intern/slices': slices,
	'intern/zip-enumerate': zipEnumerate,
	'intern/setdefault-get': setdefaultGet
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
	for (let tries = 0; tries < 200; tries += 1) {
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
	throw new Error(`${descriptor.key}: no program for ${slot} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
