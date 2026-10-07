// List updates on Android: what `ListAdapter` with `DiffUtil` removes, inserts and rebinds after `submitList`, which
// rows get a payload bind, and which rows of a `LazyColumn` compose again with and without `key`. Items are matched
// by `areItemsTheSame`, compared by `areContentsTheSame` (moved items are matched too), a list built from the same
// item objects hides in-place mutations from the diff, and a lazy list without keys matches rows by position.
// The answer is computed by the model below and proved by an independent Python program that applies the same edits.
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

interface Theme {
	type: string;
	title: string;
	count: string;
	hidden: string;
	titles: readonly string[];
	row: string;
	list: string;
	payload: string;
}

const THEMES: readonly Theme[] = [
	{
		type: 'Message',
		title: 'text',
		count: 'likes',
		hidden: 'editedAt',
		titles: ['Привет', 'Созвон в 10', 'Отчёт готов', 'Ок', 'Смотри макет', 'Спасибо', 'Где ключи?', 'Выехал'],
		row: 'MessageRow',
		list: 'messages',
		payload: 'LikesChanged'
	},
	{
		type: 'Product',
		title: 'name',
		count: 'price',
		hidden: 'syncedAt',
		titles: ['Чай', 'Сыр', 'Хлеб', 'Кофе', 'Мёд', 'Рис', 'Соль', 'Масло'],
		row: 'ProductRow',
		list: 'products',
		payload: 'PriceChanged'
	},
	{
		type: 'Task',
		title: 'title',
		count: 'priority',
		hidden: 'revision',
		titles: ['Сборка', 'Ревью', 'Релиз', 'Тесты', 'Дизайн', 'Логи', 'Миграция', 'Демо'],
		row: 'TaskRow',
		list: 'tasks',
		payload: 'PriorityChanged'
	},
	{
		type: 'Order',
		title: 'status',
		count: 'total',
		hidden: 'etag',
		titles: ['Новый', 'Собран', 'В пути', 'Доставлен', 'Отменён', 'Оплачен', 'Ожидает', 'Возврат'],
		row: 'OrderRow',
		list: 'orders',
		payload: 'TotalChanged'
	}
];

interface Item {
	id: number;
	title: string;
	count: number;
	hidden: number;
}
type Field = 'title' | 'count' | 'hidden';

type Op =
	| { op: 'remove'; id: number }
	| { op: 'insert'; at: number; item: Item }
	| { op: 'set'; id: number; field: Field; value: string | number; inPlace: boolean }
	| { op: 'move'; id: number; to: number };

type Mechanism = 'rv' | 'rv-payload' | 'lazy-nokey' | 'lazy-both';
type Comparator = 'equals' | 'title' | 'title-count';

interface Scenario {
	theme: Theme;
	mechanism: Mechanism;
	itemsByEquals: boolean;
	comparator: Comparator;
	inPlaceCode: boolean;
	old: Item[];
	ops: Op[];
}

interface Rules {
	rebindAll: boolean;
	visibleOnly: boolean;
	anyField: boolean;
	itemsById: boolean;
	lazyIdentity: boolean;
	positionRebound: boolean;
	payloadIgnored: boolean;
	inPlaceDetected: boolean;
}
const RIGHT: Rules = {
	rebindAll: false,
	visibleOnly: false,
	anyField: false,
	itemsById: false,
	lazyIdentity: false,
	positionRebound: false,
	payloadIgnored: false,
	inPlaceDetected: false
};

/** The new list as objects: in-place edits change the objects the old list holds as well. */
function apply(old: readonly Item[], ops: readonly Op[]): { oldNow: Item[]; next: Item[] } {
	const objects = old.map((i) => ({ ...i }));
	const next = [...objects];
	for (const o of ops) {
		const at = (id: number): number => next.findIndex((i) => i.id === id);
		if (o.op === 'remove') next.splice(at(o.id), 1);
		else if (o.op === 'insert') next.splice(o.at, 0, { ...o.item });
		else if (o.op === 'move') {
			const [item] = next.splice(at(o.id), 1);
			next.splice(o.to, 0, item as Item);
		} else {
			const i = at(o.id);
			const target = next[i] as Item;
			if (o.inPlace) (target as unknown as Record<Field, string | number>)[o.field] = o.value;
			else next[i] = { ...target, [o.field]: o.value };
		}
	}
	return { oldNow: objects, next };
}

