// REST semantics by a written specification of a resource: what PUT, PATCH, DELETE and POST answer, in which order
// the server checks method, existence, validity and uniqueness, and what the collection holds in the end.
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

interface Item {
	sku: string;
	qty: number;
}

interface Body {
	sku?: string;
	qty?: number;
}

interface Request {
	method: string;
	/** `null` — the collection `/items`, otherwise `/items/{id}`. */
	id: number | null;
	body: Body | null;
}

interface Params {
	items: Record<string, Item>;
	next: number;
	requests: Request[];
}

interface Rules {
	putCreates: boolean;
	putReplaces: boolean;
	deleteRepeat404: boolean;
	counter: boolean;
	validationFirst: boolean;
	methodFirst: boolean;
}

const RIGHT: Rules = {
	putCreates: true,
	putReplaces: true,
	deleteRepeat404: true,
	counter: true,
	validationFirst: true,
	methodFirst: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'put-missing-404': { putCreates: false },
	'put-merges': { putReplaces: false },
	'delete-repeat-204': { deleteRepeat404: false },
	'id-reuse': { counter: false },
	'conflict-first': { validationFirst: false },
	'not-allowed-as-404': { methodFirst: false }
};

const ALLOWED = { collection: ['GET', 'POST'], item: ['GET', 'PUT', 'PATCH', 'DELETE'] };

/** Codes of the requests (`201:<id>` for a creation), then `|` and the items `id:sku:qty` by id. */
function simulate(p: Params, rules: Rules): string {
	const items = new Map(Object.entries(p.items).map(([id, item]) => [Number(id), { ...item }]));
	const deleted = new Set<number>();
	let next = p.next;
	const out: string[] = [];
	const invalid = (body: Body | null, needSku: boolean): boolean =>
		body === null || (needSku && body.sku === undefined) || (body.qty !== undefined && body.qty < 0);
	const taken = (body: Body | null, self: number | null): boolean =>
		body?.sku !== undefined && [...items].some(([id, item]) => id !== self && item.sku === body.sku);
	/** 422 and 409 in the order of the rules; `null` when the body passes both. */
	const checks = (body: Body | null, needSku: boolean, self: number | null): string | null => {
		const order = rules.validationFirst ? ['422', '409'] : ['409', '422'];
		for (const code of order) {
			if (code === '422' && invalid(body, needSku)) return '422';
			if (code === '409' && taken(body, self)) return '409';
		}
		return null;
	};
	for (const q of p.requests) {
		const allowed = (q.id === null ? ALLOWED.collection : ALLOWED.item).includes(q.method);
		const exists = q.id !== null && items.has(q.id);
		if (!allowed && (rules.methodFirst || q.id === null || exists)) {
			out.push('405');
			continue;
		}
		if (!allowed) {
			out.push('404');
			continue;
		}
		if (q.id === null) {
			if (q.method === 'GET') {
				out.push('200');
				continue;
			}
			const failed = checks(q.body, true, null);
			if (failed) {
				out.push(failed);
				continue;
			}
			const id = rules.counter ? next : Math.max(0, ...items.keys()) + 1;
			next = Math.max(next, id) + 1;
			items.set(id, { sku: q.body?.sku ?? '', qty: q.body?.qty ?? 0 });
			out.push(`201:${id}`);
			continue;
		}
		const item = items.get(q.id);
		switch (q.method) {
			case 'GET':
				out.push(item ? '200' : '404');
				break;
			case 'DELETE':
				if (item) {
					items.delete(q.id);
					deleted.add(q.id);
					out.push('204');
				} else out.push(!rules.deleteRepeat404 && deleted.has(q.id) ? '204' : '404');
				break;
			case 'PATCH': {
				if (!item) {
					out.push('404');
					break;
				}
				const failed = checks(q.body, false, q.id);
				if (failed) {
					out.push(failed);
					break;
				}
				if (q.body?.sku !== undefined) item.sku = q.body.sku;
				if (q.body?.qty !== undefined) item.qty = q.body.qty;
				out.push('200');
				break;
			}
			case 'PUT': {
				const failed = checks(q.body, true, q.id);
				if (failed) {
					out.push(failed);
					break;
				}
				if (!item && !rules.putCreates) {
					out.push('404');
					break;
				}
				const replaced = { sku: q.body?.sku ?? '', qty: q.body?.qty ?? 0 };
				if (item && !rules.putReplaces) replaced.qty = q.body?.qty ?? item.qty;
				items.set(q.id, replaced);
				out.push(item ? '200' : `201:${q.id}`);
				break;
			}
		}
	}
	const state = [...items].sort(([a], [b]) => a - b).map(([id, it]) => `${id}:${it.sku}:${it.qty}`);
	return [...out, '|', ...(state.length ? state : ['-'])].join(' ');
}

