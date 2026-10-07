// Synchronisation of an offline queue with the server: the phone edits notes without network, the tablet edits them
// online, and at sync the phone sends its queue in order. The server resolves conflicts by last-write-wins on the
// device's timestamp, by a merge of fields, or by versions (optimistic locking with a retry after a refetch); deletes
// leave tombstones. The answer is the state of the notes on the server after the sync.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildCompute, type ComputeItem, type Required } from '../../_lib/mob-data.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const REQUIRED: Required = {
	'middle/lww': ['arrival-wins', 'field-level'],
	'middle/version-retry': ['reject-drops', 'retry-overwrites-all'],
	'middle/field-merge': ['record-level'],
	'middle/delete-update': ['delete-always-wins'],
	'senior/clock-skew': ['skew-corrected', 'arrival-wins'],
	'senior/queue-versions': ['reject-drops', 'retry-overwrites-all'],
	'senior/tombstone-version': ['update-resurrects'],
	'senior/merge-skew': ['skew-corrected', 'record-level']
};

type Strategy = 'lww' | 'merge' | 'version';
type Field = 'title' | 'color';
const FIELDS: readonly Field[] = ['title', 'color'];
type Fields = Partial<Record<Field, string>>;

/** An edit or a delete of a note by a device, at a moment of true time (minutes after 9:00). */
interface Op {
	at: number;
	device: 'phone' | 'tablet';
	note: number;
	kind: 'edit' | 'delete';
	fields: Fields;
}

interface Scenario {
	strategy: Strategy;
	/** Minutes the phone's clock is ahead (positive) or behind (negative). */
	skew: number;
	notes: { id: number; title: string; color: string }[];
	ops: Op[];
	/** The moment the phone gets the network and sends its queue. */
	syncAt: number;
}

interface Rules {
	arrivalWins: boolean;
	fieldLevel: boolean;
	recordLevel: boolean;
	rejectDrops: boolean;
	retryOverwritesAll: boolean;
	deleteAlwaysWins: boolean;
	skewCorrected: boolean;
	updateResurrects: boolean;
}

const RIGHT: Rules = {
	arrivalWins: false,
	fieldLevel: false,
	recordLevel: false,
	rejectDrops: false,
	retryOverwritesAll: false,
	deleteAlwaysWins: false,
	skewCorrected: false,
	updateResurrects: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'arrival-wins': { arrivalWins: true },
	'field-level': { fieldLevel: true },
	'record-level': { recordLevel: true },
	'reject-drops': { rejectDrops: true },
	'retry-overwrites-all': { retryOverwritesAll: true },
	'delete-always-wins': { deleteAlwaysWins: true },
	'skew-corrected': { skewCorrected: true },
	'update-resurrects': { updateResurrects: true }
};

interface ServerNote {
	fields: Record<Field, string>;
	version: number;
	deleted: boolean;
	/** Timestamp of the last applied write of the whole note (lww) and of each field (merge); of the delete. */
	stamp: number;
	fieldStamps: Record<Field, number>;
	deleteStamp: number;
}

/** A queued phone operation: what the phone sends at sync. */
interface Queued {
	op: Op;
	stamp: number;
	/** The note on the phone after the edit. */
	snapshot: Record<Field, string>;
}

