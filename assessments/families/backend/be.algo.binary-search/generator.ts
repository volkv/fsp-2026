// Binary search read closely: which index lower and upper bound return on arrays with repeats, which of the repeats a
// classic search hits, how a search over the answer moves, and the search in a rotated array.
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

const descriptor = readDescriptor(import.meta.url);

interface Rules {
	boundSwapped: boolean;
	notFoundMinusOne: boolean;
	firstOccurrence: boolean;
	strictCapacity: boolean;
	stopAtFeasible: boolean;
	rightIsLastIndex: boolean;
	rotationBlind: boolean;
	hiEqualsLo: boolean;
	lastIsFirst: boolean;
	strictBound: boolean;
}

const RIGHT: Rules = {
	boundSwapped: false,
	notFoundMinusOne: false,
	firstOccurrence: false,
	strictCapacity: false,
	stopAtFeasible: false,
	rightIsLastIndex: false,
	rotationBlind: false,
	hiEqualsLo: false,
	lastIsFirst: false,
	strictBound: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'bound-swapped': { boundSwapped: true },
	'not-found-minus-one': { notFoundMinusOne: true },
	'first-occurrence': { firstOccurrence: true },
	'strict-capacity': { strictCapacity: true },
	'stop-at-feasible': { stopAtFeasible: true },
	'right-is-last-index': { rightIsLastIndex: true },
	'rotation-blind': { rotationBlind: true },
	'hi-equals-lo': { hiEqualsLo: true },
	'last-is-first': { lastIsFirst: true },
	'strict-bound': { strictBound: true }
};

