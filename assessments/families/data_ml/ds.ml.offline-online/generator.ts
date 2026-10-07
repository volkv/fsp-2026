// Why offline metrics disagree with online ones, as a computation: the value of a new policy estimated from the logs
// of the old one (IPS, self-normalized IPS, doubly robust) and the click-through rate of an item corrected for the
// examination probability of the positions it was shown at. The estimator is named; its formula is the task.
import { farApart, floatAnswer, frameMarkdown, num, roundingRule, stdinJson, type Cell } from '../../_lib/ds.ts';
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
const DIGITS = 3;

const SEGMENTS = ['new', 'returning', 'vip', 'mobile', 'web', 'trial'] as const;
const POLICIES: Record<number, number[][]> = {
	2: [
		[0.5, 0.5],
		[0.8, 0.2],
		[0.25, 0.75],
		[0.6, 0.4],
		[0.9, 0.1]
	],
	3: [
		[0.5, 0.3, 0.2],
		[0.6, 0.2, 0.2],
		[0.25, 0.25, 0.5],
		[0.1, 0.3, 0.6],
		[0.4, 0.4, 0.2]
	]
};

interface LogRow {
	segment: string;
	action: string;
	p: number;
	reward: number;
}

interface Task {
	markdown: string;
	answer: number;
	wrong: Record<string, number | null>;
	probe: object;
}

function logs(rng: Rng): { rows: LogRow[]; target: Record<string, string>; actions: string[]; segments: string[] } {
	const segments = rng.sample(SEGMENTS, rng.int(3, 4));
	const actions = ['A', 'B', 'C'].slice(0, rng.int(2, 3));
	const policy = Object.fromEntries(segments.map((s) => [s, rng.pick(POLICIES[actions.length] ?? [])]));
	const ctr = Object.fromEntries(segments.flatMap((s) => actions.map((a) => [`${s}/${a}`, rng.int(1, 8) / 10])));
	const rows: LogRow[] = [];
	for (let i = rng.int(8, 14); i > 0; i -= 1) {
		const segment = rng.pick(segments);
		const probs = policy[segment] ?? [];
		let u = rng.next();
		let k = 0;
		while (k < probs.length - 1 && u >= (probs[k] ?? 0)) {
			u -= probs[k] ?? 0;
			k += 1;
		}
		const action = actions[k] ?? 'A';
		rows.push({ segment, action, p: probs[k] ?? 1, reward: rng.bool(ctr[`${segment}/${action}`] ?? 0.5) ? 1 : 0 });
	}
	const target = Object.fromEntries(segments.map((s) => [s, rng.pick(actions)]));
	return { rows, target, actions, segments };
}

function logTable(rows: readonly LogRow[]): string {
	return frameMarkdown(
		['segment', 'action', 'propensity', 'click'],
		rows.map((r): Cell[] => [r.segment, r.action, r.p, r.reward])
	);
}

function targetText(target: Record<string, string>): string {
	return Object.entries(target)
		.map(([s, a]) => `\`${s}\` → \`${a}\``)
		.join(', ');
}

