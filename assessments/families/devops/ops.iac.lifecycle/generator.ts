// What a plan shows under `lifecycle` rules: `ignore_changes` hides differences of the listed attributes,
// `create_before_destroy` turns a replacement around, `replace_triggered_by` replaces a resource when the referenced one
// changes, and `prevent_destroy` fails the plan when a protected resource would be destroyed or replaced — but only
// while its block is in the description. `moved` keeps the object under a new address.
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

type Lit = string | number;

interface Lifecycle {
	prevent: boolean;
	cbd: boolean;
	ignore: string[];
	trigger: string | null;
}

interface Resource {
	type: string;
	name: string;
	attrs: Record<string, Lit>;
	lc: Lifecycle;
}

interface StateObject {
	address: string;
	id: string;
	attrs: Record<string, Lit>;
}

interface Params {
	config: Resource[];
	moved: { from: string; to: string }[];
	state: StateObject[];
	/** State objects whose resource block (with `prevent_destroy`) was removed from the description. */
	removedProtected: string[];
}

interface Rules {
	ignoreChangesIgnored: boolean;
	ignoreAll: boolean;
	preventAllowsReplace: boolean;
	removedStillProtected: boolean;
	triggerOnlyOnReplace: boolean;
	cbdIgnored: boolean;
	movedIgnored: boolean;
}

const RIGHT: Rules = {
	ignoreChangesIgnored: false,
	ignoreAll: false,
	preventAllowsReplace: false,
	removedStillProtected: false,
	triggerOnlyOnReplace: false,
	cbdIgnored: false,
	movedIgnored: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'ignore-changes-ignored': { ignoreChangesIgnored: true },
	'ignore-all': { ignoreAll: true },
	'prevent-allows-replace': { preventAllowsReplace: true },
	'removed-still-protected': { removedStillProtected: true },
	'trigger-only-on-replace': { triggerOnlyOnReplace: true },
	'cbd-ignored': { cbdIgnored: true },
	'moved-ignored': { movedIgnored: true }
};

const TYPES: Record<string, { attrs: string[]; forceNew: string[] }> = {
	cloud_bucket: { attrs: ['name', 'versioning'], forceNew: ['name'] },
	cloud_disk: { attrs: ['zone', 'type', 'size'], forceNew: ['zone', 'type'] },
	cloud_instance: { attrs: ['image', 'size', 'name'], forceNew: ['image'] },
	cloud_dns_record: { attrs: ['name', 'value', 'ttl'], forceNew: ['name'] },
	cloud_database: { attrs: ['engine', 'version', 'storage'], forceNew: ['engine'] },
	cloud_queue: { attrs: ['name', 'retention'], forceNew: ['name'] }
};

const addressOf = (r: Resource): string => `${r.type}.${r.name}`;