const REQUIRED: Record<string, string[]> = {
	'intern/lower-bound': ['bound-swapped', 'not-found-minus-one'],
	'intern/upper-bound': ['bound-swapped', 'not-found-minus-one'],
	'intern/closed-search': ['first-occurrence'],
	'junior/answer-search': ['strict-capacity', 'stop-at-feasible'],
	'junior/bisect': ['right-is-last-index', 'not-found-minus-one'],
	'junior/rotated': ['rotation-blind'],
	'intern/closed-insert': ['bound-swapped', 'hi-equals-lo'],
	'junior/last-at-most': ['last-is-first', 'strict-bound']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const list = (items: readonly number[]) => `[${items.join(', ')}]`;

function at<T>(items: readonly T[], i: number): T {
	const item = items[i];
	if (item === undefined) throw new Error(`index ${i} of ${items.length}`);
	return item;
}

/** First index with a[i] >= x (strict: a[i] > x). */
function bound(a: readonly number[], x: number, strict: boolean): number {
	let lo = 0;
	let hi = a.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (strict ? at(a, mid) <= x : at(a, mid) < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** A sorted array of 7–10 elements with at least two values repeated. */
function sortedWithRepeats(rng: Rng): number[] {
	const distinct = rng.sample(
		Array.from({ length: 40 }, (_, i) => i * 2 + 2),
		rng.int(4, 6)
	);
	const values = [...distinct];
	const repeated = rng.sample(distinct, 2);
	for (const v of repeated) for (let i = rng.int(1, 2); i > 0; i -= 1) values.push(v);
	while (values.length < 7) values.push(rng.pick(distinct));
	return values.sort((x, y) => x - y);
}

function repeatedValues(a: readonly number[]): number[] {
	return [...new Set(a.filter((v, i) => a.indexOf(v) !== i))];
}

/** An absent value inside the range (the array holds even numbers only, so odd values are absent). */
const absentInside = (rng: Rng, a: readonly number[]) => rng.int(at(a, 0), at(a, a.length - 1) - 1) | 1;

function boundProgram(rng: Rng, strict: boolean): Program {
	const fn = strict
		? rng.pick(['upper_bound', 'first_greater', 'right_edge'])
		: rng.pick(['lower_bound', 'first_not_less', 'left_edge']);
	const name = rng.pick(['a', 'prices', 'ts', 'scores']);
	const a = sortedWithRepeats(rng);
	const edge = rng.bool() ? at(a, a.length - 1) + rng.int(1, 9) : Math.max(0, at(a, 0) - rng.int(1, 3));
	const queries = rng.shuffle([rng.pick(repeatedValues(a)), absentInside(rng, a), edge]);
	return {
		lines: [
			`def ${fn}(a, x):`,
			'    lo, hi = 0, len(a)',
			'    while lo < hi:',
			'        mid = (lo + hi) // 2',
			`        if a[mid] ${strict ? '<=' : '<'} x:`,
			'            lo = mid + 1',
			'        else:',
			'            hi = mid',
			'    return lo',
			'',
			`${name} = ${list(a)}`,
			`for x in ${list(queries)}:`,
			`    print(x, ${fn}(${name}, x))`
		],
		run: (rules) =>
			queries.map((x) => {
				if (rules.notFoundMinusOne && !a.includes(x)) return `${x} -1`;
				return `${x} ${bound(a, x, rules.boundSwapped ? !strict : strict)}`;
			})
	};
}

function closedSearch(rng: Rng): Program {
	const fn = rng.pick(['find', 'search', 'index_of', 'locate']);
	const name = rng.pick(['a', 'ids', 'levels', 'marks']);
	const a = sortedWithRepeats(rng);
	const unique = a.filter((v) => a.indexOf(v) === a.lastIndexOf(v));
	const queries = rng.shuffle([
		rng.pick(repeatedValues(a)),
		rng.pick(repeatedValues(a)),
		unique.length ? rng.pick(unique) : absentInside(rng, a),
		absentInside(rng, a)
	]);
	const search = (x: number): number => {
		let lo = 0;
		let hi = a.length - 1;
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2);
			if (at(a, mid) === x) return mid;
			if (at(a, mid) < x) lo = mid + 1;
			else hi = mid - 1;
		}
		return -1;
	};
	return {
		lines: [
			`def ${fn}(a, x):`,
			'    lo, hi = 0, len(a) - 1',
			'    while lo <= hi:',
			'        mid = (lo + hi) // 2',
			'        if a[mid] == x:',
			'            return mid',
			'        if a[mid] < x:',
			'            lo = mid + 1',
			'        else:',
			'            hi = mid - 1',
			'    return -1',
			'',
			`${name} = ${list(a)}`,
			`for x in ${list(queries)}:`,
			`    print(x, ${fn}(${name}, x))`
		],
		run: (rules) => queries.map((x) => `${x} ${rules.firstOccurrence ? a.indexOf(x) : search(x)}`)
	};
}

function answerSearch(rng: Rng): Program {
	const [need, solve] = rng.pick([
		['days_needed', 'min_capacity'],
		['trips', 'smallest_truck'],
		['batches', 'min_batch_size'],
		['shifts', 'min_throughput']
	] as const);
	const weights = Array.from({ length: rng.int(5, 7) }, () => rng.int(2, 15));
	const total = weights.reduce((s, w) => s + w, 0);
	const days = rng.int(2, 4);
	const needed = (cap: number, strict: boolean) => {
		let d = 1;
		let load = 0;
		for (const w of weights) {
			if (strict ? load + w >= cap : load + w > cap) {
				d += 1;
				load = 0;
			}
			load += w;
		}
		return d;
	};
	return {
		lines: [
			`def ${need}(weights, cap):`,
			'    days, load = 1, 0',
			'    for w in weights:',
			'        if load + w > cap:',
			'            days += 1',
			'            load = 0',
			'        load += w',
			'    return days',
			'',
			`def ${solve}(weights, limit):`,
			'    lo, hi = max(weights), sum(weights)',
			'    while lo < hi:',
			'        mid = (lo + hi) // 2',
			`        d = ${need}(weights, mid)`,
			'        print(mid, d)',
			'        if d <= limit:',
			'            hi = mid',
			'        else:',
			'            lo = mid + 1',
			'    return lo',
			'',
			`print(${solve}(${list(weights)}, ${days}))`
		],
		run: (rules) => {
			const out: string[] = [];
			let lo = Math.max(...weights);
			let hi = total;
			while (lo < hi) {
				const mid = Math.floor((lo + hi) / 2);
				const d = needed(mid, rules.strictCapacity);
				out.push(`${mid} ${d}`);
				if (d <= days) {
					if (rules.stopAtFeasible) {
						out.push(String(mid));
						return out;
					}
					hi = mid;
				} else lo = mid + 1;
				if (out.length > 40) return ['runaway'];
			}
			out.push(String(lo));
			return out;
		}
	};
}

function bisectProgram(rng: Rng): Program {
	const name = rng.pick(['a', 'slots', 'marks', 'sorted_ids']);
	const a = sortedWithRepeats(rng);
	const v = rng.pick(repeatedValues(a));
	const range = rng.sample(a, 2).sort((x, y) => x - y) as [number, number];
	const absent = absentInside(rng, a);
	const after = [...a, v].sort((x, y) => x - y);
	return {
		lines: [
			'import bisect',
			'',
			`${name} = ${list(a)}`,
			`bisect.insort(${name}, ${v})`,
			`print(len(${name}), ${name}.count(${v}))`,
			`print(bisect.bisect_left(${name}, ${v}), bisect.bisect_right(${name}, ${v}))`,
			`print(bisect.bisect_right(${name}, ${range[1]}) - bisect.bisect_left(${name}, ${range[0]}))`,
			`print(bisect.bisect_left(${name}, ${absent}), bisect.bisect_right(${name}, ${absent}))`
		],
		run: (rules) => {
			const left = (x: number) => (rules.notFoundMinusOne && !after.includes(x) ? -1 : bound(after, x, false));
			const right = (x: number) => {
				if (rules.notFoundMinusOne && !after.includes(x)) return -1;
				const r = bound(after, x, true);
				return rules.rightIsLastIndex && after.includes(x) ? r - 1 : r;
			};
			return [
				`${after.length} ${after.filter((x) => x === v).length}`,
				`${left(v)} ${right(v)}`,
				String(right(range[1]) - left(range[0])),
				`${left(absent)} ${right(absent)}`
			];
		}
	};
}

function rotated(rng: Rng): Program {
	const fn = rng.pick(['search', 'find_rotated', 'locate', 'probe']);
	const name = rng.pick(['a', 'ring', 'shifted', 'log']);
	const n = rng.int(7, 10);
	const sorted = rng
		.sample(
			Array.from({ length: 60 }, (_, i) => i + 1),
			n
		)
		.sort((x, y) => x - y);
	const shift = rng.int(2, n - 2);
	const a = [...sorted.slice(shift), ...sorted.slice(0, shift)];
	const absent = (() => {
		for (;;) {
			const v = rng.int(at(sorted, 0), at(sorted, n - 1));
			if (!a.includes(v)) return v;
		}
	})();
	const queries = rng.shuffle([rng.pick(a.slice(0, n - shift)), rng.pick(a.slice(n - shift)), absent]);
	const run = (x: number, blind: boolean): [number, number] => {
		let lo = 0;
		let hi = n - 1;
		let steps = 0;
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2);
			steps += 1;
			const m = at(a, mid);
			if (m === x) return [mid, steps];
			if (blind) {
				if (m < x) lo = mid + 1;
				else hi = mid - 1;
			} else if (at(a, lo) <= m) {
				if (at(a, lo) <= x && x < m) hi = mid - 1;
				else lo = mid + 1;
			} else if (m < x && x <= at(a, hi)) lo = mid + 1;
			else hi = mid - 1;
		}
		return [-1, steps];
	};
	return {
		lines: [
			`def ${fn}(a, x):`,
			'    lo, hi = 0, len(a) - 1',
			'    steps = 0',
			'    while lo <= hi:',
			'        mid = (lo + hi) // 2',
			'        steps += 1',
			'        if a[mid] == x:',
			'            return mid, steps',
			'        if a[lo] <= a[mid]:',
			'            if a[lo] <= x < a[mid]:',
			'                hi = mid - 1',
			'            else:',
			'                lo = mid + 1',
			'        else:',
			'            if a[mid] < x <= a[hi]:',
			'                lo = mid + 1',
			'            else:',
			'                hi = mid - 1',
			'    return -1, steps',
			'',
			`${name} = ${list(a)}`,
			`for x in ${list(queries)}:`,
			`    print(x, *${fn}(${name}, x))`
		],
		run: (rules) => queries.map((x) => `${x} ${run(x, rules.rotationBlind).join(' ')}`)
	};
}