function scenario(rng: Rng, classId: string): Params {
	const skus = rng.sample(['A17', 'B42', 'C08', 'D33', 'E91', 'F25', 'G64', 'H12'], 6);
	const ids = rng
		.sample(
			Array.from({ length: 20 }, (_, i) => 10 + i),
			rng.int(2, 3)
		)
		.sort((a, b) => a - b);
	const items: Record<string, Item> = {};
	ids.forEach((id, i) => {
		items[String(id)] = { sku: skus[i] ?? 'Z00', qty: rng.int(1, 30) };
	});
	const next = (ids.at(-1) ?? 10) + rng.int(1, 3);
	const existing = (): number => rng.pick(ids);
	const fresh = (): string => skus[rng.int(3, 5)] ?? 'Z99';
	const usedSku = (): string => skus[rng.int(0, ids.length - 1)] ?? 'A17';
	const qty = (): number => rng.int(0, 40);
	const requests: Request[] = [];
	const filler = (): Request =>
		rng.pick<Request>([
			{ method: 'GET', id: existing(), body: null },
			{ method: 'PATCH', id: existing(), body: { qty: qty() } },
			{ method: 'GET', id: rng.int(40, 49), body: null },
			{ method: 'POST', id: null, body: { sku: fresh(), qty: qty() } }
		]);
	if (classId === 'put-upsert') {
		requests.push(
			{ method: 'PUT', id: existing(), body: { sku: usedSku() } },
			{ method: 'PUT', id: rng.int(50, 59), body: { sku: fresh(), qty: qty() } },
			{ method: 'PATCH', id: existing(), body: { sku: fresh() } }
		);
	} else if (classId === 'delete-repeat') {
		const last = ids.at(-1) ?? 10;
		requests.push(
			{ method: 'DELETE', id: last, body: null },
			{ method: 'DELETE', id: last, body: null },
			{ method: 'GET', id: last, body: null },
			{ method: 'POST', id: null, body: { sku: fresh(), qty: qty() } }
		);
	} else if (classId === 'validation-order') {
		requests.push(
			{ method: 'POST', id: null, body: { sku: usedSku(), qty: -rng.int(1, 9) } },
			{ method: 'PATCH', id: existing(), body: { sku: usedSku() } },
			{ method: 'PUT', id: existing(), body: { qty: qty() } },
			{ method: 'POST', id: null, body: { sku: usedSku(), qty: qty() } }
		);
	} else {
		requests.push(
			{ method: 'POST', id: rng.int(40, 49), body: { sku: fresh(), qty: qty() } },
			{ method: 'DELETE', id: null, body: null },
			{ method: 'PUT', id: null, body: { sku: fresh(), qty: qty() } },
			{ method: 'POST', id: existing(), body: { sku: fresh() } }
		);
	}
	for (let k = rng.int(2, 3); k > 0; k -= 1) requests.push(filler());
	return { items, next, requests: rng.shuffle(requests) };
}

function showBody(body: Body | null): string {
	if (body === null) return '—';
	const parts = [
		...(body.sku !== undefined ? [`"sku": "${body.sku}"`] : []),
		...(body.qty !== undefined ? [`"qty": ${body.qty}`] : [])
	];
	return `\`{${parts.join(', ')}}\``;
}

