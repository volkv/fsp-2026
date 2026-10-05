// Verifying webhook signatures: an HMAC over «timestamp.body» with the current or, during a rotation, the previous
// secret; a tolerance window around the time of receipt; a replay check by event id. The candidate finds which
// deliveries the receiver accepts and why the others are rejected.
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

/** What a signature was computed over: the secret, the timestamp and the body it signed. */
interface Signature {
	secret: string;
	t: number;
	body: string;
}

interface Delivery {
	received: number;
	id: string;
	t: number;
	body: string;
	signatures: Signature[];
}

interface Params {
	windowSec: number;
	current: string;
	previous: string | null;
	/** The previous secret is accepted for deliveries received before this moment. */
	previousUntil: number | null;
	deliveries: Delivery[];
}

interface Rules {
	futureOk: boolean;
	oldForever: boolean;
	allSignatures: boolean;
	recordOnReject: boolean;
	replayCheck: boolean;
	timestampSigned: boolean;
}

const RIGHT: Rules = {
	futureOk: false,
	oldForever: false,
	allSignatures: false,
	recordOnReject: false,
	replayCheck: true,
	timestampSigned: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'future-ok': { futureOk: true },
	'old-secret-forever': { oldForever: true },
	'all-signatures': { allSignatures: true },
	'record-on-reject': { recordOnReject: true },
	'no-replay-check': { replayCheck: false },
	'timestamp-not-signed': { timestampSigned: false }
};

/** Per delivery: `ok`, `bad-sig`, `stale` or `replay`; then `|` and the sum of the amounts accepted. */
function simulate(p: Params, rules: Rules): string {
	const accepted = new Set<string>();
	const out: string[] = [];
	let total = 0;
	for (const d of p.deliveries) {
		const secretOk = (s: Signature): boolean =>
			s.secret === p.current ||
			(s.secret === p.previous && (rules.oldForever || (p.previousUntil !== null && d.received < p.previousUntil)));
		const valid = (s: Signature): boolean =>
			secretOk(s) && s.body === d.body && (!rules.timestampSigned || s.t === d.t);
		const signed = rules.allSignatures
			? d.signatures.length > 0 && d.signatures.every(valid)
			: d.signatures.some(valid);
		const age = d.received - d.t;
		const fresh = rules.futureOk ? age <= p.windowSec : Math.abs(age) <= p.windowSec;
		let verdict: string;
		if (!signed) verdict = 'bad-sig';
		else if (!fresh) verdict = 'stale';
		else if (rules.replayCheck && accepted.has(d.id)) verdict = 'replay';
		else verdict = 'ok';
		if (verdict === 'ok' || rules.recordOnReject) accepted.add(d.id);
		if (verdict === 'ok') total += amountOf(d.body);
		out.push(verdict);
	}
	return [...out, '|', String(total)].join(' ');
}

const amountOf = (body: string): number => Number(/"amount":(\d+)/.exec(body)?.[1] ?? 0);

const SECRETS = ['whsec_live', 'whsec_main', 'whsec_prod'] as const;
const OLD = ['whsec_2024', 'whsec_prev', 'whsec_v1'] as const;
const FAKE = ['whsec_test', 'whsec_dev'] as const;

