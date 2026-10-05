// Optimistic locking over HTTP: clients read a resource with its ETag and write it back with PUT or PATCH, with or
// without `If-Match`, in a given order of turns. The candidate finds the codes of the writes and the final state:
// 412 and retries for the careful clients, lost updates for the others.
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

const FIELDS = ['price', 'stock', 'discount'] as const;
type Field = (typeof FIELDS)[number];
type State = Record<Field, number>;

interface Change {
	method: 'PUT' | 'PATCH';
	field: Field;
	/** `set` — the field gets the value; `add` — the field gets the value read plus delta. */
	op: 'set' | 'add';
	value: number;
}

interface Client {
	name: string;
	ifMatch: boolean;
	/** One GET for all of its changes: it writes them with the state and the ETag of that GET until a 412. */
	oneRead?: boolean;
	changes: Change[];
}

interface Params {
	initial: State;
	clients: Client[];
	turns: string[];
}

interface Rules {
	ifMatch: boolean;
	putReplaces: boolean;
	patchPartial: boolean;
	versionOn412: boolean;
	ownWriteKeepsEtag: boolean;
}

const RIGHT: Rules = {
	ifMatch: true,
	putReplaces: true,
	patchPartial: true,
	versionOn412: false,
	ownWriteKeepsEtag: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'if-match-ignored': { ifMatch: false },
	'put-as-patch': { putReplaces: false },
	'patch-as-put': { patchPartial: false },
	'version-on-412': { versionOn412: true },
	'own-write-keeps-etag': { ownWriteKeepsEtag: true }
};

interface Outcome {
	codes: string[];
	state: State;
	version: number;
	/** Whether every client finished within the turns. */
	finished: boolean;
	/** Turns that did something. */
	used: number;
}

function run(p: Params, rules: Rules): Outcome {
	const state: State = { ...p.initial };
	let version = 1;
	const codes: string[] = [];
	const progress = new Map(
		p.clients.map((c) => [c.name, { change: 0, read: null as null | { state: State; version: number } }])
	);
	let used = 0;
	for (const name of p.turns) {
		const client = p.clients.find((c) => c.name === name);
		const at = progress.get(name);
		if (!client || !at) throw new Error(`no client ${name}`);
		const change = client.changes[at.change];
		if (!change) continue;
		used += 1;
		if (at.read === null) {
			at.read = { state: { ...state }, version };
			continue;
		}
		const read = at.read;
		at.read = null;
		if (client.ifMatch && rules.ifMatch && read.version !== version) {
			codes.push('412');
			if (rules.versionOn412) version += 1;
			continue;
		}
		const value = change.op === 'set' ? change.value : read.state[change.field] + change.value;
		const partial = change.method === 'PATCH' ? rules.patchPartial : !rules.putReplaces;
		if (!partial) Object.assign(state, read.state);
		state[change.field] = value;
		version += 1;
		codes.push('200');
		at.change += 1;
		if (client.oneRead) at.read = rules.ownWriteKeepsEtag ? { state: { ...state }, version } : read;
	}
	const finished = p.clients.every((c) => (progress.get(c.name)?.change ?? 0) === c.changes.length);
	return { codes, state, version, finished, used };
}

const sameState = (a: Outcome, b: Outcome): boolean => FIELDS.every((f) => a.state[f] === b.state[f]);

const answerOf = (o: Outcome): string =>
	[...o.codes, o.state.price, o.state.stock, o.state.discount, o.version].join(' ');

function randomChange(rng: Rng, method: Change['method'], op: Change['op'], field: Field, initial: State): Change {
	if (op === 'add') return { method, field, op, value: rng.pick([-1, 1]) * rng.int(1, 9) };
	const base = initial[field];
	return { method, field, op, value: base + rng.pick([-1, 1]) * rng.int(2, 20) * (field === 'price' ? 10 : 1) };
}

