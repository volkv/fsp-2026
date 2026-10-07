// A message queue under a burst: the largest backlog and when the queue drains, given arrivals by interval and the
// consumers' throughput — with autoscaling that starts consumers after a delay, with more consumers than partitions,
// or with failed messages retried after a delay. Every rule of the model is in the statement.
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

interface Params {
	queue: string;
	arrivals: number[];
	rate: number;
	consumers: number;
	scale: { threshold: number; delay: number; max: number } | null;
	partitions: { count: number; from: number; consumers: number } | null;
	retry: { every: number; delay: number } | null;
	/** Reserve class X: one consumer per partition, a hot partition gets more; `arrivals` are the totals. */
	hot?: { count: number; hotArrivals: number[]; otherArrivals: number[] };
}

interface Rules {
	sameInterval: boolean;
	startDelay: boolean;
	orderedCount: boolean;
	partitionLimit: boolean;
	retries: boolean;
	retryDelay: boolean;
	perPartition: boolean;
}

const RIGHT: Rules = {
	sameInterval: true,
	startDelay: true,
	orderedCount: true,
	partitionLimit: true,
	retries: true,
	retryDelay: true,
	perPartition: true
};

const HORIZON = 60;

/** `<largest backlog> <the interval after which the queue stays empty>`, or null when it does not drain in time. */
function simulate(p: Params, rules: Rules): string | null {
	if (p.hot && rules.perPartition) return simulateLanes(p, p.hot, rules);
	let backlog = 0;
	let largest = 0;
	let active = p.consumers;
	const starts: number[] = [];
	const returns = new Map<number, number>();
	for (let i = 1; i <= HORIZON; i += 1) {
		active += starts.filter((at) => at === i).length;
		const incoming = (p.arrivals[i - 1] ?? 0) + (returns.get(i) ?? 0);
		let working = active;
		if (p.partitions) {
			working = i >= p.partitions.from ? p.partitions.consumers : p.consumers;
			if (rules.partitionLimit) working = Math.min(working, p.partitions.count);
		}
		const available = rules.sameInterval ? backlog + incoming : backlog;
		const processed = Math.min(available, working * p.rate);
		backlog = backlog + incoming - processed;
		if (p.retry && rules.retries) {
			const failed = Math.floor(processed / p.retry.every);
			if (failed > 0) {
				const at = i + (rules.retryDelay ? p.retry.delay : 1);
				returns.set(at, (returns.get(at) ?? 0) + failed);
			}
		}
		largest = Math.max(largest, backlog);
		if (p.scale && backlog > p.scale.threshold) {
			const ordered = starts.filter((at) => at > i).length;
			if (active + (rules.orderedCount ? ordered : 0) < p.scale.max)
				starts.push(i + 1 + (rules.startDelay ? p.scale.delay : 0));
		}
		// Drained: nothing waits, nothing new and nothing retried will come.
		if (backlog === 0 && i >= p.arrivals.length && ![...returns.keys()].some((at) => at > i)) return `${largest} ${i}`;
	}
	return null;
}

const QUEUES = ['orders.created', 'payments.events', 'emails.outbox', 'search.reindex', 'notifications.push'];

/** The hot-partition model: every partition is its own queue with its own consumer; the backlog is their sum. */
function simulateLanes(p: Params, hot: NonNullable<Params['hot']>, rules: Rules): string | null {
	const lanes = Array.from({ length: hot.count }, () => 0);
	let largest = 0;
	for (let i = 1; i <= HORIZON; i += 1) {
		for (let j = 0; j < hot.count; j += 1) {
			const incoming = (j === 0 ? hot.hotArrivals : hot.otherArrivals)[i - 1] ?? 0;
			const lane = lanes[j] ?? 0;
			const processed = Math.min(rules.sameInterval ? lane + incoming : lane, p.rate);
			lanes[j] = lane + incoming - processed;
		}
		const backlog = lanes.reduce((sum, x) => sum + x, 0);
		largest = Math.max(largest, backlog);
		if (backlog === 0 && i >= p.arrivals.length) return `${largest} ${i}`;
	}
	return null;
}

