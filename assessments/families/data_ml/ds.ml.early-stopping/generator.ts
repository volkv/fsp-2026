// Early stopping and model selection by validation curves: the epoch training stops at and the epoch whose weights
// are kept (Junior; Middle — with a warm-up), the model the one-standard-error rule picks along a complexity axis, and
// the epochs ReduceLROnPlateau lowers the learning rate on. Curve values are thousandths, so ties are exact.
import { frameMarkdown, stdinJson, type Cell } from '../../_lib/ds.ts';
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

const milli = (v: number): string => (v / 1000).toFixed(3);

interface StopRule {
	mode: 'min' | 'max';
	delta: number;
	patience: number;
	warmup: number;
}

interface StopVariant {
	monitorTrain?: boolean;
	offByOne?: boolean;
	lastWeights?: boolean;
	wrongDirection?: boolean;
	equalImproves?: boolean;
	globalMin?: boolean;
	ignoreMinDelta?: boolean;
	ignoreWarmup?: boolean;
}

/** Early stopping with restoring the best weights: `<stop epoch> <restored epoch> <its monitored value>`. */
function earlyStop(
	monitored: readonly number[],
	train: readonly number[],
	rule: StopRule,
	v: StopVariant = {}
): string {
	const values = v.monitorTrain ? train : monitored;
	const mode = v.wrongDirection ? (rule.mode === 'min' ? 'max' : 'min') : rule.mode;
	const delta = v.ignoreMinDelta ? 0 : rule.delta;
	const warmup = v.ignoreWarmup ? 0 : rule.warmup;
	let best: number | null = null;
	let bestEpoch = 0;
	let wait = 0;
	let stop = values.length;
	for (let e = 1; e <= values.length; e += 1) {
		if (e <= warmup) continue;
		const x = values[e - 1] ?? 0;
		const better =
			best === null ||
			(mode === 'min'
				? v.equalImproves
					? x <= best - delta
					: x < best - delta
				: v.equalImproves
					? x >= best + delta
					: x > best + delta);
		if (better) {
			best = x;
			bestEpoch = e;
			wait = 0;
		} else {
			wait += 1;
			if (v.offByOne ? wait > rule.patience : wait >= rule.patience) {
				stop = e;
				break;
			}
		}
	}
	let restored = v.lastWeights ? stop : bestEpoch;
	if (v.globalMin) {
		const seen = values.slice(0, stop);
		const target = rule.mode === 'min' ? Math.min(...seen) : Math.max(...seen);
		restored = seen.indexOf(target) + 1;
	}
	return `${stop} ${restored} ${milli(values[restored - 1] ?? 0)}`;
}

/** A loss curve: falls to a minimum at epoch `bottom`, then wanders up with occasional dips. */
function lossCurve(rng: Rng, epochs: number, bottom: number): number[] {
	const start = rng.int(600, 900);
	const floor = rng.int(150, 350);
	const weights = Array.from({ length: bottom - 1 }, () => rng.int(1, 6));
	const total = weights.reduce((s, w) => s + w, 0);
	const out: number[] = [start];
	let x = start;
	let spent = 0;
	for (let e = 2; e <= epochs; e += 1) {
		if (e <= bottom) {
			spent += weights[e - 2] ?? 0;
			x = Math.round(start - ((start - floor) * spent) / total);
		} else x += rng.bool(0.25) ? -rng.int(1, 12) : rng.int(2, 40);
		out.push(Math.max(30, x));
	}
	return out;
}

function trainCurve(rng: Rng, epochs: number): number[] {
	const out: number[] = [];
	let x = rng.int(700, 950);
	for (let e = 0; e < epochs; e += 1) {
		out.push(x);
		x -= rng.int(8, 60);
		x = Math.max(x, 20 + epochs - e);
	}
	return out;
}

interface Task {
	markdown: string;
	answer: string;
	wrong: Record<string, string | null>;
	probe: object;
}

