// Two pointers and sliding windows read from code: a fixed window, merging sorted lists, pairs with a sum, in-place
// compaction, and windows of variable length with their edge cases — the empty window and an unreachable condition.
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
	lastMax: boolean;
	startOffByOne: boolean;
	tiesFromB: boolean;
	tailDropped: boolean;
	allPairs: boolean;
	arrayTruncated: boolean;
	leftMovesBack: boolean;
	shrinkOnce: boolean;
	exactlyK: boolean;
	windowNeverEmpty: boolean;
	onePerStep: boolean;
}

const RIGHT: Rules = {
	lastMax: false,
	startOffByOne: false,
	tiesFromB: false,
	tailDropped: false,
	allPairs: false,
	arrayTruncated: false,
	leftMovesBack: false,
	shrinkOnce: false,
	exactlyK: false,
	windowNeverEmpty: false,
	onePerStep: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'last-max': { lastMax: true },
	'start-off-by-one': { startOffByOne: true },
	'ties-from-b': { tiesFromB: true },
	'tail-dropped': { tailDropped: true },
	'all-pairs': { allPairs: true },
	'array-truncated': { arrayTruncated: true },
	'left-moves-back': { leftMovesBack: true },
	'shrink-once': { shrinkOnce: true },
	'exactly-k': { exactlyK: true },
	'window-never-empty': { windowNeverEmpty: true },
	'one-per-step': { onePerStep: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/fixed-window': ['last-max', 'start-off-by-one'],
	'intern/merge': ['ties-from-b', 'tail-dropped'],
	'intern/compact': ['array-truncated'],
	'intern/pair-sum': ['all-pairs'],
	'junior/longest-unique': ['left-moves-back'],
	'junior/min-window': ['shrink-once'],
	'junior/count-windows': ['one-per-step'],
	'junior/at-most-k': ['exactly-k', 'window-never-empty']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

const list = (items: readonly (number | string)[]) => `[${items.join(', ')}]`;

function at<T>(items: readonly T[], i: number): T {
	const item = items[i];
	if (item === undefined) throw new Error(`index ${i} of ${items.length}`);
	return item;
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

function fixedWindow(rng: Rng): Program {
	const fn = rng.pick(['best_window', 'peak_load', 'busiest', 'max_run']);
	const name = rng.pick(['xs', 'loads', 'hits', 'sales']);
	const xs = Array.from({ length: rng.int(8, 10) }, () => rng.int(1, 6));
	const [k1, k2] = rng.sample([2, 3, 4], 2) as [number, number];
	const best = (k: number, rules: Rules): string => {
		let s = sum(xs.slice(0, k));
		let top = s;
		let start = 0;
		for (let i = k; i < xs.length; i += 1) {
			s += at(xs, i) - at(xs, i - k);
			if (rules.lastMax ? s >= top : s > top) {
				top = s;
				start = rules.startOffByOne ? i - k : i - k + 1;
			}
		}
		return `${top} ${start}`;
	};
	return {
		lines: [
			`def ${fn}(xs, k):`,
			'    s = sum(xs[:k])',
			'    best, start = s, 0',
			'    for i in range(k, len(xs)):',
			'        s += xs[i] - xs[i - k]',
			'        if s > best:',
			'            best, start = s, i - k + 1',
			'    return best, start',
			'',
			`${name} = ${list(xs)}`,
			`print(*${fn}(${name}, ${k1}))`,
			`print(*${fn}(${name}, ${k2}))`
		],
		run: (rules) => [best(k1, rules), best(k2, rules)]
	};
}

function merge(rng: Rng): Program {
	const fn = rng.pick(['merge', 'combine', 'zip_sorted', 'interleave']);
	const shared = rng.sample(
		Array.from({ length: 30 }, (_, i) => i + 1),
		2
	);
	const a = [...shared, ...Array.from({ length: rng.int(1, 3) }, () => rng.int(1, 40))].sort((x, y) => x - y);
	const b = [...shared, ...Array.from({ length: rng.int(1, 3) }, () => rng.int(1, 40))].sort((x, y) => x - y);
	return {
		lines: [
			`def ${fn}(a, b):`,
			'    i = j = 0',
			'    out = []',
			'    while i < len(a) and j < len(b):',
			'        if a[i] <= b[j]:',
			"            out.append(f'{a[i]}a')",
			'            i += 1',
			'        else:',
			"            out.append(f'{b[j]}b')",
			'            j += 1',
			"    out += [f'{x}a' for x in a[i:]]",
			"    out += [f'{x}b' for x in b[j:]]",
			'    return out',
			'',
			`print(*${fn}(${list(a)}, ${list(b)}))`
		],
		run: (rules) => {
			let i = 0;
			let j = 0;
			const out: string[] = [];
			while (i < a.length && j < b.length) {
				const takeA = rules.tiesFromB ? at(a, i) < at(b, j) : at(a, i) <= at(b, j);
				if (takeA) out.push(`${at(a, i++)}a`);
				else out.push(`${at(b, j++)}b`);
			}
			if (!rules.tailDropped) {
				out.push(...a.slice(i).map((x) => `${x}a`), ...b.slice(j).map((x) => `${x}b`));
			}
			return [out.join(' ')];
		}
	};
}

function compact(rng: Rng): Program {
	const name = rng.pick(['xs', 'ids', 'stamps', 'codes']);
	const distinct = rng
		.sample(
			Array.from({ length: 50 }, (_, i) => i + 1),
			rng.int(3, 5)
		)
		.sort((x, y) => x - y);
	const xs = distinct.flatMap((v) => Array.from({ length: rng.int(1, 3) }, () => v));
	return {
		lines: [
			`${name} = ${list(xs)}`,
			'k = 1',
			`for i in range(1, len(${name})):`,
			`    if ${name}[i] != ${name}[k - 1]:`,
			`        ${name}[k] = ${name}[i]`,
			'        k += 1',
			'print(k)',
			`print(${name}[:k])`,
			`print(${name})`
		],
		run: (rules) => {
			const arr = [...xs];
			let k = 1;
			for (let i = 1; i < arr.length; i += 1) {
				if (at(arr, i) !== at(arr, k - 1)) {
					arr[k] = at(arr, i);
					k += 1;
				}
			}
			return [String(k), list(arr.slice(0, k)), list(rules.arrayTruncated ? arr.slice(0, k) : arr)];
		}
	};
}

function pairSum(rng: Rng): Program {
	const fn = rng.pick(['pairs', 'matching', 'two_sum', 'complements']);
	const name = rng.pick(['xs', 'prices', 'weights', 'sizes']);
	const xs = Array.from({ length: rng.int(8, 10) }, () => rng.int(1, 20)).sort((x, y) => x - y);
	// Targets: sums of two elements, so pairs exist.
	const target = () => at(xs, rng.int(0, 2)) + at(xs, rng.int(xs.length - 3, xs.length - 1));
	const t1 = target();
	let t2 = target();
	for (let i = 0; i < 10 && t2 === t1; i += 1) t2 = target();
	const run2 = (t: number, rules: Rules): [number, number][] => {
		const found: [number, number][] = [];
		if (rules.allPairs) {
			for (let i = 0; i < xs.length; i += 1)
				for (let j = i + 1; j < xs.length; j += 1) if (at(xs, i) + at(xs, j) === t) found.push([at(xs, i), at(xs, j)]);
			return found;
		}
		let lo = 0;
		let hi = xs.length - 1;
		while (lo < hi) {
			const s = at(xs, lo) + at(xs, hi);
			if (s === t) {
				found.push([at(xs, lo), at(xs, hi)]);
				lo += 1;
				hi -= 1;
			} else if (s < t) lo += 1;
			else hi -= 1;
		}
		return found;
	};
	return {
		lines: [
			`def ${fn}(xs, target):`,
			'    lo, hi = 0, len(xs) - 1',
			'    found = []',
			'    while lo < hi:',
			'        s = xs[lo] + xs[hi]',
			'        if s == target:',
			'            found.append((xs[lo], xs[hi]))',
			'            lo += 1',
			'            hi -= 1',
			'        elif s < target:',
			'            lo += 1',
			'        else:',
			'            hi -= 1',
			'    return found',
			'',
			`${name} = ${list(xs)}`,
			`print(${fn}(${name}, ${t1}))`,
			`print(len(${fn}(${name}, ${t2})))`
		],
		run: (rules) => [list(run2(t1, rules).map(([x, y]) => `(${x}, ${y})`)), String(run2(t2, rules).length)]
	};
}

function longestUnique(rng: Rng): Program {
	const fn = rng.pick(['longest', 'widest', 'unique_run', 'no_repeat']);
	const alphabet = rng.sample(['a', 'b', 'c', 'd', 'e', 'f', 'k', 'm'], rng.int(4, 5));
	const word = () => Array.from({ length: rng.int(8, 11) }, () => rng.pick(alphabet)).join('');
	const inputs = rng.shuffle([word(), word(), rng.pick(['', alphabet[0] as string])]);
	const solve = (s: string, rules: Rules): string => {
		const last = new Map<string, number>();
		let left = 0;
		let best = 0;
		let start = 0;
		for (let right = 0; right < s.length; right += 1) {
			const c = s.charAt(right);
			const prev = last.get(c);
			if (prev !== undefined && (rules.leftMovesBack || prev >= left)) left = prev + 1;
			last.set(c, right);
			if (right - left + 1 > best) {
				best = right - left + 1;
				start = left;
			}
		}
		return `${best} ${s.slice(start, start + best)}`.trimEnd();
	};
	return {
		lines: [
			`def ${fn}(s):`,
			'    last = {}',
			'    left = best = start = 0',
			'    for right, c in enumerate(s):',
			'        if c in last and last[c] >= left:',
			'            left = last[c] + 1',
			'        last[c] = right',
			'        if right - left + 1 > best:',
			'            best, start = right - left + 1, left',
			'    return best, s[start:start + best]',
			'',
			`for s in [${inputs.map((s) => `'${s}'`).join(', ')}]:`,
			`    print(*${fn}(s))`
		],
		run: (rules) => inputs.map((s) => solve(s, rules))
	};
}

function minWindow(rng: Rng): Program {
	const fn = rng.pick(['shortest', 'min_span', 'tightest', 'smallest_batch']);
	const name = rng.pick(['xs', 'sizes', 'chunks', 'costs']);
	const xs = Array.from({ length: rng.int(8, 10) }, () => rng.int(1, 9));
	const total = sum(xs);
	// Needs: one a single element meets, one nothing meets, one or two in between.
	const top = Math.max(...xs);
	const between = (lo: number, hi: number) => rng.int(Math.min(lo, hi), Math.max(lo, hi));
	const needs = rng.shuffle([
		Math.max(1, top - rng.int(0, 1)),
		total + rng.int(1, 5),
		between(top + 2, Math.floor(total / 2)),
		between(Math.floor(total / 3), total - 1)
	]);
	const solve = (need: number, rules: Rules): number => {
		let left = 0;
		let s = 0;
		let best = xs.length + 1;
		xs.forEach((x, right) => {
			s += x;
			while (s >= need) {
				best = Math.min(best, right - left + 1);
				s -= at(xs, left);
				left += 1;
				if (rules.shrinkOnce) break;
			}
		});
		return best <= xs.length ? best : 0;
	};
	return {
		lines: [
			`def ${fn}(xs, need):`,
			'    left = total = 0',
			'    best = len(xs) + 1',
			'    for right, x in enumerate(xs):',
			'        total += x',
			'        while total >= need:',
			'            best = min(best, right - left + 1)',
			'            total -= xs[left]',
			'            left += 1',
			'    return best if best <= len(xs) else 0',
			'',
			`${name} = ${list(xs)}`,
			`for need in ${list(needs)}:`,
			`    print(need, ${fn}(${name}, need))`
		],
		run: (rules) => needs.map((need) => `${need} ${solve(need, rules)}`)
	};
}

function countWindows(rng: Rng): Program {
	const fn = rng.pick(['count_at_most', 'windows_within', 'fitting', 'budget_runs']);
	const name = rng.pick(['xs', 'costs', 'loads', 'sizes']);
	const xs = Array.from({ length: rng.int(6, 8) }, () => rng.int(2, 9));
	const wide = rng.int(Math.max(...xs), Math.max(...xs) + 6);
	const limits = rng.shuffle([Math.min(...xs) - 1, wide, wide + rng.int(4, 12)]);
	const solve = (limit: number, rules: Rules): number => {
		let left = 0;
		let s = 0;
		let count = 0;
		xs.forEach((x, right) => {
			s += x;
			while (s > limit) {
				s -= at(xs, left);
				left += 1;
			}
			const size = right - left + 1;
			count += rules.onePerStep ? (size > 0 ? 1 : 0) : size;
		});
		return count;
	};
	return {
		lines: [
			`def ${fn}(xs, limit):`,
			'    left = total = count = 0',
			'    for right, x in enumerate(xs):',
			'        total += x',
			'        while total > limit:',
			'            total -= xs[left]',
			'            left += 1',
			'        count += right - left + 1',
			'    return count',
			'',
			`${name} = ${list(xs)}`,
			`for limit in ${list(limits)}:`,
			`    print(limit, ${fn}(${name}, limit))`
		],
		run: (rules) => limits.map((limit) => `${limit} ${solve(limit, rules)}`)
	};
}

function atMostK(rng: Rng): Program {
	const fn = rng.pick(['longest_k', 'widest_k', 'k_kinds', 'few_kinds']);
	const alphabet = rng.sample(['a', 'b', 'c', 'd', 'e', 'x', 'y', 'z'], rng.int(3, 4));
	const s = Array.from({ length: rng.int(9, 12) }, () => rng.pick(alphabet)).join('');
	const kinds = new Set(s).size;
	const ks = [0, rng.int(1, 2), kinds + rng.int(1, 3)];
	const solve = (k: number, rules: Rules): number => {
		if (rules.windowNeverEmpty && k === 0) return 1;
		let best = 0;
		for (let left = 0; left < s.length; left += 1) {
			const seen = new Set<string>();
			for (let right = left; right < s.length; right += 1) {
				seen.add(s.charAt(right));
				if (seen.size > k) break;
				if (!rules.exactlyK || seen.size === k) best = Math.max(best, right - left + 1);
			}
		}
		return best;
	};
	return {
		lines: [
			`def ${fn}(s, k):`,
			'    count = {}',
			'    left = best = 0',
			'    for right, c in enumerate(s):',
			'        count[c] = count.get(c, 0) + 1',
			'        while len(count) > k:',
			'            count[s[left]] -= 1',
			'            if count[s[left]] == 0:',
			'                del count[s[left]]',
			'            left += 1',
			'        best = max(best, right - left + 1)',
			'    return best',
			'',
			`s = '${s}'`,
			`for k in ${list(ks)}:`,
			`    print(k, ${fn}(s, k))`
		],
		run: (rules) => ks.map((k) => `${k} ${solve(k, rules)}`)
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'intern/fixed-window': fixedWindow,
	'intern/merge': merge,
	'intern/compact': compact,
	'intern/pair-sum': pairSum,
	'junior/longest-unique': longestUnique,
	'junior/min-window': minWindow,
	'junior/count-windows': countWindows,
	'junior/at-most-k': atMostK
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