const sameFields = (a: Item, b: Item, fields: readonly Field[]): boolean => fields.every((f) => a[f] === b[f]);
const ALL: readonly Field[] = ['title', 'count', 'hidden'];
const SHOWN: readonly Field[] = ['title', 'count'];

const ids = (items: readonly number[]): string =>
	items.length ? [...new Set(items)].sort((a, b) => a - b).join(' ') : '-';

function simulate(sc: Scenario, r: Rules): string {
	const { oldNow, next } = apply(sc.old, sc.ops);
	// What the diff compares as the old list: the objects it holds now, or (a misconception) the values shown before.
	const oldList = r.inPlaceDetected ? sc.old : oldNow;
	const compared: readonly Field[] = r.anyField
		? ALL
		: sc.comparator === 'title'
			? ['title']
			: sc.comparator === 'title-count'
				? SHOWN
				: r.visibleOnly
					? SHOWN
					: ALL;
	const rowEqual = (a: Item, b: Item): boolean => sameFields(a, b, r.visibleOnly ? SHOWN : ALL);

	if (sc.mechanism === 'lazy-nokey' || sc.mechanism === 'lazy-both') {
		const keyed = (): number[] => {
			const out: number[] = [];
			next.forEach((item, i) => {
				const before = oldList.findIndex((o) => o.id === item.id);
				const prev = oldList[before];
				if (!prev || r.rebindAll || !rowEqual(prev, item) || (r.positionRebound && before !== i)) out.push(item.id);
			});
			return out;
		};
		const positional = (): number[] => {
			if (r.lazyIdentity) return keyed();
			const out: number[] = [];
			next.forEach((item, i) => {
				const prev = oldList[i];
				if (!prev || r.rebindAll || !rowEqual(prev, item)) out.push(item.id);
			});
			return out;
		};
		return sc.mechanism === 'lazy-nokey' ? ids(positional()) : `${ids(positional())} | ${ids(keyed())}`;
	}

	const sameItem = (a: Item, b: Item): boolean =>
		sc.itemsByEquals && !r.itemsById ? sameFields(a, b, ALL) : a.id === b.id;
	const matchedNew = new Set<number>();
	const removed: number[] = [];
	const changed: { item: Item; prev: Item }[] = [];
	oldList.forEach((o, oi) => {
		const ni = next.findIndex((n, k) => !matchedNew.has(k) && sameItem(o, n));
		if (ni < 0) {
			removed.push(o.id);
			return;
		}
		matchedNew.add(ni);
		const n = next[ni] as Item;
		if (r.rebindAll || !sameFields(o, n, compared) || (r.positionRebound && oi !== ni))
			changed.push({ item: n, prev: o });
	});
	const inserted = next.filter((_, k) => !matchedNew.has(k)).map((i) => i.id);
	if (sc.mechanism === 'rv') return `${ids(removed)} | ${ids(inserted)} | ${ids(changed.map((c) => c.item.id))}`;
	const partial = changed.filter(
		(c) => !r.payloadIgnored && sameFields(c.prev, c.item, ['title', 'hidden']) && c.prev.count !== c.item.count
	);
	const full = [...inserted, ...changed.filter((c) => !partial.includes(c)).map((c) => c.item.id)];
	return `${ids(full)} | ${ids(partial.map((c) => c.item.id))}`;
}