function scenario(rng: Rng, classId: string): Params {
	const initial: State = { price: rng.int(30, 150) * 10, stock: rng.int(10, 60), discount: rng.int(0, 15) };
	const names = rng.sample(PERSON_NAMES, 4);
	const clients: Client[] = [];
	const name = (i: number): string => names[i] ?? `c${i}`;
	if (classId === 'put-lost-update') {
		clients.push({
			name: name(0),
			ifMatch: false,
			changes: [randomChange(rng, 'PUT', rng.pick(['set', 'add'] as const), rng.pick(FIELDS), initial)]
		});
		clients.push({
			name: name(1),
			ifMatch: true,
			changes: [randomChange(rng, rng.pick(['PUT', 'PATCH'] as const), 'add', rng.pick(FIELDS), initial)]
		});
		clients.push({
			name: name(2),
			ifMatch: rng.bool(),
			changes: [randomChange(rng, 'PATCH', 'set', rng.pick(FIELDS), initial)]
		});
	} else if (classId === 'patch-merge') {
		const [f1, f2, f3] = rng.shuffle(FIELDS) as [Field, Field, Field];
		clients.push({ name: name(0), ifMatch: false, changes: [randomChange(rng, 'PATCH', 'set', f1, initial)] });
		clients.push({ name: name(1), ifMatch: true, changes: [randomChange(rng, 'PUT', 'add', f2, initial)] });
		clients.push({
			name: name(2),
			ifMatch: false,
			changes: [randomChange(rng, 'PATCH', rng.pick(['set', 'add'] as const), f3, initial)]
		});
	} else if (classId === 'one-read') {
		clients.push({
			name: name(0),
			ifMatch: true,
			oneRead: true,
			changes: [
				randomChange(rng, rng.pick(['PUT', 'PATCH'] as const), 'add', rng.pick(FIELDS), initial),
				randomChange(
					rng,
					rng.pick(['PUT', 'PATCH'] as const),
					rng.pick(['set', 'add'] as const),
					rng.pick(FIELDS),
					initial
				)
			]
		});
		for (let i = 1; i < 3; i += 1) {
			clients.push({
				name: name(i),
				ifMatch: true,
				changes: [randomChange(rng, rng.pick(['PUT', 'PATCH'] as const), 'add', rng.pick(FIELDS), initial)]
			});
		}
	} else {
		for (let i = 0; i < 3; i += 1) {
			clients.push({
				name: name(i),
				ifMatch: true,
				changes: [randomChange(rng, rng.pick(['PUT', 'PATCH'] as const), 'add', rng.pick(FIELDS), initial)]
			});
		}
	}
	if (rng.bool(0.4)) {
		clients.push({
			name: name(3),
			ifMatch: true,
			changes: [randomChange(rng, 'PATCH', rng.pick(['set', 'add'] as const), rng.pick(FIELDS), initial)]
		});
	}
	// One more change for a random client, so that a client reads again after its own write.
	const extra = rng.pick(clients);
	extra.changes.push(randomChange(rng, rng.pick(['PUT', 'PATCH'] as const), 'add', rng.pick(FIELDS), initial));
	// Turns: a random interleaving that keeps reads apart from writes; grown until every client finishes.
	const turns: string[] = [];
	const p: Params = { initial, clients, turns };
	for (let guard = 0; guard < 60; guard += 1) {
		const o = run(p, RIGHT);
		if (o.finished) break;
		const pending = clients.filter((c) => {
			const probe = run({ ...p, turns: [...turns, c.name] }, RIGHT);
			return probe.used > o.used;
		});
		turns.push(rng.pick(pending).name);
	}
	return p;
}

function describeChange(c: Change): string {
	const what =
		c.op === 'set'
			? `${c.field} = ${c.value}`
			: `${c.field} = прочитанное ${c.value < 0 ? '−' : '+'} ${Math.abs(c.value)}`;
	return c.method === 'PUT' ? `\`PUT\`: ${what}, остальные поля — как прочитаны` : `\`PATCH\`: ${what}`;
}

