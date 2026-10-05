// The first bad commit of a regression. Intern: the result of the check is known for every commit, and the noise is
// what to read past — builds that did not compile, a flaky test with a rerun rule, an earlier breakage that was fixed,
// a log listed newest first. Junior: a binary search over the history by a given rule for the middle, unbuildable
// commits and reruns — how many checks it makes and which commit it ends on. The kind of noise and the procedure are
// the essential class; hashes, messages and positions are surface.
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

const MESSAGES = [
	'add retry to payment client',
	'refactor order validation',
	'bump http client version',
	'fix typo in error message',
	'cache product prices',
	'move config loading to startup',
	'add index on orders.created_at',
	'log request ids',
	'split checkout handler',
	'update translations',
	'handle empty cart',
	'rename discount fields',
	'speed up report export',
	'add feature flag for new search',
	'clean up unused imports',
	'tighten password rules',
	'switch to UTC timestamps',
	'add pagination to orders list',
	'fix rounding in invoice totals',
	'upgrade test runner',
	'extract email templates',
	'retry webhook delivery',
	'add audit log entries',
	'simplify cart merge'
];

/** A result of checking one commit: the test passed or failed, the build failed, or the runs of a flaky test. */
type Result = { kind: 'pass' } | { kind: 'fail' } | { kind: 'skip' } | { kind: 'runs'; runs: boolean[] };

interface Commit {
	hash: string;
	author: string;
	message: string;
	result: Result;
}

function hashes(rng: Rng, count: number): string[] {
	const out = new Set<string>();
	while (out.size < count) out.add(Array.from({ length: 7 }, () => '0123456789abcdef'[rng.int(0, 15)] ?? '0').join(''));
	return [...out];
}

function history(rng: Rng, results: readonly Result[]): Commit[] {
	const hs = hashes(rng, results.length);
	const messages = rng.shuffle(MESSAGES);
	return results.map((result, i) => ({
		hash: hs[i] ?? '',
		author: rng.pick(PERSON_NAMES),
		message: messages[i % messages.length] ?? '',
		result
	}));
}

const status = (r: Result): 'good' | 'bad' | 'unknown' =>
	r.kind === 'pass'
		? 'good'
		: r.kind === 'fail'
			? 'bad'
			: r.kind === 'skip'
				? 'unknown'
				: r.runs.some(Boolean)
					? 'good'
					: 'bad';

/** The first bad commit: the first bad one after the last good one. */
function firstBad(commits: readonly Commit[]): number {
	let lastGood = -1;
	commits.forEach((c, i) => {
		if (status(c.result) === 'good') lastGood = i;
	});
	return commits.findIndex((c, i) => i > lastGood && status(c.result) === 'bad');
}

function resultText(r: Result): string {
	switch (r.kind) {
		case 'pass':
			return 'сборка ок, тест прошёл';
		case 'fail':
			return 'сборка ок, ТЕСТ УПАЛ';
		case 'skip':
			return 'СБОРКА НЕ ПРОШЛА, тест не запускался';
		case 'runs':
			return `сборка ок, прогоны: ${r.runs.map((ok) => (ok ? 'прошёл' : 'УПАЛ')).join(', ')}`;
	}
}

// Intern.

interface InternCase {
	commits: Commit[];
	newestFirst: boolean;
	wrong: Record<string, number | null>;
	rule: string | null;
}

