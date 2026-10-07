// Ranking metrics over the recommendation lists of a few users: precision@k and recall@k averaged over users, an
// unsorted list and a list shorter than k (Intern); MRR, MAP@k, recall without users who have nothing relevant and
// ties on the boundary of k (Junior).
import { farApart, floatAnswer, frameMarkdown, num, roundingRule, stdinJson } from '../../_lib/ds.ts';
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
const DIGITS = 3;

interface Item {
	id: number;
	score: number;
	rel: boolean;
}
interface User {
	name: string;
	/** In the order shown. */
	items: Item[];
	/** Relevant objects of the user in the whole catalogue, shown or not. */
	total: number;
}
interface Scenario {
	users: User[];
	k: number;
	plot: string;
}

const PLOTS = ['товаров', 'статей', 'фильмов', 'вакансий'] as const;

/** By score descending; a tie by object number ascending, or (a misconception) in the shown order. */
function ranked(u: User, tieByShown = false): Item[] {
	return u.items
		.map((item, at) => ({ item, at }))
		.sort((a, b) => b.item.score - a.item.score || (tieByShown ? a.at - b.at : a.item.id - b.item.id))
		.map((x) => x.item);
}

const hitsAt = (list: readonly Item[], k: number): number => list.slice(0, k).filter((x) => x.rel).length;
const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

function ap(list: readonly Item[], k: number, total: number, byHits: boolean): number {
	let hits = 0;
	let sum = 0;
	list.slice(0, k).forEach((x, i) => {
		if (!x.rel) return;
		hits += 1;
		sum += hits / (i + 1);
	});
	const denominator = byHits ? hits : Math.min(total, k);
	return denominator === 0 ? 0 : sum / denominator;
}

function mrr(users: readonly User[], skipZero: boolean): number {
	const values: number[] = [];
	for (const u of users) {
		const at = ranked(u).findIndex((x) => x.rel);
		if (at === -1) {
			if (!skipZero) values.push(0);
		} else values.push(1 / (at + 1));
	}
	return mean(values);
}