function describe(p: Params): string {
	const clients = p.clients.map(
		(c) =>
			`- **${c.name}** (${c.oneRead ? 'делает один `GET` на все свои изменения и пишет их с `If-Match: <ETag из этого GET>` по прочитанным в нём данным; новый `GET` — только после `412`' : c.ifMatch ? 'пишет с `If-Match: <ETag из своего GET>`' : 'пишет без `If-Match`'}): ${c.changes
				.map((ch, i) => `${i + 1}) ${describeChange(ch)}`)
				.join('; ')}.`
	);
	return [
		`Ресурс \`/products/42\`: price = ${p.initial.price}, stock = ${p.initial.stock}, discount = ${p.initial.discount}; версия 1, \`ETag: "1"\`.`,
		'',
		'Сервер:',
		'',
		'- `GET` возвращает все поля и ETag текущей версии.',
		'- `PUT` заменяет все три поля значениями из тела; `PATCH` меняет только поля из тела.',
		'- Если в записи есть `If-Match` и он не совпадает с текущим ETag — ответ `412`, ресурс и версия не меняются. Иначе — `200`, версия растёт на 1. Запись без `If-Match` проходит всегда.',
		'',
		'Клиенты и их изменения по порядку:',
		'',
		...clients,
		'',
		'Каждое изменение клиент делает за два своих хода: первый ход — `GET`, второй — запись, тело которой посчитано по прочитанному. Клиент, получивший `412`, делает это же изменение заново: следующим ходом снова `GET`, затем запись. Ход клиента, у которого изменения кончились, пропускается.',
		...(p.clients.some((c) => c.oneRead)
			? [
					'',
					'Исключение — клиент с одним `GET`: после успешной записи следующее изменение он пишет сразу, одним ходом, по данным и ETag того же `GET`; ответ на запись ETag не содержит. После `412` он делает новый `GET` (ход) и пишет дальше по нему.'
				]
			: []),
		'',
		`Порядок ходов: ${p.turns.join(', ')}.`,
		'',
		'Введите через пробел коды ответов на все записи в порядке их выполнения, затем итоговые price, stock, discount и номер итоговой версии. Например: `200 412 200 1200 35 5 4`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
res = dict(p["initial"])
ver = 1
codes = []
clients = {c["name"]: c for c in p["clients"]}
step = {name: 0 for name in clients}
seen = {name: None for name in clients}
for name in p["turns"]:
    c = clients[name]
    if step[name] >= len(c["changes"]):
        continue
    if seen[name] is None:
        seen[name] = (dict(res), ver)
        continue
    snapshot, read_ver = seen[name]
    seen[name] = None
    ch = c["changes"][step[name]]
    if c["ifMatch"] and read_ver != ver:
        codes.append(412)
        continue
    if ch["op"] == "set":
        value = ch["value"]
    else:
        value = snapshot[ch["field"]] + ch["value"]
    if ch["method"] == "PUT":
        res = dict(snapshot)
    res[ch["field"]] = value
    ver += 1
    codes.append(200)
    step[name] += 1
    if c.get("oneRead"):
        seen[name] = (snapshot, read_ver)
print(*codes, res["price"], res["stock"], res["discount"], ver)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/put-lost-update': ['put-as-patch', 'if-match-ignored'],
	'senior/patch-merge': ['patch-as-put', 'if-match-ignored', 'version-on-412'],
	'senior/retry-412': ['if-match-ignored', 'version-on-412'],
	'senior/one-read': ['own-write-keeps-etag', 'if-match-ignored']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.classId);
		const right = run(p, RIGHT);
		if (!right.finished || p.turns.length > 16) continue;
		const answer = answerOf(right);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(run(p, { ...RIGHT, ...change }));
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		// Without If-Match the anchor must lose an update, not only answer with other codes.
		if (input.classId === 'retry-412' && sameState(run(p, { ...RIGHT, ifMatch: false }), right)) continue;
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