// Scenarios.

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const theme = rng.pick(THEMES);
	const n = grade === 'middle' ? rng.int(5, 6) : rng.int(4, 6);
	const idPool = rng.sample(
		Array.from({ length: 40 }, (_, i) => i + 10),
		n + 2
	);
	const titles = rng.shuffle(theme.titles);
	const old: Item[] = Array.from({ length: n }, (_, i) => ({
		id: idPool[i] as number,
		title: titles[i] as string,
		count: rng.int(1, 9),
		hidden: rng.int(1, 5) * 100
	}));
	const freshTitle = (k: number): string => titles[n + k] ?? `${theme.titles[0] ?? ''} ${k}`;
	const fresh = (k: number): Item => ({
		id: idPool[n + k] as number,
		title: freshTitle(k),
		count: rng.int(1, 9),
		hidden: rng.int(1, 5) * 100
	});
	const ops: Op[] = [];
	const pickIds = rng.shuffle(old.map((i) => i.id));
	const take = (): number => {
		const id = pickIds.pop();
		if (id === undefined) throw new Error('every item of the list is already edited');
		return id;
	};
	const edit = (field: Field, inPlace = false): void => {
		const id = take();
		const item = old.find((i) => i.id === id) as Item;
		const value =
			field === 'title'
				? freshTitle(1 + ops.length)
				: field === 'count'
					? item.count + rng.int(1, 4)
					: item.hidden + 100;
		ops.push({ op: 'set', id, field, value, inPlace });
	};
	const base: Omit<Scenario, 'mechanism' | 'old' | 'ops'> = {
		theme,
		itemsByEquals: false,
		comparator: 'equals',
		inPlaceCode: false
	};
	const key = `${grade}/${classId}`;
	let mechanism: Mechanism = 'rv';
	let extra: Partial<Scenario> = {};
	const insertSomewhere = (k: number, front = false): void => {
		ops.push({ op: 'insert', at: front ? 0 : rng.int(0, n - 1), item: fresh(k) });
	};

	if (key === 'junior/contents-equals') {
		edit('hidden');
		edit(rng.pick(['title', 'count']));
		if (rng.bool()) ops.push({ op: 'remove', id: take() });
		insertSomewhere(0);
	} else if (key === 'junior/contents-by-field') {
		extra = { comparator: rng.pick(['title', 'title-count']) };
		edit('title');
		edit(extra.comparator === 'title' ? rng.pick(['count', 'hidden']) : 'hidden');
		if (rng.bool()) edit('hidden');
		if (rng.bool()) ops.push({ op: 'remove', id: take() });
		if (rng.bool()) insertSomewhere(0);
	} else if (key === 'junior/items-by-equals') {
		extra = { itemsByEquals: true };
		edit(rng.pick(['title', 'count']));
		if (rng.bool()) edit('hidden');
		ops.push({ op: 'remove', id: take() });
		if (rng.bool()) insertSomewhere(0);
	} else if (key === 'junior/lazy-nokey') {
		mechanism = 'lazy-nokey';
		insertSomewhere(0, rng.bool(0.6));
		if (rng.bool()) edit(rng.pick(['title', 'count', 'hidden']));
		if (rng.bool()) ops.push({ op: 'remove', id: take() });
	} else if (key === 'middle/lazy-moves') {
		mechanism = 'lazy-both';
		ops.push({ op: 'move', id: take(), to: rng.int(0, n - 1) });
		edit(rng.pick(['title', 'count', 'hidden']));
		if (rng.bool()) ops.push({ op: 'move', id: take(), to: rng.int(0, n - 1) });
		if (rng.bool()) insertSomewhere(0, rng.bool());
		else ops.push({ op: 'remove', id: take() });
	} else if (key === 'middle/payload') {
		mechanism = 'rv-payload';
		edit('count');
		edit(rng.pick(['title', 'hidden']));
		if (rng.bool()) edit('count');
		if (rng.bool()) ops.push({ op: 'move', id: take(), to: rng.int(0, n - 1) });
		insertSomewhere(0);
		if (rng.bool()) ops.push({ op: 'remove', id: take() });
	} else if (key === 'middle/mutated-in-place') {
		extra = { inPlaceCode: true };
		edit('count', true);
		edit(rng.pick(['title', 'count']), false);
		if (rng.bool()) edit('count', rng.bool());
		ops.push({ op: 'remove', id: take() });
		if (rng.bool()) insertSomewhere(0, true);
		// The edits on the shown code run in this order; removal and insertion go last so indexes stay simple.
		ops.sort((a, b) => order(a) - order(b));
	} else {
		// middle/moves
		ops.push({ op: 'move', id: take(), to: rng.int(0, n - 1) });
		ops.push({ op: 'move', id: take(), to: rng.int(0, n - 1) });
		edit(rng.pick(['title', 'count', 'hidden']));
		if (rng.bool()) ops.push({ op: 'remove', id: take() });
		if (rng.bool()) insertSomewhere(0);
	}
	return { ...base, ...extra, mechanism, old, ops };
}