const STOP_TEXT = (rule: StopRule, metric: string): string =>
	[
		`Правило ранней остановки по \`${metric}\`${rule.mode === 'min' ? ' (чем меньше, тем лучше)' : ' (чем больше, тем лучше)'}: терпение patience = ${rule.patience}, min_delta = ${milli(rule.delta)}${rule.warmup ? `, разогрев — эпохи 1…${rule.warmup}` : ''}, веса лучшей эпохи восстанавливаются.`,
		'',
		...(rule.warmup ? [`- Эпохи 1…${rule.warmup} не учитываются вовсе: ни как лучшее значение, ни в счётчике.`] : []),
		`- Значение эпохи — улучшение, если оно строго ${rule.mode === 'min' ? 'меньше «лучшее − min_delta»' : 'больше «лучшее + min_delta»'}; первая учитываемая эпоха — всегда улучшение. При улучшении оно становится лучшим, а счётчик обнуляется.`,
		'- Иначе счётчик эпох без улучшения растёт на 1; когда он достигает patience, обучение останавливается после этой эпохи.',
		'- Если остановки не было, обучение заканчивается после последней эпохи таблицы.',
		'- После остановки восстанавливаются веса эпохи, на которой последний раз было улучшение.'
	].join('\n');

const STOP_ANSWER =
	'Введите три значения через пробел: номер эпохи, после которой обучение остановится, номер эпохи, чьи веса восстановятся, и значение отслеживаемой метрики на ней — как в таблице. Например: `9 6 0.412`.';

function curveTable(columns: string[], cols: readonly (readonly number[])[]): string {
	const rows: Cell[][] = (cols[0] ?? []).map((_, i) => [i + 1, ...cols.map((c) => milli(c[i] ?? 0))]);
	return frameMarkdown(['epoch', ...columns], rows);
}

function juniorTask(rng: Rng, classId: string): Task {
	const epochs = rng.int(12, 20);
	const patience = rng.int(2, 4);
	const bottom = rng.int(4, epochs - patience - 3);
	const train = trainCurve(rng, epochs);
	let val = lossCurve(rng, epochs, bottom);
	const rule: StopRule = { mode: 'min', delta: 0, patience, warmup: 0 };
	let metric = 'val_loss';
	if (classId === 'maximize') {
		metric = 'val_auc';
		rule.mode = 'max';
		val = val.map((x) => Math.min(990, Math.round(500 + (950 - x) / 2)));
	}
	if (classId === 'equal-not-better') {
		// The epoch after the best repeats the best value exactly.
		const best = Math.min(...val.slice(0, bottom));
		const at = val.indexOf(best);
		val[at + 1] = best;
		for (let e = at + 2; e < Math.min(epochs, at + 2 + patience); e += 1) val[e] = best + rng.int(3, 40);
	}
	if (classId === 'min-delta') {
		rule.delta = rng.int(3 * patience + 2, 3 * patience + 10);
		// After the last significant improvement the loss creeps down by less than min_delta in total, then rises.
		let x = val[bottom - 1] ?? 300;
		for (let e = bottom; e < epochs; e += 1) {
			x += e < bottom + patience + 1 ? -rng.int(1, 3) : rng.int(2, 30);
			val[e] = x;
		}
	}
	const table = curveTable(metric === 'val_auc' ? ['train_loss', 'val_auc'] : ['train_loss', 'val_loss'], [train, val]);
	const answer = earlyStop(val, train, rule);
	const common = {
		'monitor-train': earlyStop(val, train, rule, { monitorTrain: true }),
		'off-by-one': earlyStop(val, train, rule, { offByOne: true }),
		'last-weights': earlyStop(val, train, rule, { lastWeights: true })
	};
	const wrong: Record<string, string | null> =
		classId === 'patience'
			? common
			: classId === 'maximize'
				? { ...common, 'monitor-train': null, 'wrong-direction': earlyStop(val, train, rule, { wrongDirection: true }) }
				: classId === 'equal-not-better'
					? { ...common, 'monitor-train': null, 'equal-improves': earlyStop(val, train, rule, { equalImproves: true }) }
					: {
							...common,
							'monitor-train': null,
							'global-min': earlyStop(val, train, rule, { globalMin: true }),
							'ignore-min-delta': earlyStop(val, train, rule, { ignoreMinDelta: true })
						};
	return {
		markdown: [
			`Кривые обучения модели по эпохам (\`train_loss\` — на обучающей выборке, \`${metric}\` — на валидационной):`,
			'',
			table,
			'',
			STOP_TEXT(rule, metric),
			'',
			STOP_ANSWER
		].join('\n'),
		answer,
		wrong,
		probe: { kind: 'stop', values: val, ...rule }
	};
}