function scenario(rng: Rng, classId: string): Params {
	const rate = rng.int(4, 12) * 10;
	const consumers = classId === 'partitions' ? rng.int(2, 3) : rng.int(2, 4);
	const capacity = rate * consumers;
	const n = rng.int(6, 8);
	const burst = rng.int(2, 4);
	// A burst above the capacity, then a tail below it: the queue grows, then drains.
	const arrivals = Array.from({ length: n }, (_, i) =>
		i < burst
			? Math.round((capacity * rng.int(140, 260)) / 1000) * 10
			: Math.round((capacity * rng.int(30, 80)) / 1000) * 10
	);
	const p: Params = {
		queue: rng.pick(QUEUES),
		arrivals,
		rate,
		consumers,
		scale: null,
		partitions: null,
		retry: null
	};
	if (classId === 'hot-partition') {
		const count = rng.int(3, 6);
		const share = (low: number, high: number): number => Math.round((rate * rng.int(low, high)) / 1000) * 10;
		const hotArrivals = arrivals.map((_, i) => (i < burst ? share(140, 260) : share(30, 90)));
		const otherArrivals = arrivals.map((_, i) => (i < burst ? share(30, 80) : share(20, 60)));
		p.hot = { count, hotArrivals, otherArrivals };
		p.consumers = count;
		p.arrivals = hotArrivals.map((h, i) => h + (count - 1) * (otherArrivals[i] ?? 0));
	} else if (classId === 'autoscale') {
		p.scale = { threshold: rng.int(1, 4) * 50, delay: rng.int(1, 3), max: consumers + rng.int(2, 4) };
	} else if (classId === 'partitions') {
		const count = rng.int(3, 6);
		p.consumers = Math.min(consumers, count);
		p.partitions = { count, from: rng.int(2, 4), consumers: count + rng.int(1, 4) };
	} else {
		p.retry = { every: rng.pick([4, 5, 8, 10]), delay: rng.int(2, 4) };
	}
	return p;
}

