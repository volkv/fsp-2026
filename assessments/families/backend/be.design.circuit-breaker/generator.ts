// A circuit breaker in front of a dependency: given a timeline of calls and how the dependency would answer them,
// which calls run and which are rejected at once. The breaker trips on consecutive failures or on failures in a
// sliding window, waits while open and lets one or several probe calls through when half-open. Every rule of the
// model is in the statement.
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

interface Call {
	t: number;
	ok: boolean;
	/** Reserve class X: how long the call took. */
	ms?: number;
}

interface Params {
	dependency: string;
	calls: Call[];
	openSec: number;
	trip: { kind: 'consecutive'; failures: number } | { kind: 'window'; size: number; failures: number };
	probes: number;
	/** Reserve class X: a call this long or longer counts as a failure for the breaker. */
	slowMs?: number;
}

interface Rules {
	timerInclusive: boolean;
	resetOnSuccess: boolean;
	restartTimer: boolean;
	clearWindow: boolean;
	allProbes: boolean;
	slowCounts: boolean;
}

const RIGHT: Rules = {
	timerInclusive: true,
	resetOnSuccess: true,
	restartTimer: true,
	clearWindow: true,
	allProbes: true,
	slowCounts: true
};

/** `ok`, `fail` or `rej` for every call, in order. */
function simulate(p: Params, rules: Rules): string {
	let state: 'closed' | 'open' | 'half' = 'closed';
	let failures = 0;
	let window: boolean[] = [];
	let openedAt = 0;
	let probesOk = 0;
	const out: string[] = [];
	for (const call of p.calls) {
		if (state === 'open') {
			const due = openedAt + p.openSec;
			if (rules.timerInclusive ? call.t >= due : call.t > due) {
				state = 'half';
				probesOk = 0;
			} else {
				out.push('rej');
				continue;
			}
		}
		out.push(call.ok ? 'ok' : 'fail');
		const good = call.ok && !(rules.slowCounts && p.slowMs !== undefined && (call.ms ?? 0) >= p.slowMs);
		let tripped = false;
		let restart = true;
		if (state === 'half') {
			if (!good) {
				tripped = true;
				restart = rules.restartTimer;
			} else {
				probesOk += 1;
				if (probesOk >= (rules.allProbes ? p.probes : 1)) {
					state = 'closed';
					failures = 0;
					if (rules.clearWindow) window = [];
				}
			}
		} else if (p.trip.kind === 'consecutive') {
			if (!good) failures += 1;
			else if (rules.resetOnSuccess) failures = 0;
			tripped = failures >= p.trip.failures;
		} else {
			window.push(good);
			if (window.length > p.trip.size) window.shift();
			tripped = window.length === p.trip.size && window.filter((ok) => !ok).length >= p.trip.failures;
		}
		if (tripped) {
			state = 'open';
			if (restart) openedAt = call.t;
			failures = 0;
			if (rules.clearWindow) window = [];
		}
	}
	return out.join(' ');
}

const DEPENDENCIES = ['payments-gateway', 'geo-service', 'recommendations', 'sms-provider', 'inventory-api'];

function scenario(rng: Rng, classId: string): Params {
	const openSec = rng.pick([10, 15, 20, 30]);
	const count = rng.int(16, 22);
	const calls: Call[] = [];
	let t = rng.int(0, 5);
	// The dependency alternates between healthy and failing periods.
	let failing = false;
	for (let i = 0; i < count; i += 1) {
		if (rng.bool(0.25)) failing = !failing;
		calls.push({ t, ok: failing ? rng.bool(0.2) : rng.bool(0.85) });
		t += rng.pick([1, 2, 3, 5, 5, 10]);
	}
	const trip: Params['trip'] =
		classId === 'window'
			? (() => {
					const size = rng.int(4, 6);
					return { kind: 'window' as const, size, failures: Math.ceil(size / 2) };
				})()
			: { kind: 'consecutive', failures: rng.int(2, 3) };
	const p: Params = {
		dependency: rng.pick(DEPENDENCIES),
		calls,
		openSec,
		trip,
		probes: classId === 'half-open-probes' ? rng.int(2, 3) : 1
	};
	if (classId === 'slow-calls') {
		const slowMs = rng.pick([500, 800, 1000]);
		p.slowMs = slowMs;
		for (const call of calls) {
			call.ms =
				call.ok && rng.bool(0.4)
					? slowMs + rng.int(0, 5) * 100
					: call.ok
						? rng.int(5, slowMs / 10 - 1) * 10
						: rng.int(1, 30) * 10;
		}
	}
	return p;
}