function plan(p: Params, rules: Rules): string[] {
	const state = new Map(p.state.map((s) => [s.address, s]));
	const configAddresses = new Set(p.config.map(addressOf));
	const moved = rules.movedIgnored ? [] : p.moved;
	const owner = new Map<string, StateObject>();
	const used = new Set<string>();
	for (const r of p.config) {
		const address = addressOf(r);
		const direct = state.get(address);
		const move = moved.find((m) => m.to === address && state.has(m.from) && !configAddresses.has(m.from));
		const old = direct ?? (move ? state.get(move.from) : undefined);
		if (!old) continue;
		owner.set(address, old);
		used.add(old.address);
	}
	const base = new Map<string, string>();
	for (const r of p.config) {
		const address = addressOf(r);
		const old = owner.get(address);
		if (!old) {
			base.set(address, 'create');
			continue;
		}
		const spec = TYPES[r.type] ?? { attrs: [], forceNew: [] };
		const ignored = rules.ignoreChangesIgnored ? [] : r.lc.ignore;
		let diff = spec.attrs.filter((k) => r.attrs[k] !== old.attrs[k] && !ignored.includes(k));
		if (rules.ignoreAll && r.lc.ignore.length) diff = [];
		const replace = r.lc.cbd && !rules.cbdIgnored ? 'replace-cbd' : 'replace';
		base.set(address, diff.some((k) => spec.forceNew.includes(k)) ? replace : diff.length ? 'update' : 'none');
	}
	const action = new Map(base);
	for (const r of p.config) {
		if (!r.lc.trigger) continue;
		const t = base.get(r.lc.trigger) ?? 'none';
		const fires = rules.triggerOnlyOnReplace ? t.startsWith('replace') : t === 'update' || t.startsWith('replace');
		const address = addressOf(r);
		if (fires && base.get(address) !== 'create')
			action.set(address, r.lc.cbd && !rules.cbdIgnored ? 'replace-cbd' : 'replace');
	}
	const destroyed = p.state.filter((s) => !used.has(s.address)).map((s) => s.address);
	const errors: string[] = [];
	for (const r of p.config) {
		if (!r.lc.prevent) continue;
		const a = action.get(addressOf(r)) ?? 'none';
		if (a.startsWith('replace') && !rules.preventAllowsReplace) errors.push(`error ${addressOf(r)}`);
		if (rules.movedIgnored) {
			const m = p.moved.find((x) => x.to === addressOf(r));
			if (m && destroyed.includes(m.from)) errors.push(`error ${m.from}`);
		}
	}
	if (rules.removedStillProtected)
		for (const a of p.removedProtected) if (destroyed.includes(a)) errors.push(`error ${a}`);
	if (errors.length) return [...new Set(errors)].sort();
	const out = [
		...[...action].filter(([, a]) => a !== 'none').map(([address, a]) => `${address} ${a}`),
		...destroyed.map((a) => `${a} destroy`)
	];
	return out.length ? out.sort() : ['-'];
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const hex = (rng: Rng): string => rng.int(0x1000, 0xffff).toString(16);

const NAMES: Record<string, string[]> = {
	cloud_bucket: ['assets', 'backups', 'logs', 'media'],
	cloud_disk: ['data', 'scratch', 'archive'],
	cloud_instance: ['api', 'worker', 'bastion', 'runner'],
	cloud_dns_record: ['www', 'api', 'status'],
	cloud_database: ['main', 'orders', 'billing'],
	cloud_queue: ['events', 'jobs', 'emails']
};

function freshAttrs(rng: Rng, type: string, name: string): Record<string, Lit> {
	switch (type) {
		case 'cloud_bucket':
			return { name: `${name}-${hex(rng)}`, versioning: rng.pick(['enabled', 'suspended']) };
		case 'cloud_disk':
			return { zone: rng.pick(['ru-a', 'ru-b', 'ru-c']), type: rng.pick(['ssd', 'hdd']), size: 10 * rng.int(2, 30) };
		case 'cloud_instance':
			return {
				image: rng.pick(['debian-12', 'ubuntu-22.04', 'ubuntu-24.04']),
				size: rng.pick(['s2.small', 's2.medium', 's3.large']),
				name: `${name}-1`
			};
		case 'cloud_dns_record':
			return {
				name: `${name}.example.ru`,
				value: `10.0.${rng.int(1, 9)}.${rng.int(10, 250)}`,
				ttl: rng.pick([60, 300, 600])
			};
		case 'cloud_database':
			return { engine: rng.pick(['postgres', 'mysql']), version: rng.pick(['15', '16']), storage: 10 * rng.int(5, 50) };
		default:
			return { name: `${name}-${hex(rng)}`, retention: rng.pick([1, 3, 7, 14]) };
	}
}

/** A different value of one attribute. */
function changed(rng: Rng, k: string, old: Lit): Lit {
	if (typeof old === 'number') return old + (k === 'ttl' ? 60 : k === 'retention' ? 1 : 10) * rng.int(1, 4);
	const options: Record<string, string[]> = {
		versioning: ['enabled', 'suspended'],
		zone: ['ru-a', 'ru-b', 'ru-c'],
		type: ['ssd', 'hdd'],
		image: ['debian-12', 'ubuntu-22.04', 'ubuntu-24.04'],
		size: ['s2.small', 's2.medium', 's3.large'],
		engine: ['postgres', 'mysql'],
		version: ['15', '16', '17']
	};
	const list = (options[k] ?? []).filter((x) => x !== old);
	if (list.length) return rng.pick(list);
	if (k === 'value') return `10.0.${rng.int(1, 9)}.${rng.int(10, 250)}`;
	const text = old;
	if (text.endsWith('.example.ru')) return text.replace('.example.ru', `-${rng.pick(['new', 'v2', 'eu'])}.example.ru`);
	const numbered = /^(.*)-(\d+)$/.exec(text);
	if (numbered) return `${numbered[1] ?? ''}-${Number(numbered[2]) + rng.int(1, 3)}`;
	return `${text.replace(/-[0-9a-f]{4}$/, '')}-${hex(rng)}`;
}

const noLc = (): Lifecycle => ({ prevent: false, cbd: false, ignore: [], trigger: null });

function change(rng: Rng, r: Resource, forceNew: boolean): string | null {
	const spec = TYPES[r.type];
	if (!spec) return null;
	const keys = spec.attrs.filter((k) => spec.forceNew.includes(k) === forceNew);
	if (!keys.length) return null;
	const k = rng.pick(keys);
	r.attrs[k] = changed(rng, k, r.attrs[k] ?? '');
	return k;
}

function scenario(rng: Rng, classId: string): Params {
	const types = rng.sample(Object.keys(TYPES), rng.int(5, 6));
	const config: Resource[] = types.map((type) => {
		const name = rng.pick(NAMES[type] ?? ['main']);
		return { type, name, attrs: freshAttrs(rng, type, name), lc: noLc() };
	});
	const state: StateObject[] = config.map((r) => ({
		address: addressOf(r),
		id: `${r.type.replace('cloud_', '').slice(0, 3)}-${hex(rng)}`,
		attrs: { ...r.attrs }
	}));
	const moved: { from: string; to: string }[] = [];
	const removedProtected: string[] = [];
	const [r1, r2, r3, r4] = rng.shuffle(config) as [Resource, Resource, Resource, Resource];
	if (classId === 'ignore-changes') {
		const hidden = change(rng, r1, true);
		const visible = change(rng, r1, false);
		r1.lc.ignore = hidden !== null && visible !== null ? [hidden] : [];
		change(rng, r2, rng.bool());
		r2.lc.cbd = rng.bool(0.5);
		if (rng.bool(0.5)) {
			const k = change(rng, r3, false);
			if (k) r3.lc.ignore = [k];
		}
	}
	if (classId === 'prevent-destroy') {
		r1.lc.prevent = true;
		change(rng, r1, rng.bool(0.4));
		// r2's block (with prevent_destroy) is removed from the description.
		removedProtected.push(addressOf(r2));
		config.splice(config.indexOf(r2), 1);
		change(rng, r3, rng.bool());
		r4.lc.prevent = rng.bool(0.5);
	}
	if (classId === 'replace-triggered') {
		change(rng, r1, false);
		r2.lc.trigger = addressOf(r1);
		r2.lc.cbd = true;
		change(rng, r3, rng.bool());
		if (rng.bool(0.5)) r3.lc.cbd = true;
	}
	if (classId === 'combo') {
		r1.lc.prevent = true;
		const from = addressOf(r1);
		r1.name = `${r1.name}_${rng.pick(['main', 'primary', 'v2'])}`;
		moved.push({ from, to: addressOf(r1) });
		if (rng.bool(0.5)) change(rng, r1, false);
		const hidden = change(rng, r2, false);
		change(rng, r2, true);
		r2.lc.ignore = hidden ? [hidden] : [];
		r2.lc.cbd = true;
		if (rng.bool(0.5)) change(rng, r3, false);
	}
	return { config, moved, state, removedProtected };
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const literal = (v: Lit): string => (typeof v === 'number' ? String(v) : `"${v}"`);

function hcl(p: Params): string {
	const blocks = p.config.map((r) => {
		const keys = TYPES[r.type]?.attrs ?? [];
		const width = Math.max(...keys.map((k) => k.length));
		const lines = keys.map((k) => `  ${k.padEnd(width)} = ${literal(r.attrs[k] ?? '')}`);
		const lc: [string, string][] = [];
		if (r.lc.prevent) lc.push(['prevent_destroy', 'true']);
		if (r.lc.cbd) lc.push(['create_before_destroy', 'true']);
		if (r.lc.ignore.length) lc.push(['ignore_changes', `[${r.lc.ignore.join(', ')}]`]);
		if (r.lc.trigger) lc.push(['replace_triggered_by', `[${r.lc.trigger}]`]);
		if (lc.length) {
			const w = Math.max(...lc.map(([k]) => k.length));
			lines.push('', '  lifecycle {', ...lc.map(([k, v]) => `    ${k.padEnd(w)} = ${v}`), '  }');
		}
		return [`resource "${r.type}" "${r.name}" {`, ...lines, '}'].join('\n');
	});
	const moved = p.moved.map((m) => ['moved {', `  from = ${m.from}`, `  to   = ${m.to}`, '}'].join('\n'));
	return [...blocks, ...moved].join('\n\n');
}

function stateText(p: Params): string {
	return p.state
		.map((s) => {
			const pairs: [string, Lit][] = [['id', s.id], ...Object.entries(s.attrs)];
			const width = Math.max(...pairs.map(([k]) => k.length));
			return [s.address, ...pairs.map(([k, v]) => `  ${k.padEnd(width)} = ${literal(v)}`)].join('\n');
		})
		.join('\n\n');
}

function describe(p: Params): string {
	const lines = ['Состояние (что сейчас создано):', '', '```', stateText(p), '```', '', 'Новое описание — ниже.'];
	if (p.removedProtected.length)
		lines.push(
			'',
			`Из описания удалили блок ресурса ${p.removedProtected.map((a) => `\`${a}\``).join(', ')}; в прежнем описании у него был \`lifecycle { prevent_destroy = true }\`.`
		);
	lines.push(
		'',
		'Атрибуты, изменение которых требует замены:',
		'',
		...Object.entries(TYPES).map(
			([type, t], i, all) =>
				`- \`${type}\`: ${t.forceNew.map((k) => `\`${k}\``).join(', ')}${i === all.length - 1 ? '.' : ';'}`
		),
		'',
		'Как строится план:',
		'',
		'- адрес есть в описании, но нет в состоянии — `create`; есть в состоянии, но нет в описании — `destroy`; `moved` переносит объект состояния со старого адреса на новый;',
		'- иначе атрибуты сравниваются с состоянием, кроме перечисленных в `ignore_changes` — их различия не учитываются; изменился атрибут, требующий замены, — замена; изменились только другие — `update`;',
		'- замена показывается как `replace`, а у ресурса с `create_before_destroy = true` — как `replace-cbd`;',
		'- `replace_triggered_by = [<адрес>]`: если у указанного ресурса в плане `update` или замена, этот ресурс заменяется;',
		'- `prevent_destroy = true`: если ресурсу с этим правилом в описании план назначает замену или удаление, план завершается ошибкой. Правило действует, только пока блок ресурса есть в описании.',
		'',
		'Введите действия плана: по строке `<адрес> <действие>` (`create`, `update`, `replace`, `replace-cbd`, `destroy`), без ресурсов без изменений; порядок строк не важен; если изменений нет — `-`. Если план завершается ошибкой, введите только строки `error <адрес>` для каждого ресурса, из-за которого она возникает. Например:',
		'',
		'```',
		'cloud_disk.data update',
		'cloud_queue.jobs replace-cbd',
		'```'
	);
	return lines.join('\n');
}