const order = (o: Op): number => (o.op === 'set' ? 0 : o.op === 'remove' ? 1 : 2);

// Rendering.

const lit = (t: Theme, i: Item): string => `${t.type}(${i.id}, ${JSON.stringify(i.title)}, ${i.count}, ${i.hidden})`;
const listLit = (t: Theme, items: readonly Item[], indent: string): string[] => [
	`listOf(`,
	...items.map((i, k) => `${indent}    ${lit(t, i)}${k < items.length - 1 ? ',' : ''}`),
	`${indent})`
];

function dataClass(sc: Scenario): string {
	const t = sc.theme;
	const countDecl = sc.inPlaceCode ? 'var' : 'val';
	return `data class ${t.type}(val id: Long, val ${t.title}: String, ${countDecl} ${t.count}: Int, val ${t.hidden}: Long)`;
}

function callbackCode(sc: Scenario): string[] {
	const t = sc.theme;
	const same = sc.itemsByEquals ? 'oldItem == newItem' : 'oldItem.id == newItem.id';
	const contents =
		sc.comparator === 'equals'
			? 'oldItem == newItem'
			: sc.comparator === 'title'
				? `oldItem.${t.title} == newItem.${t.title}`
				: `oldItem.${t.title} == newItem.${t.title} && oldItem.${t.count} == newItem.${t.count}`;
	const lines = [
		`object ${t.type}Diff : DiffUtil.ItemCallback<${t.type}>() {`,
		`    override fun areItemsTheSame(oldItem: ${t.type}, newItem: ${t.type}) = ${same}`,
		`    override fun areContentsTheSame(oldItem: ${t.type}, newItem: ${t.type}) = ${contents}`
	];
	if (sc.mechanism === 'rv-payload') {
		lines.push(
			`    override fun getChangePayload(oldItem: ${t.type}, newItem: ${t.type}): Any? =`,
			`        if (oldItem.copy(${t.count} = newItem.${t.count}) == newItem) ${t.payload} else null`
		);
	}
	lines.push('}', '');
	lines.push(`class ${t.type}Adapter : ListAdapter<${t.type}, ${t.type}Holder>(${t.type}Diff) {`);
	lines.push(`    override fun onBindViewHolder(holder: ${t.type}Holder, position: Int) {`);
	lines.push(`        holder.bind(getItem(position)) // показывает ${t.title} и ${t.count}`);
	lines.push('    }');
	if (sc.mechanism === 'rv-payload') {
		lines.push(
			`    override fun onBindViewHolder(holder: ${t.type}Holder, position: Int, payloads: List<Any>) {`,
			`        if (payloads.isEmpty()) onBindViewHolder(holder, position)`,
			`        else holder.bind${t.count.charAt(0).toUpperCase()}${t.count.slice(1)}(getItem(position).${t.count})`,
			'    }'
		);
	}
	lines.push('    // onCreateViewHolder опущен', '}');
	return lines;
}

function opCode(sc: Scenario, o: Op): string {
	const t = sc.theme;
	if (o.op === 'remove') return `list.removeAll { it.id == ${o.id}L }`;
	if (o.op === 'insert') return `list.add(${o.at}, ${lit(t, o.item)})`;
	if (o.op === 'move') throw new Error('no moves in the in-place scenario');
	const name = o.field === 'title' ? t.title : o.field === 'count' ? t.count : t.hidden;
	const value = typeof o.value === 'string' ? JSON.stringify(o.value) : String(o.value);
	if (o.inPlace) return `list.first { it.id == ${o.id}L }.${name} = ${value}`;
	return `list.replaceAll { if (it.id == ${o.id}L) it.copy(${name} = ${value}) else it }`;
}