interface Grid {
	labels: string[];
	cv: number[];
	se: number[];
	train: number[];
}

/**
 * The one-standard-error rule along a complexity axis: index 0 is the simplest model when `simpleFirst`, otherwise
 * the last one is. Returns `<model> <its cv error>`.
 */
function oneSe(g: Grid, simpleFirst: boolean, v: 'right' | 'min-cv' | 'min-train' | 'own-se' | 'complex-side'): string {
	const n = g.cv.length;
	const order = simpleFirst ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
	const best = g.cv.indexOf(Math.min(...g.cv));
	let pick: number;
	if (v === 'min-cv') pick = best;
	else if (v === 'min-train') pick = g.train.indexOf(Math.min(...g.train));
	else {
		const within = (i: number): boolean =>
			(g.cv[i] ?? 0) <= (g.cv[best] ?? 0) + (v === 'own-se' ? (g.se[i] ?? 0) : (g.se[best] ?? 0));
		const inBand = order.filter(within);
		pick = (v === 'complex-side' ? inBand[inBand.length - 1] : inBand[0]) ?? best;
	}
	return `${g.labels[pick] ?? ''} ${milli(g.cv[pick] ?? 0)}`;
}

/** A grid whose simplest end is index 0: a U-shaped cv error with the minimum at `best` and its band. */
function grid(rng: Rng, labels: string[]): Grid {
	const n = labels.length;
	const best = rng.int(3, n - 3);
	const se = labels.map(() => rng.int(10, 40));
	const cv: number[] = Array.from({ length: n }, () => 0);
	const floor = rng.int(150, 400);
	cv[best] = floor;
	const band = floor + (se[best] ?? 0);
	// The 1-SE pick sits one or two steps simpler than the best, a still simpler model is just outside the band.
	const pick = best - rng.int(1, 2);
	for (let i = best - 1; i > pick; i -= 1) cv[i] = rng.int(floor + 1, band - 1);
	cv[pick] = rng.int(floor + 1, band);
	cv[pick - 1] = band + rng.int(2, 12);
	se[pick - 1] = Math.max(se[pick - 1] ?? 0, (cv[pick - 1] ?? 0) - floor + rng.int(1, 8));
	for (let i = pick - 2; i >= 0; i -= 1) cv[i] = (cv[i + 1] ?? 0) + rng.int(20, 90);
	// On the complex side one model is still inside the band, the rest climb out of it.
	cv[best + 1] = rng.int(floor + 1, band);
	for (let i = best + 2; i < n; i += 1) cv[i] = Math.max(band + 1, (cv[i - 1] ?? 0) + rng.int(5, 60));
	const train: number[] = [];
	let t = rng.int(500, 800);
	for (let i = 0; i < n; i += 1) {
		train.push(t);
		t = Math.max(5 + n - i, t - rng.int(20, 90));
	}
	return { labels, cv, se, train };
}

const LAMBDAS = ['0.0001', '0.0003', '0.001', '0.003', '0.01', '0.03', '0.1', '0.3', '1', '3', '10', '30', '100'];

interface PlateauRule {
	patience: number;
	cooldown: number;
	maxCuts: number;
}

/** ReduceLROnPlateau on a loss: the epochs after which the learning rate is lowered. */
function plateau(
	values: readonly number[],
	rule: PlateauRule,
	v: { noCooldown?: boolean; noMinLr?: boolean } = {}
): string {
	let best = Number.POSITIVE_INFINITY;
	let wait = 0;
	let cooldown = 0;
	let cuts = 0;
	const out: number[] = [];
	values.forEach((x, i) => {
		if (cooldown > 0) {
			cooldown -= 1;
			wait = 0;
		}
		if (x < best) {
			best = x;
			wait = 0;
		} else if (cooldown === 0) {
			wait += 1;
			if (wait >= rule.patience && (v.noMinLr || cuts < rule.maxCuts)) {
				cuts += 1;
				out.push(i + 1);
				cooldown = v.noCooldown ? 0 : rule.cooldown;
				wait = 0;
			}
		}
	});
	return out.length ? out.join(' ') : '-';
}

