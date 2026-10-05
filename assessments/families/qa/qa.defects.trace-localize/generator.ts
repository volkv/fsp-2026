// Localizing a defect in a pricing pipeline by its trace: every step has a contract (its output as a function of its
// own input), and the trace shows each step's input and output for one or several requests. The tester names the
// first step that breaks its contract and the value it should have produced from the input it actually got. Steps
// after it obey their contracts on a wrong input: the error becomes visible later, sometimes as another branch of a
// later step. The defect's kind and where it shows are the essential class; the numbers and requests are surface.
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
	/** Discount threshold, kopecks. */
	T: number;
	pct: number;
	couponRub: number;
	/** Free shipping threshold, kopecks. */
	F: number;
	shipRub: number;
	tax: number;
	/** Kopecks per one unit of the currency. */
	rates: Record<string, number>;
}

interface Req {
	id: string;
	currency: string;
	price: number;
	qty: number;
}

type StepName = 'subtotal' | 'discount' | 'coupon' | 'shipping' | 'tax' | 'convert' | 'round';
type Result = { out: number; branch: string };
type Run = (x: number, req: Req, p: Params) => Result;

const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

const RIGHT: Record<StepName, Run> = {
	subtotal: (_x, req) => ({ out: req.price * req.qty, branch: '' }),
	discount: (x, _r, p) =>
		x >= p.T ? { out: x - Math.floor((x * p.pct) / 100), branch: 'applied' } : { out: x, branch: 'none' },
	coupon: (x, _r, p) =>
		x - p.couponRub * 100 <= 0 ? { out: 0, branch: 'zero' } : { out: x - p.couponRub * 100, branch: 'applied' },
	shipping: (x, _r, p) => (x < p.F ? { out: x + p.shipRub * 100, branch: 'paid' } : { out: x, branch: 'free' }),
	tax: (x, _r, p) => ({ out: x + Math.floor((x * p.tax) / 100), branch: '' }),
	convert: (x, req, p) =>
		req.currency === 'RUB'
			? { out: x, branch: 'RUB' }
			: { out: Math.floor((x * 100) / (p.rates[req.currency] ?? 1)), branch: req.currency },
	round: (x) => ({ out: Math.floor((x + 50) / 100) * 100, branch: '' })
};

function contract(step: StepName, p: Params): string {
	switch (step) {
		case 'subtotal':
			return '`subtotal`: выход = `price` · `qty`.';
		case 'discount':
			return `\`discount\`: если вход не меньше ${p.T}, выход = вход − ${p.pct} % от входа (дробная часть копейки скидки отбрасывается); иначе выход = вход.`;
		case 'coupon':
			return `\`coupon\`: выход = вход − купон ${p.couponRub} рублей, но не меньше 0.`;
		case 'shipping':
			return `\`shipping\`: если вход меньше ${p.F}, выход = вход + доставка ${p.shipRub} рублей; иначе выход = вход.`;
		case 'tax':
			return `\`tax\`: выход = вход + ${p.tax} % от входа (дробная часть копейки налога отбрасывается).`;
		case 'convert':
			return `\`convert\`: в валюту счёта; RUB — выход = вход; иначе выход = вход · 100 / курс, дробная часть отбрасывается (выход в центах); курс — копеек за единицу валюты: ${Object.entries(
				p.rates
			)
				.map(([c, r]) => `${c} — ${r}`)
				.join(', ')}.`;
		case 'round':
			return '`round`: до целых рублей или целых единиц валюты: выход = вход, округлённый до кратного 100, половина (50) округляется вверх.';
	}
}

interface Defect {
	step: StepName;
	run: Run;
	/** A threshold set to the input of the step on the target request: the defect sits on the boundary. */
	boundary?: 'T' | 'F';
}