// An independent reference: parses the shown description and state and applies the statement's rules.
const PYTHON_REFERENCE = `import json, re

data = json.loads(input())
force_new = data["forceNew"]

def lit(text):
    text = text.strip()
    return text[1:-1] if text.startswith('"') else int(text)

config, order, moved = {}, [], {}
for kind, head, body in re.findall(r'^(resource|moved)([^{\\n]*)\\{\\n(.*?)^\\}', data["hcl"], re.S | re.M):
    if kind == "moved":
        pairs = dict(re.findall(r"^\\s+(\\w+)\\s*=\\s*(\\S+)$", body, re.M))
        moved[pairs["to"]] = pairs["from"]
        continue
    rtype, name = re.findall(r'"([^"]+)"', head)
    attrs = {k: lit(v) for k, v in re.findall(r"^  (\\w+)\\s*=\\s*(.+)$", body, re.M)}
    rules = dict(re.findall(r"^    (\\w+)\\s*=\\s*(.+)$", body, re.M))
    listed = lambda key: [x.strip() for x in rules.get(key, "[]").strip("[]").split(",") if x.strip()]
    config[rtype + "." + name] = {
        "type": rtype,
        "attrs": attrs,
        "prevent": rules.get("prevent_destroy") == "true",
        "cbd": rules.get("create_before_destroy") == "true",
        "ignore": listed("ignore_changes"),
        "trigger": (listed("replace_triggered_by") or [None])[0],
    }
    order.append(rtype + "." + name)

state = {}
for block in data["state"].strip().split("\\n\\n"):
    lines = block.split("\\n")
    state[lines[0].strip()] = {k.strip(): lit(v) for k, v in (l.split("=", 1) for l in lines[1:])}

source = {}
for a in order:
    if a in state:
        source[a] = a
    elif a in moved and moved[a] in state and moved[a] not in config:
        source[a] = moved[a]

action = {}
for a in order:
    r = config[a]
    if a not in source:
        action[a] = "create"
        continue
    old = state[source[a]]
    diff = [k for k, v in r["attrs"].items() if v != old[k] and k not in r["ignore"]]
    replace = "replace-cbd" if r["cbd"] else "replace"
    action[a] = replace if set(diff) & set(force_new[r["type"]]) else "update" if diff else None
final = dict(action)
for a in order:
    t = config[a]["trigger"]
    if t and action.get(t) in ("update", "replace", "replace-cbd") and action[a] != "create":
        final[a] = "replace-cbd" if config[a]["cbd"] else "replace"
errors = sorted("error " + a for a in order if config[a]["prevent"] and final[a] in ("replace", "replace-cbd"))
if errors:
    print("\\n".join(errors))
else:
    taken = set(source.values())
    out = [a + " " + final[a] for a in order if final[a]] + [a + " destroy" for a in state if a not in taken]
    print("\\n".join(sorted(out)) if out else "-")
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/ignore-changes': ['ignore-changes-ignored', 'ignore-all'],
	'senior/prevent-destroy': ['removed-still-protected'],
	'senior/replace-triggered': ['trigger-only-on-replace', 'cbd-ignored'],
	'senior/combo': ['moved-ignored', 'ignore-all']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = plan(p, RIGHT);
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = plan(p, { ...RIGHT, ...change });
				return [id, value.join('\n') === key ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const source = hcl(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'hcl', source } },
			answer: { kind: 'set', value: answer }
		});
		const forceNew = Object.fromEntries(Object.entries(TYPES).map(([t, s]) => [t, s.forceNew]));
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ hcl: source, state: stateText(p), forceNew })
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