function describe(p: Params): string {
	const initial = Object.entries(p.items).map(([id, it]) => `\`${id}\` — sku ${it.sku}, qty ${it.qty}`);
	return [
		`Ресурс \`/items\` — товары с полями \`sku\` (уникален среди товаров) и \`qty\` (целое ≥ 0). Сейчас есть: ${initial.join('; ')}. Счётчик номеров для POST — ${p.next}.`,
		'',
		'Спецификация сервера. Проверки идут строго по порядку, первая сработавшая даёт ответ:',
		'',
		'1. Метод, которого нет у адреса, — `405`: у `/items` есть только GET и POST, у `/items/{id}` — GET, PUT, PATCH и DELETE.',
		'2. Для GET, PATCH и DELETE по `/items/{id}`: товара нет — `404`.',
		'3. Тело невалидно — `422`: для POST и PUT обязателен `sku`; `qty`, если передан, должен быть ≥ 0.',
		'4. `sku` из тела уже у другого товара — `409`.',
		'',
		'Если проверки пройдены:',
		'',
		'- `GET` — `200`;',
		'- `POST /items` — новый товар с номером из счётчика (счётчик растёт на 1 и номера никогда не переиспользует), `201` и `Location: /items/{id}`; `qty` по умолчанию 0;',
		'- `PUT /items/{id}` — товара нет: создаётся с этим номером, `201`; есть: заменяется целиком телом, `200`; поля, которых нет в теле, получают значения по умолчанию (`qty` = 0);',
		'- `PATCH /items/{id}` — меняет только переданные поля, `200`;',
		'- `DELETE /items/{id}` — удаляет, `204`.',
		'',
		'Запросы по порядку:',
		'',
		'| # | запрос | тело |',
		'|---|---|---|',
		...p.requests.map(
			(q, i) => `| ${i + 1} | \`${q.method} /items${q.id === null ? '' : `/${q.id}`}\` | ${showBody(q.body)} |`
		),
		'',
		'Введите через пробел код ответа на каждый запрос по порядку (для `201` — через двоеточие номер созданного товара, например `201:17`), затем знак `|` и итоговые товары по возрастанию номера в виде `номер:sku:qty` (если товаров нет — `-`). Например: `200 201:17 404 | 12:A17:5 17:B42:0`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
store = {int(k): dict(v) for k, v in p["items"].items()}
counter = p["next"]
codes = []


def problem(body, need_sku, me):
    if body is None or (need_sku and "sku" not in body) or body.get("qty", 0) < 0:
        return "422"
    if "sku" in body and any(i != me and it["sku"] == body["sku"] for i, it in store.items()):
        return "409"
    return None


for q in p["requests"]:
    m, i, body = q["method"], q["id"], q["body"]
    if m not in (("GET", "POST") if i is None else ("GET", "PUT", "PATCH", "DELETE")):
        codes.append("405")
        continue
    if i is None:
        if m == "GET":
            codes.append("200")
            continue
        bad = problem(body, True, None)
        if bad:
            codes.append(bad)
            continue
        store[counter] = {"sku": body["sku"], "qty": body.get("qty", 0)}
        codes.append("201:%d" % counter)
        counter += 1
        continue
    if m in ("GET", "PATCH", "DELETE") and i not in store:
        codes.append("404")
        continue
    if m == "GET":
        codes.append("200")
    elif m == "DELETE":
        del store[i]
        codes.append("204")
    else:
        bad = problem(body, m == "PUT", i)
        if bad:
            codes.append(bad)
        elif m == "PATCH":
            store[i].update(body)
            codes.append("200")
        else:
            codes.append("200" if i in store else "201:%d" % i)
            store[i] = {"sku": body["sku"], "qty": body.get("qty", 0)}
state = ["%d:%s:%d" % (i, store[i]["sku"], store[i]["qty"]) for i in sorted(store)]
print(" ".join(codes), "|", " ".join(state) if state else "-")
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/put-upsert': ['put-missing-404', 'put-merges'],
	'junior/delete-repeat': ['delete-repeat-204', 'id-reuse'],
	'junior/validation-order': ['conflict-first'],
	'junior/method-not-allowed': ['not-allowed-as-404']
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