function scenario(rng: Rng, classId: string): Params {
	const windowSec = rng.pick([120, 300]);
	const current = rng.pick(SECRETS);
	const rotation = classId === 'rotation';
	const previous = rotation ? rng.pick(OLD) : null;
	const fake = rng.pick(FAKE);
	let clock = 1761000000 + rng.int(0, 9999) * 10;
	const ids = rng.sample(
		Array.from({ length: 90 }, (_, i) => 10 + i),
		8
	);
	let next = 0;
	const deliveries: Delivery[] = [];
	const body = (id: string, amount: number): string => `{"id":"${id}","amount":${amount}}`;
	const fresh = (): { id: string; amount: number } => ({ id: `evt_${ids[next++] ?? 0}`, amount: rng.int(1, 99) * 100 });
	const tick = (): number => (clock += rng.int(20, 120));
	/** A delivery signed honestly with `secret`, its timestamp `delay` seconds before receipt (negative — ahead). */
	const signedBy = (secret: string, delay: number, e = fresh()): Delivery => {
		const received = tick();
		const t = received - delay;
		const b = body(e.id, e.amount);
		return { received, id: e.id, t, body: b, signatures: [{ secret, t, body: b }] };
	};
	const near = (): number => rng.int(0, windowSec - 15);
	const kinds: string[] = [];
	if (classId === 'tolerance') {
		kinds.push(
			'future-far',
			'old',
			'future-near',
			'ok',
			rng.pick(['ok', 'fake', 'old']),
			rng.pick(['ok', 'future-far'])
		);
	} else if (rotation) {
		kinds.push('prev-early', 'ok', 'prev-late', 'dual-late', 'dual-fake', rng.pick(['ok', 'fake']));
	} else if (classId === 'replay') {
		kinds.push('ok', 'capture', 'old-then-retry', 'resend', rng.pick(['ok', 'fake']));
	} else {
		kinds.push('ok', 'retimed', 'reworded', rng.pick(['ok', 'old']), rng.pick(['retimed', 'ok']));
	}
	const order = rng.shuffle(kinds);
	const previousUntil = rotation ? clock + 60 * rng.int(3, 5) : null;
	let captured: Delivery | null = null;
	for (const kind of order) {
		switch (kind) {
			case 'ok':
				deliveries.push(signedBy(current, near()));
				break;
			case 'fake':
				deliveries.push(signedBy(fake, near()));
				break;
			case 'old':
				deliveries.push(signedBy(current, windowSec + rng.int(5, 400)));
				break;
			case 'future-near':
				deliveries.push(signedBy(current, -rng.int(1, windowSec - 10)));
				break;
			case 'future-far':
				deliveries.push(signedBy(current, -(windowSec + rng.int(5, 200))));
				break;
			case 'prev-early':
			case 'prev-late':
			case 'dual-late':
			case 'dual-fake': {
				const d = signedBy(kind === 'dual-fake' ? fake : (previous ?? current), near());
				if (kind === 'prev-early' && previousUntil !== null && d.received >= previousUntil) {
					d.received = previousUntil - rng.int(5, 30);
					d.t = d.received - near();
					d.signatures = [{ secret: previous ?? current, t: d.t, body: d.body }];
				}
				if (kind !== 'prev-early' && previousUntil !== null && d.received < previousUntil) {
					d.received = previousUntil + rng.int(5, 30);
					d.t = d.received - near();
					d.signatures = [{ secret: kind === 'dual-fake' ? fake : (previous ?? current), t: d.t, body: d.body }];
				}
				clock = Math.max(clock, d.received);
				if (kind === 'dual-late' || kind === 'dual-fake') {
					const extra = { secret: current, t: d.t, body: d.body };
					d.signatures = rng.bool() ? [...d.signatures, extra] : [extra, ...d.signatures];
				}
				deliveries.push(d);
				break;
			}
			case 'capture': {
				const d = signedBy(current, near());
				deliveries.push(d);
				captured = d;
				break;
			}
			case 'old-then-retry': {
				const e = fresh();
				deliveries.push(signedBy(current, windowSec + rng.int(5, 300), e));
				deliveries.push(signedBy(current, near(), e));
				break;
			}
			case 'resend': {
				const e = deliveries.find((d) => d !== captured);
				if (e) {
					deliveries.push(signedBy(current, near(), { id: e.id, amount: amountOf(e.body) }));
				}
				break;
			}
			case 'retimed': {
				// Someone replays an old delivery with a fresh timestamp in the header; the signature is the old one.
				const d = signedBy(current, windowSec + rng.int(30, 600));
				const t = d.received - near();
				deliveries.push({ ...d, t });
				break;
			}
			case 'reworded': {
				const d = signedBy(current, near());
				deliveries.push({ ...d, body: d.body.replace(/"amount":\d+/, `"amount":${rng.int(100, 999) * 100}`) });
				break;
			}
		}
	}
	// The captured delivery comes back unchanged, still inside the window.
	if (captured) {
		const received = tick();
		const t = captured.t;
		if (received - t <= windowSec) deliveries.push({ ...captured, received, t });
	}
	deliveries.sort((a, b) => a.received - b.received);
	return { windowSec, current, previous, previousUntil, deliveries };
}