function closedInsert(rng: Rng): Program {
	const fn = rng.pick(['insert_pos', 'slot_for', 'place', 'where']);
	const name = rng.pick(['a', 'times', 'ranks', 'heights']);
	const a = sortedWithRepeats(rng);
	const edge = rng.bool() ? at(a, a.length - 1) + rng.int(1, 9) : Math.max(0, at(a, 0) - rng.int(1, 3));
	const queries = rng.shuffle([rng.pick(repeatedValues(a)), absentInside(rng, a), edge]);
	return {
		lines: [
			`def ${fn}(a, x):`,
			'    lo, hi = 0, len(a) - 1',
			'    while lo <= hi:',
			'        mid = (lo + hi) // 2',
			'        if a[mid] < x:',
			'            lo = mid + 1',
			'        else:',
			'            hi = mid - 1',
			'    return lo, hi',
			'',
			`${name} = ${list(a)}`,
			`for x in ${list(queries)}:`,
			`    print(x, *${fn}(${name}, x))`
		],
		run: (rules) =>
			queries.map((x) => {
				const lo = bound(a, x, rules.boundSwapped);
				return `${x} ${lo} ${rules.hiEqualsLo ? lo : lo - 1}`;
			})
	};
}

function lastAtMost(rng: Rng): Program {
	const fn = rng.pick(['last_at_most', 'floor_index', 'latest_before', 'last_le']);
	const name = rng.pick(['a', 'stamps', 'versions', 'offsets']);
	const a = sortedWithRepeats(rng);
	const queries = rng.shuffle([
		rng.pick(repeatedValues(a)),
		absentInside(rng, a),
		rng.pick([Math.max(0, at(a, 0) - rng.int(1, 3)), at(a, a.length - 1) + rng.int(1, 9)]),
		rng.pick(a)
	]);
	return {
		lines: [
			`def ${fn}(a, x):`,
			'    lo, hi = -1, len(a) - 1',
			'    while lo < hi:',
			'        mid = (lo + hi + 1) // 2',
			'        if a[mid] <= x:',
			'            lo = mid',
			'        else:',
			'            hi = mid - 1',
			'    return lo',
			'',
			`${name} = ${list(a)}`,
			`for x in ${list(queries)}:`,
			`    print(x, ${fn}(${name}, x))`
		],
		run: (rules) =>
			queries.map((x) => {
				const last = bound(a, x, !rules.strictBound) - 1;
				const shown = rules.lastIsFirst && last >= 0 && at(a, last) === x ? a.indexOf(x) : last;
				return `${x} ${shown}`;
			})
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'intern/lower-bound': (rng) => boundProgram(rng, false),
	'intern/upper-bound': (rng) => boundProgram(rng, true),
	'intern/closed-search': closedSearch,
	'junior/answer-search': answerSearch,
	'junior/bisect': bisectProgram,
	'junior/rotated': rotated,
	'intern/closed-insert': closedInsert,
	'junior/last-at-most': lastAtMost
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
		if (answer.length === 1 && answer[0] === 'runaway') continue;
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