const DEFECTS: Record<string, Defect[]> = {
	'intern/boundary': [
		{
			step: 'discount',
			run: (x, _r, p) =>
				x > p.T ? { out: x - Math.floor((x * p.pct) / 100), branch: 'applied' } : { out: x, branch: 'none' },
			boundary: 'T'
		},
		{
			step: 'shipping',
			run: (x, _r, p) => (x <= p.F ? { out: x + p.shipRub * 100, branch: 'paid' } : { out: x, branch: 'free' }),
			boundary: 'F'
		}
	],
	'intern/arithmetic': [
		{
			step: 'discount',
			run: (x, _r, p) =>
				x >= p.T ? { out: x - Math.floor((p.T * p.pct) / 100), branch: 'applied' } : { out: x, branch: 'none' }
		},
		{
			step: 'coupon',
			run: (x, _r, p) =>
				x - 2 * p.couponRub * 100 <= 0
					? { out: 0, branch: 'zero' }
					: { out: x - 2 * p.couponRub * 100, branch: 'applied' }
		},
		{ step: 'tax', run: (x, _r, p) => ({ out: Math.floor((x * p.tax) / 100), branch: '' }) }
	],
	'intern/rounding': [
		{
			step: 'discount',
			run: (x, _r, p) =>
				x >= p.T ? { out: x - ceilDiv(x * p.pct, 100), branch: 'applied' } : { out: x, branch: 'none' }
		},
		{ step: 'tax', run: (x, _r, p) => ({ out: x + ceilDiv(x * p.tax, 100), branch: '' }) }
	],
	'intern/units': [
		{
			step: 'coupon',
			run: (x, _r, p) =>
				x - p.couponRub <= 0 ? { out: 0, branch: 'zero' } : { out: x - p.couponRub, branch: 'applied' }
		},
		{
			step: 'shipping',
			run: (x, _r, p) => (x < p.F ? { out: x + p.shipRub, branch: 'paid' } : { out: x, branch: 'free' })
		}
	],
	'junior/masked-branch': [
		{
			step: 'discount',
			run: (x, _r, p) =>
				x >= p.T ? { out: x - Math.floor((p.T * p.pct) / 100), branch: 'applied' } : { out: x, branch: 'none' }
		},
		{
			step: 'discount',
			run: (x, _r, p) =>
				x >= p.T ? { out: x - Math.floor((x * (p.pct + 5)) / 100), branch: 'applied' } : { out: x, branch: 'none' }
		}
	],
	'junior/rounding': [
		{
			step: 'discount',
			run: (x, _r, p) =>
				x >= p.T ? { out: x - ceilDiv(x * p.pct, 100), branch: 'applied' } : { out: x, branch: 'none' }
		},
		{ step: 'tax', run: (x, _r, p) => ({ out: x + ceilDiv(x * p.tax, 100), branch: '' }) },
		{ step: 'round', run: (x) => ({ out: Math.floor(x / 100) * 100, branch: '' }) }
	],
	'junior/currency': [
		{
			step: 'convert',
			run: (x, req, p) =>
				req.currency === 'RUB'
					? { out: x, branch: 'RUB' }
					: { out: Math.floor((x * (p.rates[req.currency] ?? 1)) / 100), branch: req.currency }
		},
		{
			step: 'convert',
			run: (x, req, p) =>
				req.currency === 'RUB'
					? { out: x, branch: 'RUB' }
					: { out: Math.floor((x * 100) / (p.rates[req.currency] ?? 1) + 0.5), branch: req.currency }
		}
	],
	'junior/boundary': [
		{
			step: 'discount',
			run: (x, _r, p) =>
				x > p.T ? { out: x - Math.floor((x * p.pct) / 100), branch: 'applied' } : { out: x, branch: 'none' },
			boundary: 'T'
		},
		{
			step: 'shipping',
			run: (x, _r, p) => (x <= p.F ? { out: x + p.shipRub * 100, branch: 'paid' } : { out: x, branch: 'free' }),
			boundary: 'F'
		}
	]
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/boundary': ['consumer-step', 'last-step'],
	'intern/arithmetic': ['consumer-step'],
	'intern/rounding': ['consumer-step'],
	'intern/units': ['consumer-step'],
	'junior/masked-branch': ['visible-step', 'last-step'],
	'junior/rounding': ['last-step'],
	'junior/currency': [],
	'junior/boundary': ['consumer-step']
};

interface Trace {
	req: Req;
	ins: number[];
	outs: number[];
	branches: string[];
}

