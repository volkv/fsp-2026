// Decoding JSON into a DTO by the rules of kotlinx.serialization, stated in the statement: default values for absent
// keys, an explicit null against a default, `@SerialName` instead of the property name, unknown keys with and
// without `ignoreUnknownKeys`. The answer is the decoded note of every JSON object, or `error`.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildCompute, type ComputeItem, type Required } from '../../_lib/mob-data.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const REQUIRED: Required = {
	'intern/default-absent': ['absent-null'],
	'intern/serial-name': ['name-by-property'],
	'intern/null-vs-absent': ['null-uses-default'],
	'intern/ignore-unknown': ['unknown-ignored']
};

type Json = Record<string, string | number | boolean | null>;

interface Scenario {
	/** `ignoreUnknownKeys` of the `Json` instance. */
	ignoreUnknown: boolean;
	objects: Json[];
}

interface Rules {
	absentNull: boolean;
	nameByProperty: boolean;
	nullUsesDefault: boolean;
	unknownIgnored: boolean;
}

const RIGHT: Rules = { absentNull: false, nameByProperty: false, nullUsesDefault: false, unknownIgnored: false };

const WRONG: Record<string, Partial<Rules>> = {
	'absent-null': { absentNull: true },
	'name-by-property': { nameByProperty: true },
	'null-uses-default': { nullUsesDefault: true },
	'unknown-ignored': { unknownIgnored: true }
};

const DEFAULT_TITLE = 'Без названия';
const DEFAULT_COLOR = 'gray';
const KNOWN = ['id', 'note_title', 'pinned', 'color'];

/** One line per object: `id | title | pinned | color` (null as `null`), or `error`. */
function decode(s: Scenario, rules: Rules): string[] {
	return s.objects.map((o) => {
		const known = rules.nameByProperty ? [...KNOWN, 'title'] : KNOWN;
		if (!s.ignoreUnknown && !rules.unknownIgnored && Object.keys(o).some((k) => !known.includes(k))) return 'error';
		if (!('id' in o) || typeof o.id !== 'number') return 'error';
		const titleKey = rules.nameByProperty && 'title' in o ? 'title' : 'note_title';
		const field = (key: string, def: string | boolean): Json[string] => {
			if (!(key in o)) return rules.absentNull ? null : def;
			const v = o[key];
			if (v === null && rules.nullUsesDefault) return def;
			return v ?? null;
		};
		const title = field(titleKey, DEFAULT_TITLE);
		const pinned = field('pinned', false);
		const color = field('color', DEFAULT_COLOR);
		return [o.id, title, pinned, color].map((v) => (v === null ? 'null' : String(v))).join(' | ');
	});
}

const PYTHON_REFERENCE = String.raw`import json

s = json.loads(input())
schema = {"note_title": "Без названия", "pinned": False, "color": "gray"}
for text in s["objects"]:
    obj = json.loads(text)
    extra = set(obj) - {"id"} - set(schema)
    if (extra and not s["ignoreUnknown"]) or "id" not in obj:
        print("error")
        continue
    row = [obj["id"]] + [obj.get(k, d) for k, d in schema.items()]
    out = []
    for v in row:
        if v is None:
            out.append("null")
        elif isinstance(v, bool):
            out.append("true" if v else "false")
        else:
            out.append(str(v))
    print(" | ".join(out))
`;

const TITLES = ['Покупки', 'Идеи', 'Отпуск', 'Книги', 'Рецепт', 'План', 'Встреча', 'Фильмы', 'Подарки', 'Ремонт'];
const COLORS = ['red', 'green', 'blue', 'yellow', 'purple'];

function snippet(s: Scenario): string {
	return [
		'@Serializable',
		'data class NoteDto(',
		'    val id: Int,',
		`    @SerialName("note_title") val title: String = "${DEFAULT_TITLE}",`,
		'    val pinned: Boolean = false,',
		`    val color: String? = "${DEFAULT_COLOR}",`,
		')',
		'',
		s.ignoreUnknown ? 'val json = Json { ignoreUnknownKeys = true }' : 'val json = Json',
		'',
		'// для каждой строки ответа сервера:',
		'val note = json.decodeFromString<NoteDto>(line)'
	].join('\n');
}

