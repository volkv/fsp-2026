// The plan of an infrastructure description against its state: which addresses are created, updated in place,
// replaced or destroyed. Attributes that force a replacement are listed in the statement; a replaced or created
// resource's identifier is known only after apply, which changes every attribute referring to it; `moved` keeps the
// object under a new address, a rename without it destroys and creates.
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

type Value = { lit: string | number } | { ref: { address: string; attr: 'id' | 'ip' } };

interface Resource {
	type: string;
	name: string;
	attrs: Record<string, Value>;
}

interface StateObject {
	address: string;
	id: string;
	ip: string | null;
	attrs: Record<string, string | number>;
}

interface Params {
	config: Resource[];
	moved: { from: string; to: string }[];
	state: StateObject[];
}

interface Rules {
	allUpdate: boolean;
	anyReplace: boolean;
	renameNoop: boolean;
	movedRecreate: boolean;
	noPropagation: boolean;
	propagateReplace: boolean;
}

const RIGHT: Rules = {
	allUpdate: false,
	anyReplace: false,
	renameNoop: false,
	movedRecreate: false,
	noPropagation: false,
	propagateReplace: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'all-update': { allUpdate: true },
	'any-replace': { anyReplace: true },
	'rename-noop': { renameNoop: true },
	'moved-recreate': { movedRecreate: true },
	'no-propagation': { noPropagation: true },
	'propagate-replace': { propagateReplace: true }
};

/** The attributes of every type, in the order they are written; those that force a replacement. */
const TYPES: Record<string, { attrs: string[]; forceNew: string[]; ip?: boolean }> = {
	cloud_network: { attrs: ['name', 'cidr'], forceNew: ['cidr'] },
	cloud_subnet: { attrs: ['network_id', 'cidr', 'zone'], forceNew: ['network_id', 'cidr', 'zone'] },
	cloud_security_group: { attrs: ['network_id', 'name', 'description'], forceNew: ['network_id', 'name'] },
	cloud_instance: {
		attrs: ['subnet_id', 'security_group_id', 'image', 'size', 'name'],
		forceNew: ['subnet_id', 'image'],
		ip: true
	},
	cloud_dns_record: { attrs: ['name', 'value', 'ttl'], forceNew: ['name'] },
	cloud_disk: { attrs: ['zone', 'size', 'type'], forceNew: ['zone', 'type'] },
	cloud_bucket: { attrs: ['name', 'versioning'], forceNew: ['name'] }
};

const addressOf = (r: Resource): string => `${r.type}.${r.name}`;

type Action = 'create' | 'update' | 'replace' | 'destroy' | 'noop';

