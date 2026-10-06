// Instances of one resource over a variable: `count` addresses them by position in a list, `for_each` by key. The plan
// after the variable changes: a removed middle element shifts the indices of the tail under `count`, nothing moves
// under `for_each`, and a switch from `count` to `for_each` recreates every instance a `moved` block does not carry.
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

interface Server {
	name: string;
	zone: string;
	size: string;
}

type Mode = 'count' | 'for_each' | 'migration';

interface Params {
	mode: Mode;
	resource: string;
	old: Server[];
	next: Server[];
	/** Migration: old index → new key. */
	moved: { from: number; to: string }[];
}

interface Rules {
	countStable: boolean;
	inPlaceReplace: boolean;
	forceNewIgnored: boolean;
	forEachShift: boolean;
	migrationNoop: boolean;
	ignoreMoved: boolean;
}

const RIGHT: Rules = {
	countStable: false,
	inPlaceReplace: false,
	forceNewIgnored: false,
	forEachShift: false,
	migrationNoop: false,
	ignoreMoved: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'count-stable': { countStable: true },
	'in-place-replace': { inPlaceReplace: true },
	'force-new-ignored': { forceNewIgnored: true },
	'for-each-shift': { forEachShift: true },
	'migration-noop': { migrationNoop: true },
	'ignore-moved': { ignoreMoved: true }
};

const at = (resource: string, key: number | string): string =>
	typeof key === 'number' ? `${resource}[${key}]` : `${resource}["${key}"]`;

const byName = (a: Server, b: Server): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function plan(p: Params, rules: Rules): string[] {
	const state = new Map<string, Server>(
		p.mode === 'for_each' ? p.old.map((s) => [at(p.resource, s.name), s]) : p.old.map((s, i) => [at(p.resource, i), s])
	);
	// The address of every new instance.
	let wanted: [string, Server][];
	if (p.mode === 'count') {
		if (rules.countStable) {
			let extra = p.old.length;
			wanted = p.next.map((s) => {
				const i = p.old.findIndex((o) => o.name === s.name);
				return [at(p.resource, i >= 0 ? i : extra++), s];
			});
		} else wanted = p.next.map((s, i) => [at(p.resource, i), s]);
	} else if (p.mode === 'for_each' && rules.forEachShift) {
		const oldKeys = [...p.old].sort(byName).map((s) => s.name);
		wanted = [...p.next].sort(byName).map((s, i) => [at(p.resource, oldKeys[i] ?? s.name), s]);
	} else wanted = p.next.map((s) => [at(p.resource, s.name), s]);
	const source = new Map<string, string>();
	const wantedAddresses = new Set(wanted.map(([a]) => a));
	for (const [address] of wanted) if (state.has(address)) source.set(address, address);
	if (p.mode === 'migration') {
		const moves = rules.migrationNoop
			? p.old.map((s, i) => ({ from: i, to: s.name }))
			: rules.ignoreMoved
				? []
				: p.moved;
		for (const m of moves) {
			const from = at(p.resource, m.from);
			const to = at(p.resource, m.to);
			if (state.has(from) && !wantedAddresses.has(from) && wantedAddresses.has(to) && !source.has(to))
				source.set(to, from);
		}
	}
	const out: string[] = [];
	for (const [address, s] of wanted) {
		const from = source.get(address);
		const old = from === undefined ? undefined : state.get(from);
		if (!old) {
			out.push(`${address} create`);
			continue;
		}
		const forced = old.zone !== s.zone;
		const changed = forced || old.name !== s.name || old.size !== s.size;
		if (!changed) continue;
		const replace = rules.inPlaceReplace || (forced && !rules.forceNewIgnored);
		out.push(`${address} ${replace ? 'replace' : 'update'}`);
	}
	const taken = new Set(source.values());
	for (const address of state.keys()) if (!taken.has(address)) out.push(`${address} destroy`);
	return out.length ? out.sort() : ['-'];
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'lambda', 'theta', 'zeta'];
const ZONES = ['ru-a', 'ru-b', 'ru-c'];
const SIZES = ['s2.small', 's2.medium', 's3.large'];
const RESOURCES = ['web', 'worker', 'node', 'runner', 'edge'];