function runTrace(steps: readonly StepName[], req: Req, p: Params, defect: Defect | null): Trace {
	const ins: number[] = [];
	const outs: number[] = [];
	const branches: string[] = [];
	let x = 0;
	for (const step of steps) {
		ins.push(x);
		const run = defect && defect.step === step ? defect.run : RIGHT[step];
		const r = run(x, req, p);
		outs.push(r.out);
		branches.push(r.branch);
		x = r.out;
	}
	return { req, ins, outs, branches };
}

function distinct(rng: Rng, count: number, draw: () => string): string[] {
	const out = new Set<string>();
	while (out.size < count) out.add(draw());
	return [...out];
}

function makeParams(rng: Rng): Params {
	return {
		T: rng.int(30, 150) * 1000,
		pct: rng.pick([5, 7, 10, 12, 15]),
		couponRub: rng.pick([100, 150, 200, 300, 500]),
		F: rng.int(20, 120) * 1000,
		shipRub: rng.pick([199, 249, 299, 349, 399]),
		tax: rng.pick([10, 18, 20]),
		rates: { EUR: rng.int(9600, 10400), USD: rng.int(8800, 9600), CNY: rng.int(1200, 1350) }
	};
}

function makeRequest(rng: Rng, id: string, currency: string): Req {
	return { id, currency, price: rng.int(500, 5999) * 10 + rng.pick([0, 0, 1, 3, 7, 9]), qty: rng.int(1, 9) };
}

const PYTHON_REFERENCE = `import json

d = json.loads(input())
p = d["params"]


def step_out(step, x, req):
    if step == "subtotal":
        return req["price"] * req["qty"]
    if step == "discount":
        return x - x * p["pct"] // 100 if x >= p["T"] else x
    if step == "coupon":
        return max(x - p["couponRub"] * 100, 0)
    if step == "shipping":
        return x + p["shipRub"] * 100 if x < p["F"] else x
    if step == "tax":
        return x + x * p["tax"] // 100
    if step == "convert":
        if req["currency"] == "RUB":
            return x
        return x * 100 // p["rates"][req["currency"]]
    if step == "round":
        return (x + 50) // 100 * 100
    raise ValueError(step)


def first_violation():
    for req in d["requests"]:
        x = None
        for step, out in zip(d["steps"], req["outs"]):
            want = step_out(step, x, req)
            if out != want:
                return "%s %d" % (step, want)
            x = out
    return "none"


print(first_violation())
`;