function task(rng: Rng, classId: string): Task | null {
	if (classId === 'position-bias') {
		const theta = [1, rng.int(55, 80) / 100, rng.int(35, 54) / 100, rng.int(15, 34) / 100];
		const items = rng.sample(['item_17', 'item_42', 'item_08', 'item_73', 'item_29'], 3);
		const asked = rng.pick(items);
		const rows: { item: string; pos: number; shows: number; clicks: number }[] = [];
		for (const item of items) {
			const rel = rng.int(5, 40) / 100;
			for (const pos of rng.sample([1, 2, 3, 4], rng.int(2, 3)).sort()) {
				const shows = rng.int(20, 120) * 10;
				const clicks = Math.max(1, Math.round(shows * (theta[pos - 1] ?? 1) * rel * (1 + rng.int(-15, 15) / 100)));
				rows.push({ item, pos, shows, clicks });
			}
		}
		const mine = rows.filter((r) => r.item === asked);
		const clicks = mine.reduce((s, r) => s + r.clicks, 0);
		const shows = mine.reduce((s, r) => s + r.shows, 0);
		const examined = mine.reduce((s, r) => s + r.shows * (theta[r.pos - 1] ?? 1), 0);
		return {
			markdown: [
				'Объекты выдачи показывали на разных позициях. Журнал показов и кликов:',
				'',
				frameMarkdown(
					['item', 'position', 'impressions', 'clicks'],
					rows.map((r): Cell[] => [r.item, r.pos, r.shows, r.clicks])
				),
				'',
				`Модель клика: пользователь просматривает позицию k с вероятностью θₖ и, просмотрев, кликает по объекту с вероятностью rel объекта, независимо от позиции. θ₁ = ${num(theta[0] ?? 1)}, θ₂ = ${num(theta[1] ?? 1)}, θ₃ = ${num(theta[2] ?? 1)}, θ₄ = ${num(theta[3] ?? 1)}.`,
				'',
				`Оцените rel объекта \`${asked}\` так, чтобы ожидаемое по модели число его кликов совпало с наблюдаемым.`,
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: clicks / examined,
			wrong: {
				'raw-ctr': clicks / shows,
				'theta-inverted': clicks / mine.reduce((s, r) => s + r.shows / (theta[r.pos - 1] ?? 1), 0)
			},
			probe: { kind: 'position', rows, theta, asked }
		};
	}
	const { rows, target, actions, segments } = logs(rng);
	const matched = rows.filter((r) => target[r.segment] === r.action);
	if (matched.length < 2 || !matched.some((r) => r.reward === 1) || matched.length === rows.length) return null;
	const n = rows.length;
	const ipsSum = matched.reduce((s, r) => s + r.reward / r.p, 0);
	const ips = ipsSum / n;
	const matchedMean = matched.reduce((s, r) => s + r.reward, 0) / matched.length;
	const logged = rows.reduce((s, r) => s + r.reward, 0) / n;
	const intro = [
		`Старая политика показывала пользователям баннер (\`action\`) случайно с вероятностями, зависящими от сегмента; \`propensity\` — вероятность, с которой старая политика выбрала показанный баннер. Журнал:`,
		'',
		logTable(rows),
		'',
		`Новая детерминированная политика показывала бы: ${targetText(target)}.`,
		''
	];
	if (classId === 'ips') {
		return {
			markdown: [
				...intro,
				'Оцените ожидаемую кликабельность (среднее `click` на показ) новой политики по журналу оценкой IPS (inverse propensity scoring).',
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: ips,
			wrong: { 'logged-value': logged, 'matched-mean': matchedMean },
			probe: { kind: 'ips', rows, target }
		};
	}
	if (classId === 'snips') {
		const weights = matched.reduce((s, r) => s + 1 / r.p, 0);
		return {
			markdown: [
				...intro,
				'Оцените ожидаемую кликабельность (среднее `click` на показ) новой политики по журналу самонормированной оценкой SNIPS.',
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: ipsSum / weights,
			wrong: { 'plain-ips': ips, 'matched-mean': matchedMean, 'logged-value': logged },
			probe: { kind: 'snips', rows, target }
		};
	}
	const q = Object.fromEntries(segments.flatMap((s) => actions.map((a) => [`${s}/${a}`, rng.int(1, 9) / 10])));
	const dm = rows.reduce((s, r) => s + (q[`${r.segment}/${target[r.segment]}`] ?? 0), 0) / n;
	const dr = dm + matched.reduce((s, r) => s + (r.reward - (q[`${r.segment}/${r.action}`] ?? 0)) / r.p, 0) / n;
	return {
		markdown: [
			...intro,
			'Модель наград предсказывает вероятность клика q̂(сегмент, баннер):',
			'',
			frameMarkdown(
				['segment', ...actions],
				segments.map((s): Cell[] => [s, ...actions.map((a) => q[`${s}/${a}`] ?? 0)])
			),
			'',
			'Оцените ожидаемую кликабельность (среднее `click` на показ) новой политики по журналу дважды робастной оценкой (doubly robust) с этой моделью наград.',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		answer: dr,
		wrong: { 'plain-ips': ips, 'direct-method': dm },
		probe: { kind: 'dr', rows, target, q }
	};
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
kind = p["kind"]
if kind == "position":
    theta = p["theta"]
    mine = [r for r in p["rows"] if r["item"] == p["asked"]]
    print(repr(sum(r["clicks"] for r in mine) / sum(r["shows"] * theta[r["pos"] - 1] for r in mine)))
else:
    rows, target = p["rows"], p["target"]
    n = len(rows)
    num = 0.0
    den = 0.0
    for r in rows:
        if target[r["segment"]] == r["action"]:
            num += r["reward"] / r["p"]
            den += 1 / r["p"]
    if kind == "ips":
        print(repr(num / n))
    elif kind == "snips":
        print(repr(num / den))
    else:
        q = p["q"]
        total = 0.0
        for r in rows:
            total += q[r["segment"] + "/" + target[r["segment"]]]
            if target[r["segment"]] == r["action"]:
                total += (r["reward"] - q[r["segment"] + "/" + r["action"]]) / r["p"]
        print(repr(total / n))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 400; tries += 1) {
		const t = task(rng, input.classId);
		if (t === null) continue;
		if (Object.values(t.wrong).some((w) => w !== null && !farApart(t.answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: t.markdown, code: null },
			answer: floatAnswer(t.answer, DIGITS)
		});
		const all = Object.fromEntries(descriptor.wrongSolutions.map((w) => [w.id, t.wrong[w.id] ?? null]));
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(t.probe) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(all).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