function describe(s: Scenario): string {
	return [
		'Приложение разбирает ответ сервера в `NoteDto` библиотекой kotlinx.serialization. Правила разбора (модель в условии):',
		'',
		'- свойство читается из ключа, указанного в `@SerialName`, иначе — из ключа с именем свойства;',
		'- если ключа нет, свойство получает значение по умолчанию; если нет ключа свойства без значения по умолчанию — ошибка;',
		'- явный `null` в nullable-свойство записывается как `null`, значение по умолчанию при этом не подставляется;',
		'- ключ, которому не соответствует ни одно свойство, — ошибка, если не включён `ignoreUnknownKeys`; с ним такой ключ пропускается.',
		'',
		'Строки ответа сервера, по одному JSON-объекту:',
		'',
		'```',
		...s.objects.map((o) => JSON.stringify(o)),
		'```',
		'',
		'Введите по строке на каждый объект в том же порядке: `id | title | pinned | color` разобранного `NoteDto` (`null` — как `null`, логические — `true`/`false`), например `7 | Идеи | false | gray`, или `error`, если разбор бросает исключение.'
	].join('\n');
}

function scenario(rng: Rng, classId: string): Scenario {
	const ids = rng.sample(
		Array.from({ length: 90 }, (_, i) => i + 10),
		4
	);
	const titles = rng.sample(TITLES, 4);
	const objects: Json[] = [];
	const base = (i: number): Json => ({ id: ids[i] ?? i + 1 });
	const maybe = (o: Json, key: string, value: string | boolean, p = 0.5): void => {
		if (rng.bool(p)) o[key] = value;
	};
	for (let i = 0; i < 4; i += 1) {
		const o = base(i);
		const title = titles[i] ?? 'План';
		switch (classId) {
			case 'default-absent':
				// Keys come and go; values present are never the defaults.
				maybe(o, 'note_title', title);
				maybe(o, 'pinned', true);
				maybe(o, 'color', rng.pick(COLORS));
				break;
			case 'serial-name':
				if (rng.bool()) o.title = title;
				else o.note_title = title;
				maybe(o, 'pinned', rng.bool());
				break;
			case 'null-vs-absent': {
				o.note_title = title;
				const form = rng.int(0, 2);
				if (form === 0) o.color = null;
				else if (form === 1) o.color = rng.pick(COLORS);
				maybe(o, 'pinned', rng.bool());
				break;
			}
			default: {
				o.note_title = title;
				maybe(o, 'color', rng.pick(COLORS));
				if (rng.bool(0.4)) o[rng.pick(['updated_at', 'author', 'tags'])] = rng.pick(['2026-10-05', 'anna', 'work']);
				if (rng.bool(0.2)) delete o.id;
			}
		}
		// Keys in a shuffled order, as a server may send them.
		objects.push(Object.fromEntries(rng.shuffle(Object.entries(o))));
	}
	return { ignoreUnknown: classId === 'serial-name' || (classId !== 'ignore-unknown' && rng.bool()), objects };
}

function make(rng: Rng, classId: string): ComputeItem | null {
	const s = scenario(rng, classId);
	const answer = decode(s, RIGHT);
	if (answer.every((l) => l === 'error')) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => [
			id,
			{ kind: 'sequence' as const, value: decode(s, { ...RIGHT, ...change }) }
		])
	);
	return {
		markdown: describe(s),
		code: { language: 'kotlin', source: snippet(s) },
		answer: { kind: 'sequence', value: answer },
		wrong,
		stdin: JSON.stringify({ ignoreUnknown: s.ignoreUnknown, objects: s.objects.map((o) => JSON.stringify(o)) })
	};
}

export function build(input: GenerateInput): Built {
	return buildCompute(descriptor, input, REQUIRED, PYTHON_REFERENCE, (rng) => make(rng, input.classId));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