function internCase(rng: Rng, classId: string): InternCase | null {
	const n = rng.int(12, 18);
	const b = rng.int(5, n - 3);
	const results: Result[] = [];
	if (classId === 'skip' || classId === 'newest-first') {
		for (let i = 0; i < n; i += 1) {
			const skip = i !== 0 && i !== b - 1 && i !== b && rng.bool(classId === 'skip' ? 0.25 : 0.1);
			results.push(skip ? { kind: 'skip' } : i < b ? { kind: 'pass' } : { kind: 'fail' });
		}
	} else if (classId === 'flaky') {
		for (let i = 0; i < n; i += 1) {
			if (i >= b) results.push({ kind: 'runs', runs: [false, false, false] });
			else {
				const r = rng.next();
				results.push({ kind: 'runs', runs: r < 0.55 ? [true] : r < 0.8 ? [false, true] : [false, false, true] });
			}
		}
	} else {
		// An earlier breakage, fixed by a revert, then the current one.
		if (b < 7) return null;
		const r1 = rng.int(1, b - 5);
		const r2 = r1 + rng.int(1, 3);
		if (r2 + 2 > b - 1) return null;
		for (let i = 0; i < n; i += 1) {
			const bad = (i >= r1 && i <= r2) || i >= b;
			results.push(bad ? { kind: 'fail' } : { kind: 'pass' });
		}
		const commits = history(rng, results);
		const revert = commits[r2 + 1];
		const broken = commits[r1];
		if (revert && broken) revert.message = `Revert "${broken.message}"`;
		return { commits, newestFirst: false, wrong: { 'earliest-fail': r1 }, rule: null };
	}
	const commits = history(rng, results);
	const firstRed = commits.findIndex((c) => c.result.kind === 'skip' || status(c.result) === 'bad');
	const anyFail = commits.findIndex((c) => c.result.kind === 'runs' && c.result.runs.some((ok) => !ok));
	return {
		commits,
		newestFirst: classId === 'newest-first',
		wrong: {
			'first-red': firstRed,
			'any-fail': classId === 'flaky' ? anyFail : null,
			'from-the-end': classId === 'newest-first' ? n - 1 : null
		},
		rule:
			classId === 'flaky'
				? 'Тест нестабилен: при падении его перезапускают, всего до трёх прогонов. Коммит хороший, если хотя бы один прогон прошёл; плохой — если упали все три.'
				: null
	};
}

function internStatement(c: InternCase): string {
	const rows = c.commits.map(
		(commit) => `${commit.hash}  ${commit.author.padEnd(6)} ${commit.message.padEnd(40)} ${resultText(commit.result)}`
	);
	return [
		'После релиза упал регрессионный тест. Сборочный сервер прогнал его на каждом коммите ветки `main` за последние дни. Результаты ниже, ' +
			(c.newestFirst
				? 'в порядке `git log`: **сверху — самый новый коммит**, снизу — самый старый.'
				: 'от самого старого коммита (сверху) к самому новому (снизу).'),
		'',
		'```',
		...(c.newestFirst ? [...rows].reverse() : rows),
		'```',
		'',
		...(c.rule ? [c.rule, ''] : []),
		'Если сборка не прошла, тест на этом коммите не запускался, и о дефекте этот коммит ничего не говорит. Первый плохой коммит — первый коммит с падением теста после последнего коммита, где тест прошёл.',
		'',
		'Введите хэш первого плохого коммита. Например: `3fa91c2`.'
	].join('\n');
}

// Junior: binary search.

interface Options {
	ceil: boolean;
	skipOlder: boolean;
	countSkips: boolean;
	rerun: boolean;
	countRuns: boolean;
	countEnds: boolean;
}

const RIGHT: Options = {
	ceil: false,
	skipOlder: false,
	countSkips: true,
	rerun: true,
	countRuns: true,
	countEnds: false
};

/** Bisect from commit 0 (good) to the last commit (bad): the checks it makes and the commit it ends on; `null` when unbuildable commits leave the boundary unknown. */
function bisect(results: readonly Result[], o: Options): { checks: number; first: number } | null {
	let lo = 0;
	let hi = results.length - 1;
	const skipped = new Set<number>();
	let checks = 0;
	for (;;) {
		const inside: number[] = [];
		for (let i = lo + 1; i < hi; i += 1) if (!skipped.has(i)) inside.push(i);
		if (inside.length === 0) break;
		const mid = o.ceil ? Math.ceil((lo + hi) / 2) : Math.floor((lo + hi) / 2);
		let pick = mid;
		if (skipped.has(mid)) {
			const newer = inside.filter((i) => i > mid);
			const older = inside.filter((i) => i < mid).reverse();
			pick = (o.skipOlder ? (older[0] ?? newer[0]) : (newer[0] ?? older[0])) ?? mid;
		}
		const r = results[pick] ?? { kind: 'skip' };
		if (r.kind === 'skip') {
			if (o.countSkips) checks += 1;
			skipped.add(pick);
			continue;
		}
		let good: boolean;
		if (r.kind === 'runs') {
			const [first, rerun] = r.runs;
			checks += 1;
			if (first) good = true;
			else if (o.rerun) {
				if (o.countRuns) checks += 1;
				good = rerun === true;
			} else good = false;
		} else {
			checks += 1;
			good = r.kind === 'pass';
		}
		if (good) lo = pick;
		else hi = pick;
	}
	if (hi - lo !== 1) return null;
	return { checks: checks + (o.countEnds ? 2 : 0), first: hi };
}