function describe(steps: readonly StepName[], p: Params, traces: readonly Trace[], multi: boolean): string {
	const lines: string[] = [];
	for (const tr of traces) {
		lines.push(`запрос ${tr.req.id}, валюта счёта ${tr.req.currency}`);
		steps.forEach((step, i) => {
			const input = step === 'subtotal' ? `price=${tr.req.price} qty=${tr.req.qty}` : String(tr.ins[i]);
			lines.push(`  ${step.padEnd(9)} ${input.padEnd(22)} -> ${tr.outs[i]}`);
		});
		lines.push('');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	return [
		`Конвейер расчёта цены заказа: шаги выполняются по порядку, выход шага — вход следующего. Все суммы — в копейках (после \`convert\` — в центах валюты счёта). Контракты шагов:`,
		'',
		...steps.map((step, i) => `${i + 1}. ${contract(step, p)}`),
		'',
		multi
			? 'Трасса нескольких запросов — вход и выход каждого шага, запросы в порядке обработки:'
			: 'Трасса запроса — вход и выход каждого шага:',
		'',
		'```',
		...lines,
		'```',
		'',
		multi
			? 'Найдите первое нарушение контракта: возьмите первый по порядку запрос, где какой-то шаг нарушает свой контракт, и первый такой шаг в нём. Введите имя шага и значение, которое он должен был выдать по контракту при своём фактическом входе, через пробел. Например: `tax 41250`.'
			: 'Найдите первый шаг, нарушивший свой контракт. Введите его имя и значение, которое он должен был выдать по контракту при своём фактическом входе, через пробел. Например: `tax 41250`.'
	].join('\n');
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const where = `${input.grade}/${input.classId}`;
	const defects = DEFECTS[where] ?? [];
	const required = REQUIRED[where] ?? [];
	const junior = input.grade === 'junior';
	for (let tries = 0; tries < 400; tries += 1) {
		const p = makeParams(rng);
		const defect = rng.pick(defects);
		const steps: StepName[] = junior
			? ['subtotal', 'discount', 'shipping', 'tax', 'convert', 'round']
			: rng.bool(0.6) || defect.step === 'coupon'
				? ['subtotal', 'discount', 'coupon', 'shipping', 'tax']
				: ['subtotal', 'discount', 'shipping', 'tax'];
		const ids = distinct(rng, junior ? 3 : 1, () => `o-${rng.int(1000, 9999)}`);
		const currencies = junior
			? input.classId === 'currency'
				? ['RUB', rng.pick(['EUR', 'USD', 'CNY']), rng.pick(['EUR', 'USD', 'CNY', 'RUB'])]
				: ids.map(() => rng.pick(['RUB', 'RUB', 'EUR', 'USD', 'CNY']))
			: ['RUB'];
		const reqs = ids.map((id, i) => makeRequest(rng, id, currencies[i] ?? 'RUB'));
		const j = steps.indexOf(defect.step);
		// The target request: where the defect must show (junior: never the first one).
		const target = junior ? rng.int(1, reqs.length - 1) : 0;
		const targetReq = reqs[target];
		if (j < 0 || !targetReq) continue;
		if (defect.boundary) {
			// The target request lands exactly on a round threshold: its subtotal (discount) or the input of shipping.
			const qty = rng.pick([1, 2, 4, 5, 8]);
			if (defect.boundary === 'T') {
				targetReq.qty = qty;
				targetReq.price = p.T / qty;
			} else {
				const subtotal = p.F + (steps.includes('coupon') ? p.couponRub * 100 : 0);
				targetReq.qty = qty;
				targetReq.price = subtotal / qty;
				p.T = Math.max(p.T, subtotal + rng.int(1, 50) * 1000);
			}
		}
		if (where === 'junior/masked-branch') {
			// A round free-shipping threshold between the right and the wrong discount: the next step switches its branch.
			const ideal = runTrace(steps, targetReq, p, null).outs[j] ?? 0;
			const wrong = runTrace(steps, targetReq, p, defect).outs[j] ?? 0;
			const lo = Math.min(ideal, wrong);
			const hi = Math.max(ideal, wrong);
			const step = Math.floor(lo / 1000) * 1000 + 1000 <= hi ? 1000 : 100;
			const threshold = Math.floor(lo / step) * step + step;
			if (threshold > hi) continue;
			p.F = threshold;
		}
		const traces = reqs.map((r) => runTrace(steps, r, p, defect));
		const ideals = reqs.map((r) => runTrace(steps, r, p, null));
		// The first request with a violation and the first violating step in it.
		let first = -1;
		let k = -1;
		for (let r = 0; r < traces.length && first < 0; r += 1) {
			const tr = traces[r];
			if (!tr) continue;
			for (let i = 0; i < steps.length; i += 1) {
				const step = steps[i] as StepName;
				if (RIGHT[step](tr.ins[i] ?? 0, tr.req, p).out !== tr.outs[i]) {
					first = r;
					k = i;
					break;
				}
			}
		}
		if (first < 0 || k !== j) continue;
		if (junior && first === 0) continue;
		if (p.T <= 0 || p.F <= 0) continue;
		const tr = traces[first] as Trace;
		const ideal = ideals[first] as Trace;
		const want = RIGHT[defect.step](tr.ins[j] ?? 0, tr.req, p).out;
		const answer = `${defect.step} ${want}`;
		const last = steps.length - 1;
		let visible: string | null = null;
		for (let i = j + 1; i < steps.length; i += 1) {
			if (tr.branches[i] !== ideal.branches[i]) {
				visible = `${steps[i]} ${ideal.outs[i]}`;
				break;
			}
		}
		const candidates: Record<string, string | null> = {
			'last-step': j === last ? null : `${steps[last]} ${ideal.outs[last]}`,
			'visible-step': visible,
			'consumer-step': j === last ? null : `${steps[j + 1]} ${ideal.outs[j + 1]}`
		};
		const wrong = Object.fromEntries(
			Object.entries(candidates).map(([id, v]) => [id, v === null || v === answer ? null : v])
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(steps, p, traces, junior), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({
			params: p,
			steps,
			requests: traces.map((t) => ({ ...t.req, outs: t.outs }))
		});
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
	throw new Error(`${descriptor.key}: no trace for ${where} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