function scenario(rng: Rng, classId: string): Params {
	const n = rng.int(4, 6);
	const names = rng.sample(NAMES, n + 1);
	const zone = rng.pick(ZONES);
	const sameZone = classId === 'count-shift';
	const old: Server[] = names.slice(0, n).map((name) => ({
		name,
		zone: sameZone ? zone : rng.pick(ZONES),
		size: rng.pick(SIZES)
	}));
	const extraName = names[n] ?? 'nu';
	const resource = `cloud_instance.${rng.pick(RESOURCES)}`;
	const next = old.map((s) => ({ ...s }));
	if (classId === 'count-shift' || classId === 'count-force-new') {
		next.splice(rng.int(1, n - 2), 1);
		if (rng.bool(0.4)) next.push({ name: extraName, zone: sameZone ? zone : rng.pick(ZONES), size: rng.pick(SIZES) });
		return { mode: 'count', resource, old, next, moved: [] };
	}
	if (classId === 'for-each-stable') {
		next.splice(rng.int(1, n - 2), 1);
		next.splice(rng.int(0, next.length), 0, { name: extraName, zone: rng.pick(ZONES), size: rng.pick(SIZES) });
		const changed = rng.pick(next.filter((s) => s.name !== extraName));
		changed.size = rng.pick(SIZES.filter((x) => x !== changed.size));
		if (rng.bool(0.5)) {
			const other = rng.pick(next.filter((s) => s.name !== extraName && s !== changed));
			other.zone = rng.pick(ZONES.filter((x) => x !== other.zone));
		}
		return { mode: 'for_each', resource, old, next, moved: [] };
	}
	// Migration from count to for_each: some instances carried by moved, some not; one may also change in place.
	if (rng.bool(0.4)) next.splice(rng.int(0, n - 1), 1);
	const carried = rng.sample(
		next.map((s) => s.name),
		rng.int(Math.max(1, next.length - 3), next.length - 1)
	);
	const moved = carried.map((name) => ({ from: old.findIndex((s) => s.name === name), to: name }));
	if (rng.bool(0.5)) {
		const target = next.find((s) => carried.includes(s.name));
		if (target) target.size = rng.pick(SIZES.filter((x) => x !== target.size));
	}
	return { mode: 'migration', resource, old, next, moved };
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const pad = (names: readonly string[]): number => Math.max(...names.map((n) => n.length));

function hcl(p: Params): string {
	const [, label] = p.resource.split('.');
	const variable =
		p.mode === 'for_each'
			? [
					'variable "servers" {',
					'  default = {',
					...p.next.map(
						(s) => `    ${s.name.padEnd(pad(p.next.map((x) => x.name)))} = { zone = "${s.zone}", size = "${s.size}" }`
					),
					'  }',
					'}'
				]
			: [
					'variable "servers" {',
					'  default = [',
					...p.next.map((s) => `    { name = "${s.name}", zone = "${s.zone}", size = "${s.size}" },`),
					'  ]',
					'}'
				];
	const body =
		p.mode === 'count'
			? [
					'  count = length(var.servers)',
					'  name  = var.servers[count.index].name',
					'  zone  = var.servers[count.index].zone',
					'  size  = var.servers[count.index].size'
				]
			: p.mode === 'for_each'
				? [
						'  for_each = var.servers',
						'  name     = each.key',
						'  zone     = each.value.zone',
						'  size     = each.value.size'
					]
				: [
						'  for_each = { for s in var.servers : s.name => s }',
						'  name     = each.key',
						'  zone     = each.value.zone',
						'  size     = each.value.size'
					];
	const moved = p.moved.flatMap((m) => [
		'',
		'moved {',
		`  from = ${at(p.resource, m.from)}`,
		`  to   = ${at(p.resource, m.to)}`,
		'}'
	]);
	return [...variable, '', `resource "cloud_instance" "${label ?? 'web'}" {`, ...body, '}', ...moved].join('\n');
}

function stateLines(p: Params): string[] {
	return p.old.map((s, i) => {
		const address = p.mode === 'for_each' ? at(p.resource, s.name) : at(p.resource, i);
		return `${address}  name = "${s.name}", zone = "${s.zone}", size = "${s.size}"`;
	});
}

function describe(p: Params): string {
	return [
		p.mode === 'migration'
			? 'Раньше ресурс был описан через `count = length(var.servers)` по списку `var.servers`, и всё было применено. Теперь описание переписали на `for_each` (ниже), а список изменился. Состояние:'
			: 'Описание ниже уже применялось с прежним значением `var.servers`; затем значение переменной изменили (в описании — новое). Состояние:',
		'',
		'```',
		...stateLines(p),
		'```',
		'',
		'Правила:',
		'',
		'- при `count` экземпляр с индексом i (адрес `ресурс[i]`) получает i-й элемент списка; при `for_each` экземпляр с ключом k (адрес `ресурс["k"]`) — значение по ключу k;',
		'- адрес есть в плане, но нет в состоянии — `create`; есть в состоянии, но не в плане — `destroy`; блок `moved` переносит объект состояния со старого адреса на новый;',
		'- у сохранившегося адреса изменение `zone` требует замены (`replace`), изменение `name` или `size` выполняется на месте (`update`); без изменений — действия нет.',
		'',
		'Введите действия плана: по строке `<адрес> <действие>` (`create`, `update`, `replace` или `destroy`), без экземпляров без изменений; порядок строк не важен. Например:',
		'',
		'```',
		'cloud_instance.web[2] update',
		'cloud_instance.web["beta"] destroy',
		'```'
	].join('\n');
}

// An independent reference: expands the new instances from the variable and matches them against the shown state.
const PYTHON_REFERENCE = `import json, re

data = json.loads(input())
resource = data["resource"]
state = {}
for line in data["state"]:
    address, rest = line.split("  ", 1)
    state[address] = dict(re.findall(r'(\\w+) = "([^"]*)"', rest))
if data["mode"] == "count":
    wanted = {"%s[%d]" % (resource, i): s for i, s in enumerate(data["servers"])}
else:
    wanted = {'%s["%s"]' % (resource, s["name"]): s for s in data["servers"]}
source = {a: a for a in wanted if a in state}
for m in data["moved"]:
    if m["from"] in state and m["from"] not in wanted and m["to"] in wanted and m["to"] not in source:
        source[m["to"]] = m["from"]
lines = []
for address, s in wanted.items():
    if address not in source:
        lines.append(address + " create")
        continue
    old = state[source[address]]
    if old["zone"] != s["zone"]:
        lines.append(address + " replace")
    elif old["name"] != s["name"] or old["size"] != s["size"]:
        lines.append(address + " update")
taken = set(source.values())
lines += [a + " destroy" for a in state if a not in taken]
print("\\n".join(sorted(lines)) if lines else "-")
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/count-shift': ['count-stable', 'in-place-replace'],
	'senior/for-each-stable': ['for-each-shift', 'in-place-replace'],
	'senior/count-force-new': ['force-new-ignored', 'count-stable'],
	'senior/count-to-for-each': ['migration-noop', 'ignore-moved']
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
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'hcl', source: hcl(p) } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({
					mode: p.mode === 'count' ? 'count' : 'for_each',
					resource: p.resource,
					servers: p.next,
					state: stateLines(p),
					moved: p.moved.map((m) => ({ from: at(p.resource, m.from), to: at(p.resource, m.to) }))
				})
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