function describe(p: Params): string {
	const rules = ['- Вначале выключатель закрыт: вызовы выполняются, ответ зависимости возвращается вызывающему.'];
	if (p.slowMs !== undefined) {
		rules.push(
			`- Вызов, длившийся ${p.slowMs} мс или дольше, выключатель считает неудачным (медленным), даже если зависимость ответила успехом; вызывающий при этом получает ответ (\`ok\`). Ниже «ошибка» и «неудача» для выключателя — это ошибка или медленный вызов, «успех» — быстрый успешный вызов.`
		);
	}
	if (p.trip.kind === 'consecutive') {
		rules.push(
			`- Закрытый выключатель открывается, когда ${p.trip.failures} выполненных вызова подряд завершились ошибкой; успешный вызов обнуляет счёт ошибок.`
		);
	} else {
		rules.push(
			`- Закрытый выключатель помнит результаты последних ${p.trip.size} выполненных вызовов (скользящее окно) и открывается, когда в окне ${p.trip.size} результатов и среди них не меньше ${p.trip.failures} ошибок. При открытии и при закрытии выключателя окно очищается.`
		);
	}
	rules.push(
		'- Выключатель открывается в момент вызова, который его открыл. Пока он открыт, вызовы отклоняются сразу (`rej`) и до зависимости не доходят.',
		`- Первый вызов, сделанный через ${p.openSec} с после открытия или позже (t ≥ момент открытия + ${p.openSec}), переводит выключатель в полуоткрытое состояние и выполняется как пробный.`
	);
	if (p.probes === 1) {
		rules.push(
			`- Если пробный вызов успешен, выключатель закрывается${p.trip.kind === 'consecutive' ? ', счёт ошибок начинается с нуля' : ''}; если неудачен — снова открывается, и ${p.openSec} с отсчитываются заново от этого вызова.`
		);
	} else {
		rules.push(
			`- В полуоткрытом состоянии выполняются ${p.probes} пробных вызова подряд: любая неудача снова открывает выключатель, и ${p.openSec} с отсчитываются заново от неё; после ${p.probes} успешных проб подряд выключатель закрывается, счёт ошибок начинается с нуля.`
		);
	}
	return [
		`Сервис вызывает зависимость \`${p.dependency}\` через автоматический выключатель (circuit breaker). Вызовы по порядку (время — в секундах) и как ответит зависимость, если вызов до неё дойдёт:`,
		'',
		...p.calls.map(
			(c, i) => `${i + 1}. t = ${c.t}: ${c.ok ? 'успех' : 'ошибка'}${c.ms === undefined ? '' : ` за ${c.ms} мс`}`
		),
		'',
		'Правила выключателя:',
		'',
		...rules,
		'',
		'Введите для каждого вызова по порядку через пробел: `ok` или `fail` — если вызов выполнен (по ответу зависимости), `rej` — если отклонён сразу. Например: `ok fail fail rej ok`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
trip = p["trip"]
state = "closed"
streak = 0
recent = []
opened = None
probes_left = 0
answer = []
for call in p["calls"]:
    t = call["t"]
    good = call["ok"] and not ("slowMs" in p and call["ms"] >= p["slowMs"])
    if state == "open":
        if t - opened < p["openSec"]:
            answer.append("rej")
            continue
        state, probes_left = "half", p["probes"]
    answer.append("ok" if call["ok"] else "fail")
    if state == "half":
        if not good:
            state, opened, recent, streak = "open", t, [], 0
        else:
            probes_left -= 1
            if probes_left == 0:
                state, recent, streak = "closed", [], 0
        continue
    if trip["kind"] == "consecutive":
        streak = 0 if good else streak + 1
        tripped = streak >= trip["failures"]
    else:
        recent = (recent + [good])[-trip["size"]:]
        tripped = len(recent) == trip["size"] and recent.count(False) >= trip["failures"]
    if tripped:
        state, opened, recent, streak = "open", t, [], 0
print(" ".join(answer))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'timer-exclusive': { timerInclusive: false },
	'no-reset': { resetOnSuccess: false },
	'timer-not-restarted': { restartTimer: false },
	'window-kept': { clearWindow: false },
	'single-probe': { allProbes: false },
	'slow-ignored': { slowCounts: false }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	consecutive: ['timer-exclusive', 'no-reset', 'timer-not-restarted'],
	window: ['timer-exclusive', 'window-kept'],
	'half-open-probes': ['single-probe', 'timer-not-restarted'],
	'slow-calls': ['slow-ignored', 'timer-exclusive']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Timelines are drawn until every misconception of the class changes the answer.
	for (let tries = 0; tries < 5000; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = simulate(p, RIGHT);
		if (answer.split(' ').filter((x) => x === 'rej').length < 2) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if ((REQUIRED[input.classId] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no timeline for ${input.grade}/${input.classId} after 5000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