interface JuniorCase {
	commits: Commit[];
	right: { checks: number; first: number };
	wrong: Record<string, { checks: number; first: number } | null>;
}

function juniorCase(rng: Rng, classId: string): JuniorCase | null {
	const n = rng.int(16, 40);
	const b = rng.int(2, n - 1);
	const results: Result[] = [];
	for (let i = 0; i <= n; i += 1) {
		const bad = i >= b;
		if (classId === 'skip-rule' && i > 0 && i < n && rng.bool(0.2)) results.push({ kind: 'skip' });
		else if (classId === 'flaky-rerun')
			results.push({ kind: 'runs', runs: bad ? [false, false] : rng.bool(0.3) ? [false, true] : [true] });
		else results.push({ kind: bad ? 'fail' : 'pass' });
	}
	const right = bisect(results, { ...RIGHT, ceil: classId === 'ceil-mid' });
	if (!right) return null;
	const base: Options = { ...RIGHT, ceil: classId === 'ceil-mid' };
	const variants: Record<string, Options | null> = {
		'other-rounding': classId === 'floor-mid' || classId === 'ceil-mid' ? { ...base, ceil: !base.ceil } : null,
		'counts-ends': { ...base, countEnds: true },
		'skip-not-counted': classId === 'skip-rule' ? { ...base, countSkips: false } : null,
		'skip-older': classId === 'skip-rule' ? { ...base, skipOlder: true } : null,
		'no-rerun': classId === 'flaky-rerun' ? { ...base, rerun: false } : null,
		'counts-commits': classId === 'flaky-rerun' ? { ...base, countRuns: false } : null
	};
	const wrong = Object.fromEntries(
		Object.entries(variants).map(([id, o]) => [id, o === null ? null : bisect(results, o)])
	);
	return { commits: history(rng, results), right, wrong };
}

function juniorResultText(r: Result): string {
	switch (r.kind) {
		case 'pass':
			return 'тест пройдёт';
		case 'fail':
			return 'тест упадёт';
		case 'skip':
			return 'не соберётся';
		case 'runs':
			return r.runs[0] ? 'тест пройдёт' : `упадёт, при перезапуске ${r.runs[1] ? 'пройдёт' : 'упадёт'}`;
	}
}