function render(sc: Scenario): string {
	const t = sc.theme;
	const { next } = apply(sc.old, sc.ops);
	const lines = [dataClass(sc), ''];
	if (sc.mechanism === 'lazy-nokey' || sc.mechanism === 'lazy-both') {
		const items = (keyed: boolean): string =>
			`items(${t.list}${keyed ? ', key = { it.id }' : ''}) { ${t.type.toLowerCase()} -> ${t.row}(${t.type.toLowerCase()}) }`;
		lines.push(
			'@Composable',
			`fun ${t.type}List(${t.list}: List<${t.type}>) {`,
			'    LazyColumn {',
			`        ${items(false)}`,
			'    }',
			'}'
		);
		if (sc.mechanism === 'lazy-both') {
			lines.push(
				'',
				'@Composable',
				`fun Keyed${t.type}List(${t.list}: List<${t.type}>) {`,
				'    LazyColumn {',
				`        ${items(true)}`,
				'    }',
				'}'
			);
		}
		lines.push(
			'',
			'@Composable',
			`fun ${t.row}(${t.type.toLowerCase()}: ${t.type}) {`,
			`    Text("\${${t.type.toLowerCase()}.${t.title}}: \${${t.type.toLowerCase()}.${t.count}}")`,
			'}',
			'',
			`val before = ${listLit(t, sc.old, '').join('\n')}`,
			`val after = ${listLit(t, next, '').join('\n')}`
		);
		return lines.join('\n');
	}
	lines.push(...callbackCode(sc), '');
	if (sc.inPlaceCode) {
		lines.push(
			`adapter.submitList(${listLit(t, sc.old, '').join('\n')})`,
			'// … список показан на экране, затем:',
			'val list = adapter.currentList.toMutableList()',
			...sc.ops.map((o) => opCode(sc, o)),
			'adapter.submitList(list)'
		);
	} else {
		lines.push(
			`adapter.submitList(${listLit(t, sc.old, '').join('\n')})`,
			'// … список показан на экране, затем:',
			`adapter.submitList(${listLit(t, next, '').join('\n')})`
		);
	}
	return lines.join('\n');
}

function describe(sc: Scenario): string {
	const t = sc.theme;
	const lazy = sc.mechanism === 'lazy-nokey' || sc.mechanism === 'lazy-both';
	const head = lazy
		? [
				`Список на Jetpack Compose (код ниже) показан со списком \`before\`, затем тот же экран получает \`after\` и проходит перекомпоновку.`,
				'',
				'Ответ — по модели Compose, а не по запуску на устройстве. Условия модели: все строки помещаются на экране;',
				`\`${t.row}\` пропускается, если её параметр равен прежнему по \`equals\` (\`${t.type}\` — data class со стабильными полями); строка, которой раньше не было, компонуется впервые — это тоже выполнение.`,
				''
			]
		: [
				`\`RecyclerView\` с адаптером ниже показывает первый список; затем вызывается второй \`submitList\`.`,
				'',
				'Ответ — по модели RecyclerView и DiffUtil, а не по запуску на устройстве. Условия модели: все строки помещаются на экране;',
				'аниматор по умолчанию (`DefaultItemAnimator`); `DiffUtil` ищет и перемещения (`detectMoves = true`, как в `ListAdapter`).',
				''
			];
	let ask: string[];
	if (sc.mechanism === 'lazy-nokey') {
		ask = [
			`Для каких элементов \`after\` функция \`${t.row}\` выполнится?`,
			'Введите их id через пробел по возрастанию; если ни для одного — `-`.'
		];
	} else if (sc.mechanism === 'lazy-both') {
		ask = [
			`Для каких элементов \`after\` функция \`${t.row}\` выполнится в \`${t.type}List\` (без \`key\`) и в \`Keyed${t.type}List\` (с \`key\`), если каждый из списков прошёл тот же путь от \`before\` к \`after\`?`,
			'Введите две группы через ` | `: сначала без `key`, затем с `key`; в группе — id через пробел по возрастанию, пустая группа — `-`. Например: `12 15 | 15`.'
		];
	} else if (sc.mechanism === 'rv') {
		ask = [
			'Какие элементы `DiffUtil` сочтёт удалёнными, какие вставленными и какие изменёнными (строка получит `onChanged` и будет перепривязана)?',
			'Введите три группы через ` | `: удалённые, вставленные, изменённые; в группе — id через пробел по возрастанию, пустая группа — `-`. Например: `14 | 31 | -`.'
		];
	} else {
		ask = [
			'Для каких элементов будет вызвана полная привязка (`onBindViewHolder` с пустым `payloads`, включая новые строки) и для каких — частичная (с непустым `payloads`)?',
			'Введите две группы через ` | `: полная, частичная; в группе — id через пробел по возрастанию, пустая группа — `-`. Например: `31 | 14`.'
		];
	}
	return [...head, ...ask].join('\n');
}