function describe(p: Params): string {
	const sig = (s: Signature): string => `\`${s.secret} · ${s.t} · ${s.body}\``;
	const secrets = p.previous
		? `Текущий секрет — \`${p.current}\`. Идёт ротация: подписи прежним секретом \`${p.previous}\` принимаются у доставок, полученных раньше момента ${p.previousUntil ?? 0}.`
		: `Секрет подписи — \`${p.current}\`.`;
	return [
		`Получатель вебхуков проверяет каждую доставку. ${secrets} Окно допуска — ${p.windowSec} с.`,
		'',
		'Отправитель кладёт в заголовки метку времени `t` (секунды Unix) и одну или несколько подписей `v1` — HMAC-SHA256 строки «`t`.`тело`». В таблице подпись записана как `секрет · метка · тело` — каким секретом и по какой строке её вычислили. Проверки по порядку:',
		'',
		'1. Подпись: получатель вычисляет HMAC строки «`t` из заголовка . тело запроса» каждым допустимым секретом; доставка проходит, если с этим значением совпала хотя бы одна подпись `v1`. Иначе — `bad-sig`.',
		`2. Время: разница между моментом получения и \`t\` по модулю не больше ${p.windowSec} с. Иначе — \`stale\`.`,
		'3. Повтор: событие с таким `id` уже было принято — `replay`.',
		'4. Иначе доставка принята — `ok`, и её `id` запоминается. Отклонённая доставка `id` не запоминает.',
		'',
		'Доставки по порядку получения:',
		'',
		'| # | получено | id | `t` | тело | подписи `v1` |',
		'|---|---|---|---|---|---|',
		...p.deliveries.map(
			(d, i) =>
				`| ${i + 1} | ${d.received} | ${d.id} | ${d.t} | \`${d.body}\` | ${d.signatures.map(sig).join('<br>')} |`
		),
		'',
		'Введите через пробел вердикт по каждой доставке по порядку: `ok`, `bad-sig`, `stale` или `replay`, затем знак `|` и сумму `amount` принятых доставок. Например: `ok stale bad-sig | 4200`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
seen = set()
verdicts = []
paid = 0
for d in p["deliveries"]:
    keys = {p["current"]}
    if p["previous"] is not None and d["received"] < p["previousUntil"]:
        keys.add(p["previous"])
    expected = "%d.%s" % (d["t"], d["body"])
    good = any(s["secret"] in keys and "%d.%s" % (s["t"], s["body"]) == expected for s in d["signatures"])
    if not good:
        verdicts.append("bad-sig")
    elif abs(d["received"] - d["t"]) > p["windowSec"]:
        verdicts.append("stale")
    elif d["id"] in seen:
        verdicts.append("replay")
    else:
        seen.add(d["id"])
        verdicts.append("ok")
        paid += json.loads(d["body"])["amount"]
print(" ".join(verdicts), "|", paid)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/tolerance': ['future-ok'],
	'senior/rotation': ['old-secret-forever', 'all-signatures'],
	'senior/replay': ['record-on-reject', 'no-replay-check'],
	'senior/tampered': ['timestamp-not-signed']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		// No delivery sits exactly on the edge of the window or of the rotation.
		const edges = p.deliveries.some(
			(d) => Math.abs(d.received - d.t) === p.windowSec || d.received === p.previousUntil
		);
		if (edges) continue;
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