function plan(p: Params, rules: Rules): string[] {
	const state = new Map(p.state.map((s) => [s.address, s]));
	const configAddresses = new Set(p.config.map(addressOf));
	const moved = rules.movedRecreate ? [] : p.moved;
	// Which state object each configured address takes over.
	const owner = new Map<string, StateObject>();
	const used = new Set<string>();
	for (const r of p.config) {
		const address = addressOf(r);
		const direct = state.get(address);
		if (direct) {
			owner.set(address, direct);
			used.add(address);
			continue;
		}
		const move = moved.find((m) => m.to === address && state.has(m.from) && !configAddresses.has(m.from));
		if (move) {
			owner.set(address, state.get(move.from) as StateObject);
			used.add(move.from);
		}
	}
	if (rules.renameNoop) {
		for (const r of p.config) {
			const address = addressOf(r);
			if (owner.has(address)) continue;
			const orphan = p.state.find(
				(s) => !used.has(s.address) && !configAddresses.has(s.address) && s.address.startsWith(`${r.type}.`)
			);
			if (orphan) {
				owner.set(address, orphan);
				used.add(orphan.address);
			}
		}
	}
	const action = new Map<string, Action>();
	const byAddress = new Map(p.config.map((r) => [addressOf(r), r]));
	const resolve = (address: string): Action => {
		const known = action.get(address);
		if (known) return known;
		const r = byAddress.get(address);
		if (!r) throw new Error(`no resource ${address}`);
		const old = owner.get(address);
		if (!old) {
			action.set(address, 'create');
			return 'create';
		}
		const spec = TYPES[r.type] ?? { attrs: [], forceNew: [] };
		let changed = false;
		let forced = false;
		let unknownRef = false;
		for (const attr of spec.attrs) {
			const v = r.attrs[attr];
			if (!v) continue;
			let differs: boolean;
			if ('lit' in v) differs = v.lit !== old.attrs[attr];
			else {
				const target = resolve(v.ref.address);
				const unknown = target === 'create' || target === 'replace';
				if (unknown && !rules.noPropagation) {
					differs = true;
					unknownRef = true;
				} else {
					const t = owner.get(v.ref.address);
					differs = !rules.noPropagation && (v.ref.attr === 'id' ? t?.id : t?.ip) !== old.attrs[attr];
				}
			}
			if (!differs) continue;
			changed = true;
			if (spec.forceNew.includes(attr)) forced = true;
		}
		const result: Action = !changed
			? 'noop'
			: rules.anyReplace || (rules.propagateReplace && unknownRef)
				? 'replace'
				: forced && !rules.allUpdate
					? 'replace'
					: 'update';
		action.set(address, result);
		return result;
	};
	const out: string[] = [];
	for (const r of p.config) {
		const a = resolve(addressOf(r));
		if (a !== 'noop') out.push(`${addressOf(r)} ${a}`);
	}
	for (const s of p.state) if (!used.has(s.address)) out.push(`${s.address} destroy`);
	return out.length ? out.sort() : ['-'];
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios: a base infrastructure, its state, then the edits of the class.

const hex = (rng: Rng): string => rng.int(0x1000, 0xffff).toString(16);

interface Base {
	resources: Resource[];
	net: string;
	subnets: string[];
	sg: string;
	instances: string[];
}

function baseInfra(rng: Rng): Base {
	const n = rng.int(1, 60);
	const net = rng.pick(['main', 'core', 'prod', 'shared']);
	const subnets = rng.sample(['app', 'web', 'data', 'private', 'public'], rng.int(1, 2));
	const sg = rng.pick(['web', 'frontend', 'ingress']);
	const instances = rng.sample(['api', 'worker', 'frontend', 'gateway', 'backend'], rng.int(1, 2));
	const ref = (address: string, attr: 'id' | 'ip' = 'id'): Value => ({ ref: { address, attr } });
	const resources: Resource[] = [
		{ type: 'cloud_network', name: net, attrs: { name: { lit: `${net}-net` }, cidr: { lit: `10.${n}.0.0/16` } } },
		...subnets.map((s, i) => ({
			type: 'cloud_subnet',
			name: s,
			attrs: {
				network_id: ref(`cloud_network.${net}`),
				cidr: { lit: `10.${n}.${i + 1}.0/24` },
				zone: { lit: rng.pick(['ru-a', 'ru-b', 'ru-c']) }
			}
		})),
		{
			type: 'cloud_security_group',
			name: sg,
			attrs: {
				network_id: ref(`cloud_network.${net}`),
				name: { lit: `${sg}-sg` },
				description: { lit: rng.pick(['http and https', 'public ingress', 'web traffic']) }
			}
		},
		...instances.map((name, i) => ({
			type: 'cloud_instance',
			name,
			attrs: {
				subnet_id: ref(`cloud_subnet.${subnets[i % subnets.length] ?? ''}`),
				security_group_id: ref(`cloud_security_group.${sg}`),
				image: { lit: rng.pick(['ubuntu-22.04', 'debian-12', 'ubuntu-24.04']) },
				size: { lit: rng.pick(['s2.small', 's2.medium', 's3.large']) },
				name: { lit: `${name}-1` }
			}
		})),
		{
			type: 'cloud_dns_record',
			name: rng.pick(['www', 'api', 'app']),
			attrs: {
				name: { lit: `${rng.pick(['www', 'api', 'app'])}.example.ru` },
				value: ref(`cloud_instance.${instances[0] ?? ''}`, 'ip'),
				ttl: { lit: rng.pick([60, 300, 600]) }
			}
		}
	];
	if (rng.bool(0.6))
		resources.push({
			type: 'cloud_disk',
			name: rng.pick(['data', 'logs', 'scratch']),
			attrs: {
				zone: { lit: rng.pick(['ru-a', 'ru-b']) },
				size: { lit: 10 * rng.int(2, 20) },
				type: { lit: rng.pick(['ssd', 'hdd']) }
			}
		});
	resources.push({
		type: 'cloud_bucket',
		name: rng.pick(['assets', 'backups', 'media']),
		attrs: { name: { lit: `bucket-${hex(rng)}` }, versioning: { lit: rng.pick(['enabled', 'suspended']) } }
	});
	return { resources, net, subnets, sg, instances };
}

function stateOf(rng: Rng, resources: readonly Resource[]): StateObject[] {
	const objects = new Map<string, StateObject>();
	const prefix: Record<string, string> = {
		cloud_network: 'net',
		cloud_subnet: 'subnet',
		cloud_security_group: 'sg',
		cloud_instance: 'vm',
		cloud_dns_record: 'rec',
		cloud_disk: 'disk',
		cloud_bucket: 'bkt'
	};
	for (const r of resources) {
		const attrs: Record<string, string | number> = {};
		for (const [k, v] of Object.entries(r.attrs)) {
			if ('lit' in v) attrs[k] = v.lit;
			else {
				const t = objects.get(v.ref.address);
				attrs[k] = (v.ref.attr === 'id' ? t?.id : t?.ip) ?? '';
			}
		}
		objects.set(addressOf(r), {
			address: addressOf(r),
			id: `${prefix[r.type] ?? 'obj'}-${hex(rng)}`,
			ip: TYPES[r.type]?.ip ? `10.0.${rng.int(1, 9)}.${rng.int(10, 250)}` : null,
			attrs
		});
	}
	return [...objects.values()];
}

const clone = (resources: readonly Resource[]): Resource[] =>
	resources.map((r) => ({ type: r.type, name: r.name, attrs: { ...r.attrs } }));

/** Renames a resource in the description; references follow the new name. */
function rename(config: Resource[], address: string, name: string): string {
	const r = config.find((x) => addressOf(x) === address);
	if (!r) throw new Error(`no ${address}`);
	r.name = name;
	const to = addressOf(r);
	for (const x of config)
		for (const [k, v] of Object.entries(x.attrs))
			if ('ref' in v && v.ref.address === address) x.attrs[k] = { ref: { address: to, attr: v.ref.attr } };
	return to;
}

const NEW_VALUES: Record<string, (rng: Rng, old: string | number) => string | number> = {
	cidr: (rng, old) => String(old).replace(/^10\.(\d+)\./, (_, x: string) => `10.${(Number(x) + rng.int(1, 9)) % 250}.`),
	zone: (rng, old) => rng.pick(['ru-a', 'ru-b', 'ru-c'].filter((z) => z !== old)),
	image: (rng, old) => rng.pick(['ubuntu-22.04', 'debian-12', 'ubuntu-24.04'].filter((z) => z !== old)),
	size: (rng, old) =>
		typeof old === 'number'
			? old + 10 * rng.int(1, 5)
			: rng.pick(['s2.small', 's2.medium', 's3.large'].filter((z) => z !== old)),
	name: (_rng, old) => `${String(old)}-v2`,
	description: (rng, old) => rng.pick(['http only', 'managed by platform', 'ingress v2'].filter((z) => z !== old)),
	ttl: (rng, old) => rng.pick([60, 300, 600, 900].filter((z) => z !== old)),
	type: (_rng, old) => (old === 'ssd' ? 'hdd' : 'ssd'),
	versioning: (_rng, old) => (old === 'enabled' ? 'suspended' : 'enabled')
};

/** Changes a literal attribute of a resource; `forceNew` chooses among attributes that force a replacement or not. */
function changeLiteral(rng: Rng, config: Resource[], forceNew: boolean, avoid: readonly string[] = []): string | null {
	const options = config.flatMap((r) =>
		Object.entries(r.attrs)
			.filter(([k, v]) => 'lit' in v && (TYPES[r.type]?.forceNew.includes(k) ?? false) === forceNew)
			.filter(() => !avoid.includes(addressOf(r)))
			.map(([k]) => ({ r, k }))
	);
	if (!options.length) return null;
	const { r, k } = rng.pick(options);
	const old = r.attrs[k];
	if (!old || !('lit' in old)) return null;
	r.attrs[k] = { lit: (NEW_VALUES[k] ?? ((_: Rng, o: string | number) => `${String(o)}-2`))(rng, old.lit) };
	return addressOf(r);
}

const referenced = (config: readonly Resource[], address: string): boolean =>
	config.some((x) => Object.values(x.attrs).some((v) => 'ref' in v && v.ref.address === address));

function scenario(rng: Rng, classId: string): Params {
	const base = baseInfra(rng);
	const state = stateOf(rng, base.resources);
	const config = clone(base.resources);
	const moved: { from: string; to: string }[] = [];
	const leafAddresses = (): string[] =>
		config.map(addressOf).filter((a) => !referenced(config, a) && !a.startsWith('cloud_network'));
	if (classId === 'force-new') {
		// Only resources nobody refers to change, so no replacement reaches a reference.
		const leaves = leafAddresses();
		const others = config.map(addressOf).filter((a) => !leaves.includes(a));
		changeLiteral(rng, config, true, others);
		changeLiteral(rng, config, false);
		if (rng.bool()) changeLiteral(rng, config, false);
		const gone = rng.pick(leafAddresses());
		config.splice(
			config.findIndex((r) => addressOf(r) === gone),
			1
		);
		config.push({
			type: 'cloud_bucket',
			name: rng.pick(['logs', 'exports', 'reports']),
			attrs: { name: { lit: `bucket-${hex(rng)}` }, versioning: { lit: 'enabled' } }
		});
	}
	if (classId === 'rename-moved') {
		const leaves = leafAddresses();
		const [a, b] = rng.sample(leaves, 2) as [string, string];
		const to = rename(config, a, `${a.split('.')[1] ?? 'x'}_${rng.pick(['main', 'primary', 'v2'])}`);
		moved.push({ from: a, to });
		if (rng.bool()) {
			const r = config.find((x) => addressOf(x) === to);
			if (r) changeLiteral(rng, [r], false);
		}
		rename(config, b, `${b.split('.')[1] ?? 'y'}_${rng.pick(['new', 'next', 'b'])}`);
		changeLiteral(rng, config, false, [to]);
	}
	if (classId === 'known-after-apply') {
		// A replacement of a referenced resource: its identifier is unknown until apply.
		const target = rng.pick([
			...base.subnets.map((s) => `cloud_subnet.${s}`),
			...base.instances.map((s) => `cloud_instance.${s}`),
			`cloud_network.${base.net}`
		]);
		const r = config.find((x) => addressOf(x) === target);
		if (r) {
			const forced = Object.keys(r.attrs).filter(
				(k) => TYPES[r.type]?.forceNew.includes(k) && 'lit' in (r.attrs[k] ?? { ref: 0 })
			);
			const k = rng.pick(forced);
			const old = r.attrs[k];
			if (old && 'lit' in old)
				r.attrs[k] = { lit: (NEW_VALUES[k] ?? ((_: Rng, o: string | number) => `${String(o)}-2`))(rng, old.lit) };
		}
		if (rng.bool()) changeLiteral(rng, config, false);
	}
	if (classId === 'combo') {
		// A referenced resource renamed without moved, and another moved with a change that forces a replacement.
		const subnet = `cloud_subnet.${base.subnets[0] ?? 'app'}`;
		const renamedTarget = rng.pick([subnet, `cloud_security_group.${base.sg}`]);
		rename(config, renamedTarget, `${renamedTarget.split('.')[1] ?? 'x'}_${rng.pick(['new', 'v2'])}`);
		const leaves = leafAddresses().filter((a) => !a.startsWith('cloud_bucket'));
		const pickFrom = leaves.length ? leaves : leafAddresses();
		const a = rng.pick(pickFrom);
		const to = rename(config, a, `${a.split('.')[1] ?? 'x'}_${rng.pick(['main', 'primary'])}`);
		moved.push({ from: a, to });
		const r = config.find((x) => addressOf(x) === to);
		if (r) changeLiteral(rng, [r], true);
	}
	return { config, moved, state };
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const literal = (v: string | number): string => (typeof v === 'number' ? String(v) : `"${v}"`);

function hcl(p: Params): string {
	const blocks = p.config.map((r) => {
		const keys = (TYPES[r.type]?.attrs ?? []).filter((k) => r.attrs[k]);
		const width = Math.max(...keys.map((k) => k.length));
		const lines = keys.map((k) => {
			const v = r.attrs[k] as Value;
			return `  ${k.padEnd(width)} = ${'lit' in v ? literal(v.lit) : `${v.ref.address}.${v.ref.attr}`}`;
		});
		return [`resource "${r.type}" "${r.name}" {`, ...lines, '}'].join('\n');
	});
	const moved = p.moved.map((m) => ['moved {', `  from = ${m.from}`, `  to   = ${m.to}`, '}'].join('\n'));
	return [...blocks, ...moved].join('\n\n');
}

function stateText(p: Params): string {
	return p.state
		.map((s) => {
			const pairs: [string, string | number][] = [
				['id', s.id],
				...(s.ip ? [['ip', s.ip] as [string, string]] : []),
				...Object.entries(s.attrs)
			];
			const width = Math.max(...pairs.map(([k]) => k.length));
			return [s.address, ...pairs.map(([k, v]) => `  ${k.padEnd(width)} = ${literal(v)}`)].join('\n');
		})
		.join('\n\n');
}

function describe(p: Params): string {
	return [
		'Состояние (что сейчас создано, вычисляемые атрибуты `id` и `ip` — после прошлого применения; ссылки в состоянии уже подставлены значениями):',
		'',
		'```',
		stateText(p),
		'```',
		'',
		'Новое описание инфраструктуры — ниже. Атрибуты, изменение которых требует замены ресурса:',
		'',
		...Object.entries(TYPES).map(
			([type, t], i, all) =>
				`- \`${type}\`: ${t.forceNew.map((k) => `\`${k}\``).join(', ')}${i === all.length - 1 ? '.' : ';'}`
		),
		'',
		'Как строится план:',
		'',
		'- адрес есть в описании, но нет в состоянии — `create`; есть в состоянии, но нет в описании — `destroy`;',
		'- блок `moved` переносит объект состояния со старого адреса на новый: дальше он сравнивается как ресурс нового адреса;',
		'- иначе атрибуты описания сравниваются с состоянием: изменился хоть один атрибут, требующий замены, — `replace`; изменились только другие — `update`; ничего не изменилось — действия нет;',
		'- ссылка `<адрес>.id` или `<адрес>.ip` равна значению из состояния, если ресурс по этому адресу не создаётся и не заменяется (`update` их не меняет); если создаётся или заменяется — значение станет известно только после применения и считается изменившимся.',
		'',
		'Введите действия плана: по строке `<адрес> <действие>` (`create`, `update`, `replace` или `destroy`), ресурсы без изменений не пишите; порядок строк не важен; если изменений нет — `-`. Например:',
		'',
		'```',
		'cloud_disk.data update',
		'cloud_bucket.logs create',
		'```'
	].join('\n');
}

// An independent reference: parses the shown description and state and builds the plan by the statement's rules.
const PYTHON_REFERENCE = `import json, re

data = json.loads(input())
force_new = data["forceNew"]

def value(text):
    text = text.strip()
    if text.startswith('"'):
        return ("lit", text[1:-1])
    if re.fullmatch(r"-?\\d+", text):
        return ("lit", int(text))
    *address, attr = text.split(".")
    return ("ref", ".".join(address), attr)

config = {}
order = []
moved = {}
for kind, head, body in re.findall(r'^(resource|moved)([^{\\n]*)\\{\\n(.*?)^\\}', data["hcl"], re.S | re.M):
    pairs = dict(re.findall(r"^\\s+(\\w+)\\s*=\\s*(.+)$", body, re.M))
    if kind == "moved":
        moved[pairs["to"].strip()] = pairs["from"].strip()
        continue
    rtype, name = re.findall(r'"([^"]+)"', head)
    address = rtype + "." + name
    config[address] = (rtype, {k: value(v) for k, v in pairs.items()})
    order.append(address)

state = {}
for block in data["state"].strip().split("\\n\\n"):
    lines = block.split("\\n")
    attrs = {}
    for line in lines[1:]:
        k, v = line.split("=", 1)
        attrs[k.strip()] = value(v)[1]
    state[lines[0].strip()] = attrs

source = {}
for address in order:
    if address in state:
        source[address] = address
    elif address in moved and moved[address] in state and moved[address] not in config:
        source[address] = moved[address]

actions = {}
def act(address):
    if address in actions:
        return actions[address]
    rtype, attrs = config[address]
    if address not in source:
        actions[address] = "create"
        return "create"
    old = state[source[address]]
    changed = set()
    for k, v in attrs.items():
        if v[0] == "lit":
            now = v[1]
        else:
            if act(v[1]) in ("create", "replace"):
                changed.add(k)
                continue
            now = state[source[v[1]]][v[2]]
        if now != old[k]:
            changed.add(k)
    if changed & set(force_new[rtype]):
        result = "replace"
    elif changed:
        result = "update"
    else:
        result = None
    actions[address] = result
    return result

lines = [a + " " + act(a) for a in order if act(a)]
taken = set(source.values())
lines += [a + " destroy" for a in state if a not in taken]
print("\\n".join(sorted(lines)) if lines else "-")
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/force-new': ['all-update', 'any-replace'],
	'senior/rename-moved': ['rename-noop', 'moved-recreate'],
	'senior/known-after-apply': ['no-propagation', 'propagate-replace'],
	'senior/combo': ['moved-recreate', 'no-propagation']
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