const PYTHON_REFERENCE = `import json

sc = json.loads(input())


class Row:
    def __init__(self, d):
        self.id, self.title, self.count, self.hidden = d["id"], d["title"], d["count"], d["hidden"]

    def key(self):
        return (self.id, self.title, self.count, self.hidden)


shown = [Row(d) for d in sc["old"]]
current = list(shown)  # the same objects, as adapter.currentList.toMutableList()
for o in sc["ops"]:
    pos = {r.id: k for k, r in enumerate(current)}
    if o["op"] == "remove":
        del current[pos[o["id"]]]
    elif o["op"] == "insert":
        current.insert(o["at"], Row(o["item"]))
    elif o["op"] == "move":
        r = current.pop(pos[o["id"]])
        current.insert(o["to"], r)
    else:
        r = current[pos[o["id"]]]
        if not o["inPlace"]:
            r = Row({"id": r.id, "title": r.title, "count": r.count, "hidden": r.hidden})
            current[pos[o["id"]]] = r
        setattr(r, o["field"], o["value"])

mech = sc["mechanism"]


def fmt(xs):
    xs = sorted(set(xs))
    return " ".join(str(x) for x in xs) if xs else "-"


if mech.startswith("lazy"):
    by_position = [r.id for k, r in enumerate(current) if k >= len(shown) or shown[k].key() != r.key()]
    before = {r.id: r.key() for r in shown}
    by_key = [r.id for r in current if before.get(r.id) != r.key()]
    print(fmt(by_position) if mech == "lazy-nokey" else fmt(by_position) + " | " + fmt(by_key))
else:
    fields = {"equals": ("title", "count", "hidden"), "title": ("title",), "title-count": ("title", "count")}[sc["comparator"]]

    def same_item(a, b):
        return a.key() == b.key() if sc["itemsByEquals"] else a.id == b.id

    def same_contents(a, b):
        return all(getattr(a, f) == getattr(b, f) for f in fields)

    pairs = []
    free = list(range(len(current)))
    removed = []
    for a in shown:
        hit = next((k for k in free if same_item(a, current[k])), None)
        if hit is None:
            removed.append(a.id)
        else:
            free.remove(hit)
            pairs.append((a, current[hit]))
    inserted = [current[k].id for k in free]
    changed = [(a, b) for a, b in pairs if not same_contents(a, b)]
    if mech == "rv":
        print(fmt(removed) + " | " + fmt(inserted) + " | " + fmt([b.id for a, b in changed]))
    else:
        partial = [b.id for a, b in changed if (a.title, a.hidden) == (b.title, b.hidden) and a.count != b.count]
        full = inserted + [b.id for a, b in changed if b.id not in partial]
        print(fmt(full) + " | " + fmt(partial))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'rebind-all': { rebindAll: true },
	'visible-only': { visibleOnly: true },
	'any-field': { anyField: true },
	'items-by-id-anyway': { itemsById: true },
	'lazy-by-identity': { lazyIdentity: true },
	'position-rebound': { positionRebound: true },
	'payload-ignored': { payloadIgnored: true },
	'in-place-detected': { inPlaceDetected: true }
};

const REQUIRED: Record<string, string[]> = {
	'junior/contents-equals': ['visible-only', 'rebind-all'],
	'junior/contents-by-field': ['any-field'],
	'junior/items-by-equals': ['items-by-id-anyway'],
	'junior/lazy-nokey': ['lazy-by-identity'],
	'middle/lazy-moves': ['lazy-by-identity', 'position-rebound'],
	'middle/payload': ['payload-ignored'],
	'middle/mutated-in-place': ['in-place-detected'],
	'middle/moves': ['position-rebound']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 200; tries += 1) {
		const sc = scenario(rng, input.grade, input.classId);
		const answer = simulate(sc, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(sc, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if ((REQUIRED[`${input.grade}/${input.classId}`] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(sc), code: { language: 'kotlin', source: render(sc) } },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({
			mechanism: sc.mechanism,
			comparator: sc.comparator,
			itemsByEquals: sc.itemsByEquals,
			old: sc.old,
			ops: sc.ops
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