const hhmm = (minutes: number): string => {
	const total = 9 * 60 + minutes;
	return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

function simulate(s: Scenario, rules: Rules): string[] {
	const server = new Map<number, ServerNote>();
	const phone = new Map<number, Record<Field, string>>();
	const known = new Map<number, number>();
	for (const n of s.notes) {
		const fields = { title: n.title, color: n.color };
		server.set(n.id, {
			fields: { ...fields },
			version: 1,
			deleted: false,
			stamp: 0,
			fieldStamps: { title: 0, color: 0 },
			deleteStamp: -1
		});
		phone.set(n.id, { ...fields });
		known.set(n.id, 1);
	}
	const note = (id: number): ServerNote => {
		const n = server.get(id);
		if (!n) throw new Error(`no note ${id}`);
		return n;
	};
	const strategy: Strategy =
		s.strategy === 'lww' && rules.fieldLevel
			? 'merge'
			: s.strategy === 'merge' && rules.recordLevel
				? 'lww'
				: s.strategy;

	/** Applies a write stamped `stamp` under a timestamp strategy; `force` — a misconception applies it regardless. */
	const applyStamped = (q: { op: Op; stamp: number; snapshot: Record<Field, string> }, force: boolean): void => {
		const n = note(q.op.note);
		const { op, stamp } = q;
		if (n.deleted) {
			if (op.kind === 'delete') return;
			if (rules.deleteAlwaysWins) return;
			if (!force && stamp <= n.deleteStamp) return;
			n.deleted = false;
			if (strategy === 'lww') {
				n.fields = { ...q.snapshot };
				n.stamp = stamp;
			} else
				for (const f of FIELDS)
					if (op.fields[f] !== undefined) {
						n.fields[f] = op.fields[f];
						n.fieldStamps[f] = stamp;
					}
			return;
		}
		if (op.kind === 'delete') {
			const latest = strategy === 'lww' ? n.stamp : Math.max(...FIELDS.map((f) => n.fieldStamps[f]));
			if (force || rules.deleteAlwaysWins || stamp > latest) {
				n.deleted = true;
				n.deleteStamp = stamp;
			}
			return;
		}
		if (strategy === 'lww') {
			if (force || stamp > n.stamp) {
				n.fields = { ...q.snapshot };
				n.stamp = stamp;
			}
			return;
		}
		for (const f of FIELDS) {
			const value = op.fields[f];
			if (value !== undefined && (force || stamp > n.fieldStamps[f])) {
				n.fields[f] = value;
				n.fieldStamps[f] = stamp;
			}
		}
	};

	/** Applies a write that carries a base version; `true` when the server accepted it. */
	const applyVersioned = (op: Op, fields: Fields, base: number): boolean => {
		const n = note(op.note);
		if (base !== n.version) return false;
		if (n.deleted) return false;
		if (op.kind === 'delete') n.deleted = true;
		else for (const f of FIELDS) if (fields[f] !== undefined) n.fields[f] = fields[f];
		n.version += 1;
		return true;
	};

	const queue: Queued[] = [];
	for (const op of [...s.ops].sort((a, b) => a.at - b.at)) {
		if (op.device === 'tablet') {
			const n = note(op.note);
			const snapshot = { ...n.fields, ...op.fields };
			if (s.strategy === 'version') applyVersioned(op, op.fields, n.version);
			else applyStamped({ op, stamp: op.at, snapshot }, false);
			continue;
		}
		const local = phone.get(op.note);
		if (!local) throw new Error(`phone has no note ${op.note}`);
		Object.assign(local, op.fields);
		queue.push({
			op,
			stamp: rules.skewCorrected ? op.at : op.at + s.skew,
			snapshot: { ...local }
		});
	}
	for (const q of queue) {
		if (s.strategy !== 'version') {
			applyStamped(q, rules.arrivalWins);
			continue;
		}
		const base = known.get(q.op.note) ?? 1;
		const sent: Fields = q.op.kind === 'edit' ? q.op.fields : {};
		if (applyVersioned(q.op, sent, base)) {
			known.set(q.op.note, note(q.op.note).version);
			continue;
		}
		// 409: the phone refetches the note and, unless it was deleted, sends its change again on top of it.
		if (rules.rejectDrops) continue;
		const n = note(q.op.note);
		known.set(q.op.note, n.version);
		if (n.deleted) {
			if (rules.updateResurrects && q.op.kind === 'edit') {
				n.deleted = false;
				n.fields = { ...q.snapshot };
				n.version += 1;
				known.set(q.op.note, n.version);
			}
			continue;
		}
		const retry: Fields = q.op.kind === 'edit' && rules.retryOverwritesAll ? q.snapshot : sent;
		if (!applyVersioned(q.op, retry, n.version)) throw new Error('a retry on a fresh version is rejected');
		known.set(q.op.note, n.version);
	}
	return s.notes.map(({ id }) => {
		const n = note(id);
		const v = s.strategy === 'version' ? ` v${n.version}` : '';
		return n.deleted ? `${id}${v} deleted` : `${id}${v} ${n.fields.title} ${n.fields.color}`;
	});
}

const PYTHON_REFERENCE = String.raw`import json

s = json.loads(input())
FIELDS = ("title", "color")
srv = {}
for n in s["notes"]:
    srv[n["id"]] = {"f": {"title": n["title"], "color": n["color"]}, "ver": 1, "gone": False,
                    "ts": 0, "fts": {"title": 0, "color": 0}, "dts": -1}
phone = {n["id"]: {"title": n["title"], "color": n["color"]} for n in s["notes"]}
mode = s["strategy"]

def stamped(note_id, kind, changed, snap, ts):
    r = srv[note_id]
    if r["gone"]:
        if kind == "edit" and ts > r["dts"]:
            r["gone"] = False
            if mode == "lww":
                r["f"], r["ts"] = dict(snap), ts
            else:
                for k, v in changed.items():
                    r["f"][k], r["fts"][k] = v, ts
        return
    if kind == "delete":
        newest = r["ts"] if mode == "lww" else max(r["fts"].values())
        if ts > newest:
            r["gone"], r["dts"] = True, ts
        return
    if mode == "lww":
        if ts > r["ts"]:
            r["f"], r["ts"] = dict(snap), ts
    else:
        for k, v in changed.items():
            if ts > r["fts"][k]:
                r["f"][k], r["fts"][k] = v, ts

def versioned(note_id, kind, changed, base):
    r = srv[note_id]
    if r["gone"] or base != r["ver"]:
        return False
    if kind == "delete":
        r["gone"] = True
    else:
        r["f"].update(changed)
    r["ver"] += 1
    return True

outbox = []
for op in sorted(s["ops"], key=lambda o: o["at"]):
    nid, kind, changed = op["note"], op["kind"], op["fields"]
    if op["device"] == "tablet":
        if mode == "version":
            versioned(nid, kind, changed, srv[nid]["ver"])
        else:
            stamped(nid, kind, changed, {**srv[nid]["f"], **changed}, op["at"])
    else:
        phone[nid].update(changed)
        outbox.append((nid, kind, changed, dict(phone[nid]), op["at"] + s["skew"]))

seen = {nid: 1 for nid in srv}
for nid, kind, changed, snap, ts in outbox:
    if mode != "version":
        stamped(nid, kind, changed, snap, ts)
        continue
    if not versioned(nid, kind, changed, seen[nid]):
        seen[nid] = srv[nid]["ver"]
        if not srv[nid]["gone"]:
            versioned(nid, kind, changed, seen[nid])
    seen[nid] = srv[nid]["ver"]

for n in s["notes"]:
    r = srv[n["id"]]
    tag = (" v%d" % r["ver"]) if mode == "version" else ""
    print(str(n["id"]) + tag + (" deleted" if r["gone"] else " " + r["f"]["title"] + " " + r["f"]["color"]))
`;

const TITLES = ['Покупки', 'Идеи', 'Отпуск', 'Книги', 'Рецепт', 'План', 'Встреча', 'Фильмы', 'Подарки', 'Ремонт'];
const COLORS = ['red', 'green', 'blue', 'yellow', 'gray', 'purple'];

function describeRules(s: Scenario): string[] {
	if (s.strategy === 'lww')
		return [
			'Сервер разрешает конфликты по правилу «последняя запись побеждает» по метке времени устройства: правка несёт заметку целиком (как она выглядит на устройстве после правки) и метку времени по часам устройства; сервер применяет её, только если метка позже метки последней применённой записи этой заметки, — тогда заметка заменяется целиком. Удаление применяется так же, по метке; после удаления остаётся надгробие с его меткой, и правка с более поздней меткой восстанавливает заметку в своём виде, а с более ранней — отбрасывается.'
		];
	if (s.strategy === 'merge')
		return [
			'Сервер сливает правки по полям: правка несёт только изменённые поля и метку времени по часам устройства; каждое поле хранит метку своей последней записи, и поле меняется, только если метка правки позже. Удаление применяется, если его метка позже меток всех полей; после него остаётся надгробие, и правка с более поздней меткой восстанавливает заметку: изменённые поля — из правки, остальные — как были до удаления.'
		];
	return [
		'Сервер ведёт версии заметок (оптимистическая блокировка): правка или удаление несёт версию, на которой устройство его сделало, и только изменённые поля; сервер применяет запись, только если версия совпадает с текущей, и увеличивает версию на 1. Иначе он отвечает 409: телефон заново получает заметку с сервера и, если она не удалена, сразу отправляет то же изменение поверх неё с новой версией; изменение удалённой заметки отбрасывается. Получив подтверждение, телефон запоминает новую версию и подставляет её в следующие операции очереди по этой заметке. Все заметки в начале — версии 1, планшет всегда онлайн и пишет с текущей версией.'
	];
}

function describeOp(op: Op, skew: number): string {
	const who = op.device === 'phone' ? 'телефон (без сети)' : 'планшет';
	const fields = Object.entries(op.fields)
		.map(([f, v]) => `${f === 'title' ? 'заголовок' : 'цвет'} на «${v}»`)
		.join(' и ');
	const what = op.kind === 'delete' ? `удаляет заметку ${op.note}` : `меняет ${fields} в заметке ${op.note}`;
	const stamp = op.device === 'phone' && skew !== 0 ? ` (на часах телефона ${hhmm(op.at + skew)})` : '';
	return `- ${hhmm(op.at)}${stamp} — ${who} ${what}`;
}

function describe(s: Scenario): string {
	const skew =
		s.skew === 0
			? 'Часы обоих устройств идут точно.'
			: `Часы телефона ${s.skew > 0 ? 'спешат' : 'отстают'} на ${Math.abs(s.skew)} мин; часы планшета точны.`;
	const answer =
		s.strategy === 'version'
			? 'По строке на каждую заметку в порядке номеров: номер, версия и заголовок с цветом через пробел (`2 v3 Идеи red`) или номер, версия и `deleted` для удалённой (`2 v3 deleted`).'
			: 'По строке на каждую заметку в порядке номеров: номер, заголовок и цвет через пробел (`2 Идеи red`) или номер и `deleted` для удалённой (`2 deleted`).';
	return [
		'Приложение заметок работает без сети: правки телефона копятся в очереди и уходят на сервер, когда появится сеть, — по одной, в порядке очереди. Планшет всегда онлайн, его правки сразу попадают на сервер. Модель синхронизации, не конкретная библиотека.',
		'',
		...describeRules(s),
		'',
		`В 09:00 оба устройства синхронизированы, все записи заметок до этого момента — раньше 09:00: ${s.notes.map((n) => `заметка ${n.id} — «${n.title}», ${n.color}`).join('; ')}. ${skew}`,
		'',
		...[...s.ops].sort((a, b) => a.at - b.at).map((op) => describeOp(op, s.skew)),
		`- ${hhmm(s.syncAt)} — у телефона появляется сеть, очередь уходит на сервер.`,
		'',
		`Какими будут заметки на сервере после синхронизации? ${answer}`
	].join('\n');
}

function scenario(rng: Rng, key: string): Scenario {
	const titles = rng.sample(TITLES, 6);
	// Three notes for tombstones: the untouched-by-conflict third one keeps the answers of the class apart.
	const count = key === 'senior/tombstone-version' ? 3 : rng.int(2, 3);
	const notes = Array.from({ length: count }, (_, i) => ({
		id: i + 1,
		title: titles[i] ?? 'План',
		color: rng.pick(COLORS)
	}));
	const pool = titles.slice(3);
	// Every edit sets values the note has not had yet: an edit never hides behind an equal value.
	const used = new Map(notes.map((n) => [n.id, { title: new Set([n.title]), color: new Set([n.color]) }]));
	const change = (fields: readonly Field[], id: number): Fields => {
		const seen = used.get(id);
		if (!seen) throw new Error(`no note ${id}`);
		const out: Fields = {};
		for (const f of fields) {
			const fresh = (f === 'title' ? pool : COLORS).filter((v) => !seen[f].has(v));
			const value = rng.pick(fresh);
			seen[f].add(value);
			out[f] = value;
		}
		return out;
	};
	const moments = rng.sample(
		Array.from({ length: 50 }, (_, i) => i + 1),
		7
	);
	moments.sort((a, b) => a - b);
	const m = (i: number): number => moments[i] ?? i + 1;
	const ids = rng.shuffle(notes.map((n) => n.id));
	const a = ids[0] ?? 1;
	const b = ids[1] ?? 2;
	const one = (): Field[] => [rng.pick(FIELDS)];
	const syncAt = 55 + rng.int(0, 30);
	const ops: Op[] = [];
	const edit = (at: number, device: Op['device'], note: number, fields: Fields): void => {
		ops.push({ at, device, note, kind: 'edit', fields });
	};
	const del = (at: number, device: Op['device'], note: number): void => {
		ops.push({ at, device, note, kind: 'delete', fields: {} });
	};
	const order = <T>(x: T, y: T): [T, T] => (rng.bool() ? [x, y] : [y, x]);
	switch (key) {
		case 'middle/lww':
		case 'senior/clock-skew': {
			// Both devices edit note a, in either order; the phone also edits note b, which the tablet edits later.
			const [first, second] = order<Op['device']>('phone', 'tablet');
			edit(m(0), first, a, change(one(), a));
			edit(m(2), second, a, change(one(), a));
			edit(m(1), 'phone', b, change(FIELDS, b));
			if (rng.bool()) edit(m(3), 'tablet', b, change(one(), b));
			const skew = key === 'senior/clock-skew' ? rng.pick([-1, 1]) * rng.int(5, 20) : 0;
			return { strategy: 'lww', skew, notes, ops, syncAt };
		}
		case 'senior/merge-skew': {
			const [first, second] = order<Op['device']>('phone', 'tablet');
			edit(m(0), first, a, change(['title'], a));
			edit(m(2), second, a, change(FIELDS, a));
			edit(m(1), 'tablet', b, change(['color'], b));
			edit(m(3), 'phone', b, change(rng.bool() ? ['title'] : FIELDS, b));
			return { strategy: 'merge', skew: rng.pick([-1, 1]) * rng.int(5, 20), notes, ops, syncAt };
		}
		case 'middle/field-merge': {
			// The devices change different fields of a note and the same field of another one.
			const [f1, f2] = rng.shuffle(FIELDS) as [Field, Field];
			const [first, second] = order<Op['device']>('phone', 'tablet');
			edit(m(0), first, a, change([f1], a));
			edit(m(2), second, a, change([f2], a));
			const [p, q] = order<Op['device']>('phone', 'tablet');
			const f = rng.pick(FIELDS);
			edit(m(1), p, b, change([f], b));
			edit(m(3), q, b, change(rng.bool() ? [f] : FIELDS, b));
			return { strategy: 'merge', skew: 0, notes, ops, syncAt };
		}
		case 'middle/delete-update': {
			// One note: the tablet deletes it, the phone edits it, in either order; another: the phone deletes it, the
			// tablet edits it, in either order.
			const [x, y] = order<'del' | 'edit'>('del', 'edit');
			if (x === 'del') {
				del(m(0), 'tablet', a);
				edit(m(2), 'phone', a, change(one(), a));
			} else {
				edit(m(0), 'phone', a, change(one(), a));
				del(m(2), 'tablet', a);
			}
			if (y === 'del') {
				del(m(1), 'phone', b);
				edit(m(3), 'tablet', b, change(one(), b));
			} else {
				edit(m(1), 'tablet', b, change(one(), b));
				del(m(3), 'phone', b);
			}
			return { strategy: rng.pick(['lww', 'merge'] as const), skew: 0, notes, ops, syncAt };
		}
		case 'middle/version-retry': {
			// The tablet changes the other field of note a after the phone's offline edit; note b has no conflict.
			const [f1, f2] = rng.shuffle(FIELDS) as [Field, Field];
			edit(m(0), 'phone', a, change([f1], a));
			edit(m(2), 'tablet', a, change(rng.bool() ? [f2] : FIELDS, a));
			edit(m(1), 'phone', b, change(one(), b));
			return { strategy: 'version', skew: 0, notes, ops, syncAt };
		}
		case 'senior/queue-versions': {
			// The phone edits note a twice offline; the tablet edits a in between; note b gets a phone edit and maybe a
			// tablet one.
			const [f1, f2] = rng.shuffle(FIELDS) as [Field, Field];
			edit(m(0), 'phone', a, change([f1], a));
			edit(m(1), 'tablet', a, change([f2], a));
			edit(m(3), 'phone', a, change(rng.bool() ? [f2] : [f1], a));
			edit(m(2), 'phone', b, change(one(), b));
			if (rng.bool()) edit(m(4), 'tablet', b, change(one(), b));
			return { strategy: 'version', skew: 0, notes, ops, syncAt };
		}
		case 'senior/tombstone-version': {
			// The tablet deletes note a which the phone edits offline; the phone deletes note b which the tablet edits
			// (the phone may edit b before deleting it); a third note gets a plain phone edit.
			const steps: ((at: number) => void)[] = [
				(t) => {
					edit(t, 'phone', a, change(one(), a));
				},
				(t) => {
					edit(t, 'tablet', b, change(one(), b));
				},
				(t) => {
					del(t, 'tablet', a);
				}
			];
			if (rng.bool())
				steps.splice(rng.int(0, 2), 0, (t) => {
					edit(t, 'tablet', a, change(one(), a));
				});
			if (rng.bool())
				steps.push((t) => {
					edit(t, 'phone', b, change(one(), b));
				});
			steps.push((t) => {
				del(t, 'phone', b);
			});
			const third = ids[2];
			if (third !== undefined)
				steps.splice(rng.int(0, steps.length), 0, (t) => {
					edit(t, 'phone', third, change(rng.bool() ? FIELDS : one(), third));
				});
			steps.forEach((step, i) => {
				step(m(i));
			});
			return { strategy: 'version', skew: 0, notes, ops, syncAt };
		}
		default:
			throw new Error(`${descriptor.key}: no class ${key}`);
	}
}

function make(rng: Rng, key: string): ComputeItem | null {
	const s = scenario(rng, key);
	// Every stamp is distinct and after 09:00: no ties of last-write-wins to settle, no write older than the start.
	const stamps = s.ops.map((o) => (o.device === 'phone' ? o.at + s.skew : o.at));
	if (new Set(stamps).size !== stamps.length || stamps.some((t) => t <= 0)) return null;
	const answer = simulate(s, RIGHT);
	const wrong: Record<string, { kind: 'sequence'; value: string[] }> = {};
	for (const [id, rules] of Object.entries(WRONG))
		wrong[id] = { kind: 'sequence', value: simulate(s, { ...RIGHT, ...rules }) };
	return { markdown: describe(s), answer: { kind: 'sequence', value: answer }, wrong, stdin: JSON.stringify(s) };
}

export function build(input: GenerateInput): Built {
	const key = `${input.grade}/${input.classId}`;
	return buildCompute(descriptor, input, REQUIRED, PYTHON_REFERENCE, (rng) => make(rng, key));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