function middleTask(rng: Rng, classId: string): Task | null {
	if (classId === 'warmup') {
		const epochs = rng.int(18, 28);
		const patience = rng.int(3, 5);
		const warmup = rng.int(3, 5);
		const bottom = rng.int(warmup + 4, epochs - patience - 2);
		const train = trainCurve(rng, epochs);
		const val = lossCurve(rng, epochs, bottom);
		// A spuriously good epoch inside the warm-up.
		const dip = rng.int(2, warmup);
		val[dip - 1] = Math.min(...val) - rng.int(5, 40);
		const rule: StopRule = { mode: 'min', delta: rng.int(0, 8), patience, warmup };
		return {
			markdown: [
				'Кривые обучения модели по эпохам:',
				'',
				curveTable(['train_loss', 'val_loss'], [train, val]),
				'',
				STOP_TEXT(rule, 'val_loss'),
				'',
				STOP_ANSWER
			].join('\n'),
			answer: earlyStop(val, train, rule),
			wrong: {
				'ignore-warmup': earlyStop(val, train, rule, { ignoreWarmup: true }),
				'global-min': earlyStop(val, train, rule, { globalMin: true }),
				'off-by-one': earlyStop(val, train, rule, { offByOne: true }),
				'last-weights': earlyStop(val, train, rule, { lastWeights: true }),
				'ignore-min-delta': rule.delta === 0 ? null : earlyStop(val, train, rule, { ignoreMinDelta: true })
			},
			probe: { kind: 'stop', values: val, ...rule }
		};
	}
	if (classId === 'one-se-degree' || classId === 'one-se-lambda') {
		const n = rng.int(7, 9);
		const degree = classId === 'one-se-degree';
		const start = rng.int(0, LAMBDAS.length - n);
		// For λ the simplest model is the strongest regularization: the grid is built simplest-first and shown ascending.
		const labels = degree
			? Array.from({ length: n }, (_, i) => String(i + 1))
			: LAMBDAS.slice(start, start + n).reverse();
		const g = grid(rng, labels);
		const shown: Grid = degree
			? g
			: {
					labels: [...g.labels].reverse(),
					cv: [...g.cv].reverse(),
					se: [...g.se].reverse(),
					train: [...g.train].reverse()
				};
		const name = degree ? 'degree' : 'lambda';
		const rows: Cell[][] = shown.labels.map((l, i) => [
			l,
			milli(shown.train[i] ?? 0),
			milli(shown.cv[i] ?? 0),
			milli(shown.se[i] ?? 0)
		]);
		return {
			markdown: [
				degree
					? 'Полиномиальную регрессию разной степени оценили 10-кратной кросс-валидацией: средняя ошибка на обучающих фолдах (`train_mse`), средняя ошибка на валидационных (`cv_mse`) и её стандартная ошибка (`cv_se`).'
					: 'Ridge-регрессию с разной силой регуляризации `lambda` оценили 10-кратной кросс-валидацией: средняя ошибка на обучающих фолдах (`train_mse`), средняя ошибка на валидационных (`cv_mse`) и её стандартная ошибка (`cv_se`).',
				'',
				frameMarkdown([name, 'train_mse', 'cv_mse', 'cv_se'], rows),
				'',
				`Модель выбирают по правилу одной стандартной ошибки: среди моделей, у которых \`cv_mse\` не больше, чем \`cv_mse\` + \`cv_se\` модели с наименьшей \`cv_mse\`, берут самую простую.`,
				'',
				`Введите через пробел выбранное значение \`${name}\` и его \`cv_mse\` — как в таблице. Например: \`${degree ? '3' : '0.1'} 0.245\`.`
			].join('\n'),
			answer: oneSe(g, true, 'right'),
			wrong: {
				'min-cv': oneSe(g, true, 'min-cv'),
				'min-train': oneSe(g, true, 'min-train'),
				'own-se': oneSe(g, true, 'own-se'),
				'complex-side': oneSe(g, true, 'complex-side')
			},
			probe: { kind: 'one-se', ...g }
		};
	}
	const epochs = rng.int(22, 30);
	const rule: PlateauRule = { patience: rng.int(2, 3), cooldown: rng.int(1, 3), maxCuts: rng.int(2, 3) };
	const factor = rng.pick([0.5, 0.2, 0.1]);
	const lr = rng.pick([0.1, 0.01, 0.001]);
	// Stretches of progress separated by plateaus, the last plateau long enough to need more cuts than allowed.
	const val: number[] = [];
	let x = rng.int(600, 900);
	let best = x;
	for (let e = 0; e < epochs; e += 1) {
		const plateauing = rng.bool(e > epochs * 0.6 ? 0.85 : 0.5);
		x = plateauing ? best + rng.int(0, 25) : best - rng.int(5, 60);
		best = Math.min(best, x);
		val.push(Math.max(30, x));
	}
	const minLr = lr * factor ** rule.maxCuts;
	return {
		markdown: [
			'Валидационная ошибка по эпохам:',
			'',
			curveTable(['val_loss'], [val]),
			'',
			`Шаг обучения снижает \`ReduceLROnPlateau(monitor='val_loss', factor=${factor}, patience=${rule.patience}, cooldown=${rule.cooldown}, min_lr=${Number(minLr.toPrecision(6))})\`, начальный шаг — ${lr}. После каждой эпохи по порядку:`,
			'',
			'1. если счётчик паузы больше 0, он уменьшается на 1, а счётчик ожидания обнуляется;',
			'2. если `val_loss` строго меньше лучшего значения, оно становится лучшим, счётчик ожидания обнуляется;',
			'3. иначе, если счётчик паузы равен 0, счётчик ожидания растёт на 1; когда он достигает patience и шаг больше min_lr, шаг умножается на factor (но не ниже min_lr), счётчик паузы становится равным cooldown, счётчик ожидания обнуляется.',
			'',
			'Введите через пробел номера эпох, после которых шаг обучения снизится, по возрастанию. Например: `6 11 17`.'
		].join('\n'),
		answer: plateau(val, rule),
		wrong: {
			'no-cooldown': plateau(val, rule, { noCooldown: true }),
			'no-min-lr': plateau(val, rule, { noMinLr: true })
		},
		probe: { kind: 'plateau', values: val, ...rule }
	};
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
kind = p["kind"]
if kind == "stop":
    vals = p["values"]
    sign = 1 if p["mode"] == "min" else -1
    best = None
    best_epoch = 0
    wait = 0
    stop = len(vals)
    for epoch, v in enumerate(vals, start=1):
        if epoch <= p["warmup"]:
            continue
        if best is None or sign * v < sign * best - p["delta"]:
            best, best_epoch, wait = v, epoch, 0
        else:
            wait += 1
            if wait >= p["patience"]:
                stop = epoch
                break
    print(stop, best_epoch, "%.3f" % (vals[best_epoch - 1] / 1000))
elif kind == "one-se":
    cv, se, labels = p["cv"], p["se"], p["labels"]
    b = min(range(len(cv)), key=lambda i: cv[i])
    pick = next(i for i in range(len(cv)) if cv[i] <= cv[b] + se[b])
    print(labels[pick], "%.3f" % (cv[pick] / 1000))
else:
    best = float("inf")
    wait = cool = cuts = 0
    out = []
    for epoch, v in enumerate(p["values"], start=1):
        if cool > 0:
            cool -= 1
            wait = 0
        if v < best:
            best, wait = v, 0
        elif cool == 0:
            wait += 1
            if wait >= p["patience"] and cuts < p["maxCuts"]:
                cuts += 1
                out.append(epoch)
                cool, wait = p["cooldown"], 0
    print(" ".join(map(str, out)) if out else "-")
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 400; tries += 1) {
		const task = input.grade === 'junior' ? juniorTask(rng, input.classId) : middleTask(rng, input.classId);
		if (task === null || task.answer === '-') continue;
		if (Object.values(task.wrong).some((w) => w === task.answer)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: task.markdown, code: null },
			answer: { kind: 'tokens', value: task.answer }
		});
		const all = Object.fromEntries(descriptor.wrongSolutions.map((w) => [w.id, task.wrong[w.id] ?? null]));
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(task.probe) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(all).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