function metric(classId: string, s: Scenario): number {
	const { users, k } = s;
	switch (classId) {
		case 'precision':
		case 'unsorted':
		case 'short-list':
		case 'ties':
			return mean(users.map((u) => hitsAt(ranked(u), k) / k));
		case 'recall':
			return mean(users.map((u) => hitsAt(ranked(u), k) / u.total));
		case 'mrr':
			return mrr(users, false);
		case 'map':
			return mean(users.map((u) => ap(ranked(u), k, u.total, false)));
		case 'recall-excluding':
			return mean(users.filter((u) => u.total > 0).map((u) => hitsAt(ranked(u), k) / u.total));
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function wrongAnswers(classId: string, s: Scenario): Record<string, number | null> {
	const { users, k } = s;
	const hits = (u: User): number => hitsAt(ranked(u), k);
	const withRel = users.filter((u) => u.total > 0);
	return {
		'pr-swap':
			classId === 'precision'
				? mean(users.map((u) => hits(u) / u.total))
				: classId === 'recall'
					? mean(users.map((u) => hits(u) / k))
					: null,
		'micro-average':
			classId === 'recall' || classId === 'recall-excluding'
				? withRel.reduce((t, u) => t + hits(u), 0) / withRel.reduce((t, u) => t + u.total, 0)
				: null,
		'no-sort': classId === 'unsorted' || classId === 'ties' ? mean(users.map((u) => hitsAt(u.items, k) / k)) : null,
		'divide-by-length': classId === 'short-list' ? mean(users.map((u) => hits(u) / Math.min(k, u.items.length))) : null,
		'mrr-skip-zero': classId === 'mrr' ? mrr(users, true) : null,
		'ap-divide-by-hits': classId === 'map' ? mean(users.map((u) => ap(ranked(u), k, u.total, true))) : null,
		'zero-users-included':
			classId === 'recall-excluding' ? mean(users.map((u) => (u.total === 0 ? 0 : hits(u) / u.total))) : null,
		'tie-by-shown-order': classId === 'ties' ? mean(users.map((u) => hitsAt(ranked(u, true), k) / k)) : null
	};
}

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const junior = grade === 'junior';
	const k = junior ? rng.int(3, 6) : rng.int(3, 6);
	const names = rng.sample(PERSON_NAMES, rng.int(5, 8));
	const relShare = rng.int(20, 60) / 100;
	const users = names.map((name, ui): User => {
		const short = classId === 'short-list' && ui % 2 === 0;
		const length = short ? rng.int(1, k - 1) : junior ? rng.int(Math.max(7, k + 2), 9) : rng.int(Math.max(6, k + 2), 9);
		const ids = rng.sample(
			Array.from({ length: 60 }, (_, i) => i + 1),
			length
		);
		const pool = new Set<number>();
		const tieScores = classId === 'ties' ? rng.sample([0.9, 0.8, 0.7, 0.6, 0.5], 2) : [];
		const items = ids.map((id, i): Item => {
			const fresh = (): number => {
				for (;;) {
					const x = rng.int(5, 99) / 100;
					if (!pool.has(x) && !tieScores.includes(x)) return x;
				}
			};
			const score = classId === 'ties' && i < 4 ? (tieScores[i % 2] ?? 0.5) : fresh();
			pool.add(score);
			return { id, score, rel: rng.bool(relShare) };
		});
		const noRelevant = (classId === 'mrr' || classId === 'recall-excluding') && ui === 0;
		if (noRelevant) for (const x of items) x.rel = false;
		const shownRel = items.filter((x) => x.rel).length;
		const total = noRelevant ? 0 : Math.max(1, shownRel + (rng.bool(0.6) ? rng.int(1, 3) : 0));
		const shown = classId === 'unsorted' || classId === 'ties' ? rng.shuffle(items) : items;
		const user: User = { name, items: shown, total };
		if (classId !== 'unsorted' && classId !== 'ties') user.items = ranked(user);
		return user;
	});
	return { users: rng.shuffle(users), k, plot: rng.pick(PLOTS) };
}

const QUESTION: Record<string, (k: number) => string> = {
	precision: (k) => `Найдите precision@${k}, усреднённую по пользователям.`,
	recall: (k) =>
		`Найдите recall@${k}, усреднённую по пользователям: доля релевантных объектов пользователя (из всех его релевантных, столбец «всего релевантных»), попавших в первые ${k}.`,
	unsorted: (k) =>
		`Выдача пользователя — объекты по убыванию скора, но в таблице они перечислены вперемешку. Найдите precision@${k}, усреднённую по пользователям.`,
	'short-list': (k) =>
		`У некоторых пользователей в выдаче меньше ${k} объектов. Найдите precision@${k}, усреднённую по пользователям; precision@${k} пользователя — число релевантных в его первых ${k} объектах, делённое на ${k}, даже если объектов меньше.`,
	mrr: () =>
		'Найдите MRR по всей выдаче: среднее по пользователям значение 1 / (позиция первого релевантного объекта); если релевантных в выдаче нет, вклад пользователя — 0.',
	map: (k) =>
		`Найдите MAP@${k}: среднее по пользователям AP@${k}. AP@${k} пользователя — сумма precision@i по позициям i ≤ ${k}, где стоит релевантный объект, делённая на min(всего релевантных у пользователя, ${k}).`,
	'recall-excluding': (k) =>
		`Найдите recall@${k}, усреднённую по пользователям, у которых есть хотя бы один релевантный объект (пользователи с нулём в столбце «всего релевантных» в среднее не входят).`,
	ties: (k) =>
		`Выдача пользователя — объекты по убыванию скора; при равных скорах выше стоит объект с меньшим номером. В таблице объекты перечислены вперемешку. Найдите precision@${k}, усреднённую по пользователям.`
};

function describe(s: Scenario, classId: string): string {
	const showScore = classId === 'unsorted' || classId === 'ties';
	const cell = (x: Item): string => `#${x.id}${showScore ? ` (${num(x.score, 2)})` : ''} ${x.rel ? '+' : '−'}`;
	return [
		`Рекомендательная система показала пользователям подборки ${s.plot}. ${
			showScore
				? 'Для каждого объекта указан номер, скор модели в скобках и отметка релевантности (`+` — релевантен, `−` — нет).'
				: 'Объекты выдачи перечислены по порядку показа, сверху вниз: номер объекта и отметка релевантности (`+` — релевантен, `−` — нет).'
		} В столбце «всего релевантных» — сколько релевантных объектов у пользователя во всём каталоге, включая не попавшие в выдачу.`,
		'',
		frameMarkdown(
			['пользователь', 'выдача', 'всего релевантных'],
			s.users.map((u) => [u.name, u.items.map(cell).join(', '), u.total])
		),
		'',
		QUESTION[classId]?.(s.k) ?? '',
		'',
		roundingRule(DIGITS)
	].join('\n');
}

const PYTHON_REFERENCE = `import json

d = json.loads(input())
k, m = d["k"], d["metric"]
vals = []
for u in d["users"]:
    order = sorted(u["items"], key=lambda x: (-x[1], x[0]))
    rels = [x[2] for x in order]
    hits = sum(rels[:k])
    total = u["total"]
    if m in ("precision", "unsorted", "short-list", "ties"):
        vals.append(hits / k)
    elif m == "recall":
        vals.append(hits / total)
    elif m == "recall-excluding":
        if total > 0:
            vals.append(hits / total)
    elif m == "mrr":
        first = next((i for i, r in enumerate(rels) if r), None)
        vals.append(0 if first is None else 1 / (first + 1))
    else:
        found, acc = 0, 0.0
        for i, r in enumerate(rels[:k]):
            if r:
                found += 1
                acc += found / (i + 1)
        vals.append(acc / min(total, k))
print(repr(sum(vals) / len(vals)))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, input.grade, input.classId);
		const answer = metric(input.classId, s);
		const wrong = wrongAnswers(input.classId, s);
		if (Object.values(wrong).some((w) => w !== null && !farApart(answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s, input.classId), code: null },
			answer: floatAnswer(answer, DIGITS)
		});
		const data = {
			k: s.k,
			metric: input.classId,
			users: s.users.map((u) => ({ total: u.total, items: u.items.map((x) => [x.id, x.score, x.rel ? 1 : 0]) }))
		};
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(data) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