function juniorStatement(c: JuniorCase, classId: string): string {
	const last = c.commits.length - 1;
	const rows = c.commits.map((commit, i) => {
		const what = i === 0 ? 'заведомо хороший' : i === last ? 'заведомо плохой (HEAD)' : juniorResultText(commit.result);
		return `${String(i).padStart(2)}  ${commit.hash}  ${commit.message.padEnd(40)} ${what}`;
	});
	const rules = [
		`Коммит 0 — заведомо хороший, коммит ${last} — заведомо плохой; их не проверяют. Пусть \`lo\` — последний известный хороший коммит, \`hi\` — первый известный плохой.`,
		`Пока между \`lo\` и \`hi\` есть коммиты, которые ещё можно проверить, проверяют коммит номер (\`lo\` + \`hi\`) / 2, ${classId === 'ceil-mid' ? '**округлённый вверх**' : '**округлённый вниз**'}. Тест прошёл — коммит становится \`lo\`, упал — \`hi\`.`
	];
	if (classId === 'skip-rule')
		rules.push(
			'Если коммит не собирается, это тоже проверка (сборку запускали); такой коммит больше не выбирают. Вместо него сразу берут ближайший **более новый** коммит между `lo` и `hi`, который ещё не пробовали собрать; если таких нет — ближайший более старый.'
		);
	if (classId === 'flaky-rerun')
		rules.push(
			'Тест нестабилен: если он упал, его один раз перезапускают. Коммит плохой, только если упали оба прогона. Каждый прогон теста — отдельная проверка.'
		);
	return [
		'Регрессионный тест падает на HEAD. Ищем первый плохой коммит двоичным поиском (как `git bisect`) по правилам:',
		'',
		...rules.map((r) => `- ${r}`),
		'',
		'Ниже история от старых коммитов к новым; для каждого — что покажет его проверка (заранее этого не знают, но для расчёта можно пользоваться).',
		'',
		'```',
		...rows,
		'```',
		'',
		'Сколько проверок сделает поиск и какой коммит он назовёт первым плохим? Введите число проверок и хэш через пробел. Например: `5 3fa91c2`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

d = json.loads(input())
commits = d["commits"]


def status(r):
    if r["kind"] == "pass":
        return "good"
    if r["kind"] == "fail":
        return "bad"
    if r["kind"] == "skip":
        return "unknown"
    return "good" if any(r["runs"]) else "bad"


if d["level"] == "intern":
    last_good = max(i for i, c in enumerate(commits) if status(c["result"]) == "good")
    first = next(i for i, c in enumerate(commits) if i > last_good and status(c["result"]) == "bad")
    print(commits[first]["hash"])
else:
    lo, hi = 0, len(commits) - 1
    tried = set()
    checks = 0
    while True:
        inside = [i for i in range(lo + 1, hi) if i not in tried]
        if not inside:
            break
        mid = (lo + hi + 1) // 2 if d["ceil"] else (lo + hi) // 2
        if mid in tried:
            newer = [i for i in inside if i > mid]
            older = [i for i in inside if i < mid]
            mid = newer[0] if newer else older[-1]
        r = commits[mid]["result"]
        checks += 1
        if r["kind"] == "skip":
            tried.add(mid)
            continue
        if r["kind"] == "runs":
            if r["runs"][0]:
                good = True
            else:
                checks += 1
                good = r["runs"][1]
        else:
            good = r["kind"] == "pass"
        if good:
            lo = mid
        else:
            hi = mid
    print(checks, commits[hi]["hash"])
`;

const REQUIRED: Record<string, string[]> = {
	'intern/skip': ['first-red'],
	'intern/flaky': ['any-fail'],
	'intern/fixed-earlier': ['earliest-fail'],
	'intern/newest-first': ['from-the-end'],
	'junior/floor-mid': ['other-rounding', 'counts-ends'],
	'junior/ceil-mid': ['other-rounding', 'counts-ends'],
	'junior/skip-rule': ['skip-not-counted', 'skip-older'],
	'junior/flaky-rerun': ['no-rerun', 'counts-commits']
};

const WRONG_IDS = descriptor.wrongSolutions.map((w) => w.id);

export function build(input: GenerateInput): Built {
	const { cls } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const where = `${input.grade}/${cls.id}`;
	const required = REQUIRED[where] ?? [];
	for (let tries = 0; tries < 400; tries += 1) {
		let markdown: string;
		let answer: string;
		let wrong: Record<string, string | null>;
		let commits: Commit[];
		if (input.grade === 'intern') {
			const c = internCase(rng, cls.id);
			if (!c) continue;
			const first = firstBad(c.commits);
			if (first < 1) continue;
			commits = c.commits;
			answer = commits[first]?.hash ?? '';
			wrong = Object.fromEntries(
				WRONG_IDS.map((id) => {
					const i = c.wrong[id];
					const hash = i === undefined || i === null || i < 0 ? null : (commits[i]?.hash ?? null);
					return [id, hash === answer ? null : hash];
				})
			);
			markdown = internStatement(c);
		} else {
			const c = juniorCase(rng, cls.id);
			if (!c) continue;
			commits = c.commits;
			const text = (r: { checks: number; first: number }) => `${r.checks} ${commits[r.first]?.hash ?? ''}`;
			answer = text(c.right);
			wrong = Object.fromEntries(
				WRONG_IDS.map((id) => {
					const r = c.wrong[id];
					const value = r === undefined || r === null ? null : text(r);
					return [id, value === answer ? null : value];
				})
			);
			markdown = juniorStatement(c, cls.id);
		}
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown, code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({ level: input.grade, ceil: cls.id === 'ceil-mid', commits });
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, v]) => [
						id,
						v === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value: v } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no history for ${where} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