function describe(p: Params): string {
	const rules = [
		p.hot
			? `- Топик разбит на ${p.hot.count} ${p.hot.count < 5 ? 'партиции' : 'партиций'}, у каждой свой потребитель: он читает только свою партицию, чужие сообщения не берёт. Ключи распределены неравномерно: в интервалах 1–${p.arrivals.length} в горячую партицию приходит соответственно ${p.hot.hotArrivals.join(', ')} сообщений, в каждую из остальных — ${p.hot.otherArrivals.join(', ')}; дальше новых сообщений нет. Отставание очереди — сумма отставаний партиций.`
			: `- В интервалах 1–${p.arrivals.length} в очередь приходит соответственно ${p.arrivals.join(', ')} сообщений, дальше новых сообщений нет.`,
		p.hot
			? `- Каждый потребитель обрабатывает до ${p.rate} сообщений своей партиции за интервал и не простаивает, пока в ней есть сообщения: обработано в партиции за интервал = min(отставание партиции + пришло в неё за интервал, ${p.rate}). Сообщения, пришедшие в интервале, можно обработать в этом же интервале.`
			: `- Каждый работающий потребитель обрабатывает до ${p.rate} сообщений за интервал, и работающие потребители не простаивают, пока есть сообщения: обработано за интервал = min(отставание + пришло за интервал, число работающих потребителей · ${p.rate}). Сообщения, пришедшие в интервале, можно обработать в этом же интервале.`,
		'- Отставание в конце интервала = отставание в конце предыдущего + пришло за интервал − обработано за интервал; вначале очередь пуста.'
	];
	if (p.scale) {
		rules.push(
			`- Вначале работают ${p.consumers} потребителя. В конце каждого интервала, если отставание больше ${p.scale.threshold}, а потребителей — работающих вместе с уже заказанными — меньше ${p.scale.max}, заказывается один новый потребитель. Заказанный в конце интервала i начинает работать с интервала i + ${1 + p.scale.delay} (запуск занимает ${p.scale.delay} ${p.scale.delay === 1 ? 'интервал' : 'интервала'}). Потребители не останавливаются.`
		);
	} else if (p.partitions) {
		rules.push(
			`- Топик разбит на ${p.partitions.count} ${p.partitions.count < 5 ? 'партиции' : 'партиций'}; одну партицию читает не больше одного потребителя, потребитель без партиции простаивает. Сообщения распределены по партициям так, что каждый читающий потребитель загружен, пока очередь не пуста.`,
			`- В интервалах 1–${p.partitions.from - 1} запущено ${p.consumers} потребителя, с интервала ${p.partitions.from} — ${p.partitions.consumers}.`
		);
	} else if (p.retry) {
		rules.push(
			`- Работают ${p.consumers} потребителя. Обработка части сообщений завершается ошибкой: из обработанных в интервале i сообщений ⌊обработано / ${p.retry.every}⌋ возвращаются в очередь и приходят в неё заново в интервале i + ${p.retry.delay} (задержка повтора); там они считаются пришедшими и обрабатываются наравне с новыми.`
		);
	}
	return [
		`Очередь \`${p.queue}\` разбирают потребители. Время идёт интервалами по минуте, интервалы нумеруются с 1.`,
		'',
		...rules,
		'',
		'Введите два числа через пробел: наибольшее отставание (в конце интервала) и номер первого интервала, в конце которого очередь пуста и больше не придёт ни новых, ни возвращённых сообщений. Например: `340 9`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
hot = p.get("hot")
if hot:
    lanes = [0] * hot["count"]
    peak = 0
    interval = 0
    while True:
        interval += 1
        for j in range(hot["count"]):
            series = hot["hotArrivals"] if j == 0 else hot["otherArrivals"]
            came = series[interval - 1] if interval <= len(series) else 0
            lanes[j] = max(0, lanes[j] + came - p["rate"])
        peak = max(peak, sum(lanes))
        if sum(lanes) == 0 and interval >= len(p["arrivals"]):
            print(peak, interval)
            break
else:
    queue = 0
    peak = 0
    consumers = p["consumers"]
    started_at = []
    come_back = {}
    interval = 0
    while True:
        interval += 1
        consumers += started_at.count(interval)
        arrived = (p["arrivals"][interval - 1] if interval <= len(p["arrivals"]) else 0) + come_back.pop(interval, 0)
        workers = consumers
        part = p["partitions"]
        if part:
            workers = min(part["consumers"] if interval >= part["from"] else p["consumers"], part["count"])
        done = min(queue + arrived, workers * p["rate"])
        queue += arrived - done
        if p["retry"] and done >= p["retry"]["every"]:
            back = interval + p["retry"]["delay"]
            come_back[back] = come_back.get(back, 0) + done // p["retry"]["every"]
        peak = max(peak, queue)
        scale = p["scale"]
        if scale and queue > scale["threshold"]:
            waiting = sum(1 for at in started_at if at > interval)
            if consumers + waiting < scale["max"]:
                started_at.append(interval + 1 + scale["delay"])
        if queue == 0 and interval >= len(p["arrivals"]) and not any(at > interval for at in come_back):
            print(peak, interval)
            break
`;

const WRONG: Record<string, Partial<Rules>> = {
	'late-arrivals': { sameInterval: false },
	'no-start-delay': { startDelay: false },
	'ignore-ordered': { orderedCount: false },
	'ignore-partitions': { partitionLimit: false },
	'no-retries': { retries: false },
	'retry-next-interval': { retryDelay: false },
	'pooled-partitions': { perPartition: false }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	autoscale: ['late-arrivals', 'no-start-delay', 'ignore-ordered'],
	partitions: ['late-arrivals', 'ignore-partitions'],
	retries: ['late-arrivals', 'no-retries', 'retry-next-interval'],
	'hot-partition': ['late-arrivals', 'pooled-partitions']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until the queue drains in time and every misconception of the class changes the answer.
	for (let tries = 0; tries < 2000; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = simulate(p, RIGHT);
		if (answer === null) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : (value ?? 'never')];
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 2000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
