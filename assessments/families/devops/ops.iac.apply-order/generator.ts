// The order in which an apply runs its operations: a graph from references and `depends_on`, a limit on parallel
// operations and waves of equally long operations. Creation goes from dependencies to dependents, destruction the other
// way, and a replacement with `create_before_destroy` creates the new object first and removes the old one only after
// the dependents are updated.
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

interface Resource {
	address: string;
	/** Attribute → literal or reference (`<address>.<attr>`, or a list of references). */
	attrs: [string, string][];
	refs: string[];
	dependsOn: string[];
	cbd: boolean;
}

interface Params {
	classId: string;
	parallelism: number;
	resources: Resource[];
	/** Replace-cbd: the plan's replacements and updates. */
	replaced: string[];
	updated: string[];
}

interface Rules {
	ignoreParallelism: boolean;
	ignoreDependsOn: boolean;
	destroyForward: boolean;
	cbdIgnored: boolean;
	cbdDestroyEarly: boolean;
}

const RIGHT: Rules = {
	ignoreParallelism: false,
	ignoreDependsOn: false,
	destroyForward: false,
	cbdIgnored: false,
	cbdDestroyEarly: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'ignore-parallelism': { ignoreParallelism: true },
	'ignore-depends-on': { ignoreDependsOn: true },
	'destroy-forward': { destroyForward: true },
	'cbd-ignored': { cbdIgnored: true },
	'cbd-destroy-early': { cbdDestroyEarly: true }
};

/** Operations `<address> <op>` and what each waits for. */
type Graph = Map<string, Set<string>>;

function graphOf(p: Params, rules: Rules): Graph {
	const g: Graph = new Map();
	const edges = (r: Resource): string[] => [...r.refs, ...(rules.ignoreDependsOn ? [] : r.dependsOn)];
	if (p.classId === 'replace-cbd') {
		for (const a of p.replaced) {
			g.set(`${a} create`, new Set());
			g.set(`${a} destroy`, new Set());
		}
		for (const a of p.updated) g.set(`${a} update`, new Set());
		for (const r of p.resources) {
			const op = p.replaced.includes(r.address) ? 'create' : p.updated.includes(r.address) ? 'update' : null;
			if (!op) continue;
			for (const d of edges(r)) if (p.replaced.includes(d)) g.get(`${r.address} ${op}`)?.add(`${d} create`);
		}
		for (const a of p.replaced) {
			const r = p.resources.find((x) => x.address === a);
			const cbd = (r?.cbd ?? false) && !rules.cbdIgnored;
			if (!cbd) {
				g.get(`${a} create`)?.add(`${a} destroy`);
				continue;
			}
			g.get(`${a} destroy`)?.add(`${a} create`);
			if (rules.cbdDestroyEarly) continue;
			for (const u of p.updated) {
				const ur = p.resources.find((x) => x.address === u);
				if (ur && edges(ur).includes(a)) g.get(`${a} destroy`)?.add(`${u} update`);
			}
		}
		return g;
	}
	const destroy = p.classId === 'destroy-order';
	for (const r of p.resources) g.set(`${r.address} ${destroy ? 'destroy' : 'create'}`, new Set());
	for (const r of p.resources) {
		for (const d of edges(r)) {
			if (destroy && !rules.destroyForward) g.get(`${d} destroy`)?.add(`${r.address} destroy`);
			else g.get(`${r.address} ${destroy ? 'destroy' : 'create'}`)?.add(`${d} ${destroy ? 'destroy' : 'create'}`);
		}
	}
	return g;
}

/** Waves: each wave runs up to `parallelism` ready operations, the first by address; all take equally long. */
function waves(p: Params, rules: Rules): string[] {
	const g = graphOf(p, rules);
	const done = new Set<string>();
	const out: string[] = [];
	const limit = rules.ignoreParallelism ? Infinity : p.parallelism;
	for (let wave = 1; done.size < g.size; wave += 1) {
		const ready = [...g.keys()]
			.filter((op) => !done.has(op) && [...(g.get(op) ?? [])].every((d) => done.has(d)))
			.sort();
		if (!ready.length) throw new Error('cycle in the operations');
		const now = ready.slice(0, limit);
		for (const op of now) {
			done.add(op);
			out.push(`${wave} ${op}`);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

function infra(rng: Rng): Resource[] {
	const res: Resource[] = [];
	const add = (address: string, attrs: [string, string][], refs: string[]): void => {
		res.push({ address, attrs, refs, dependsOn: [], cbd: false });
	};
	const net = `cloud_network.${rng.pick(['main', 'core', 'prod'])}`;
	add(net, [['cidr', '"10.0.0.0/16"']], []);
	const subnets = rng.sample(['a', 'b', 'app', 'data'], rng.int(1, 2)).map((s) => `cloud_subnet.${s}`);
	subnets.forEach((s, i) => {
		add(
			s,
			[
				['network_id', `${net}.id`],
				['cidr', `"10.0.${i + 1}.0/24"`]
			],
			[net]
		);
	});
	const sg = `cloud_security_group.${rng.pick(['web', 'ingress'])}`;
	add(sg, [['network_id', `${net}.id`]], [net]);
	const bucket = rng.bool(0.6) ? `cloud_bucket.${rng.pick(['config', 'assets', 'artifacts'])}` : null;
	if (bucket) add(bucket, [['name', `"${bucket.split('.')[1] ?? 'b'}-${rng.int(100, 999)}"`]], []);
	const db = rng.bool(0.6) ? `cloud_database.${rng.pick(['main', 'orders'])}` : null;
	if (db)
		add(
			db,
			[
				['subnet_id', `${subnets[subnets.length - 1] ?? ''}.id`],
				['engine', '"postgres"']
			],
			[subnets[subnets.length - 1] ?? '']
		);
	const instances = rng.sample(['api', 'worker', 'web', 'backend'], rng.int(1, 3)).map((s) => `cloud_instance.${s}`);
	instances.forEach((inst, i) => {
		const subnet = subnets[i % subnets.length] ?? '';
		add(
			inst,
			[
				['subnet_id', `${subnet}.id`],
				['security_group_id', `${sg}.id`],
				['image', '"debian-12"']
			],
			[subnet, sg]
		);
	});
	let front = instances[0] ?? '';
	if (rng.bool(0.6) && instances.length > 1) {
		const lb = `cloud_lb.${rng.pick(['public', 'edge'])}`;
		add(
			lb,
			[
				['subnet_id', `${subnets[0] ?? ''}.id`],
				['backend_ids', `[${instances.map((x) => `${x}.id`).join(', ')}]`]
			],
			[subnets[0] ?? '', ...instances]
		);
		front = lb;
	}
	add(
		`cloud_dns_record.${rng.pick(['www', 'api'])}`,
		[
			['value', `${front}.ip`],
			['ttl', '300']
		],
		[front]
	);
	return res;
}

/** Adds `depends_on` edges a later resource does not get from its references. */
function addDependsOn(rng: Rng, res: Resource[], count: number): void {
	const closure = (a: string): Set<string> => {
		const seen = new Set<string>();
		const stack = [a];
		while (stack.length) {
			const x = stack.pop() ?? '';
			const r = res.find((y) => y.address === x);
			for (const d of [...(r?.refs ?? []), ...(r?.dependsOn ?? [])]) {
				if (seen.has(d)) continue;
				seen.add(d);
				stack.push(d);
			}
		}
		return seen;
	};
	for (let k = 0; k < count; k += 1) {
		const options: [Resource, string][] = [];
		res.forEach((r, i) => {
			const reach = closure(r.address);
			for (const d of res.slice(0, i))
				if (!reach.has(d.address) && !closure(d.address).has(r.address)) options.push([r, d.address]);
		});
		if (!options.length) return;
		const [r, d] = rng.pick(options);
		r.dependsOn.push(d);
	}
}

function scenario(rng: Rng, classId: string): Params {
	const resources = infra(rng);
	const parallelism = rng.int(2, 3);
	if (classId === 'depends-on' || rng.bool(0.4))
		addDependsOn(rng, resources, classId === 'depends-on' ? rng.int(1, 2) : 1);
	if (classId !== 'replace-cbd') return { classId, parallelism, resources, replaced: [], updated: [] };
	// Two replacements that do not depend on each other, one with create_before_destroy; their direct dependents update.
	const referenced = resources.filter((r) => resources.some((x) => x.refs.includes(r.address)));
	const [a, b] = rng.sample(referenced, 2) as [Resource, Resource];
	const independent = (x: Resource, y: Resource): boolean => !x.refs.includes(y.address) && !y.refs.includes(x.address);
	const replaced = independent(a, b) ? [a.address, b.address] : [a.address];
	const cbdTarget = resources.find((r) => r.address === rng.pick(replaced));
	if (cbdTarget) cbdTarget.cbd = true;
	const updated = resources
		.filter((r) => !replaced.includes(r.address) && r.refs.some((d) => replaced.includes(d)))
		.map((r) => r.address);
	return { classId, parallelism, resources, replaced, updated };
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function hcl(p: Params): string {
	return p.resources
		.map((r) => {
			const [type, name] = r.address.split('.');
			const pairs: [string, string][] = [...r.attrs];
			if (r.dependsOn.length) pairs.push(['depends_on', `[${r.dependsOn.join(', ')}]`]);
			const width = Math.max(...pairs.map(([k]) => k.length));
			const body = pairs.map(([k, v]) => `  ${k.padEnd(width)} = ${v}`);
			if (r.cbd) body.push('', '  lifecycle {', '    create_before_destroy = true', '  }');
			return [`resource "${type ?? ''}" "${name ?? ''}" {`, ...body, '}'].join('\n');
		})
		.join('\n\n');
}

function describe(p: Params): string {
	const lines: string[] = [];
	if (p.classId === 'replace-cbd') {
		lines.push(
			'Все ресурсы описания (ниже) уже созданы. План применения:',
			'',
			...p.replaced.map((a) => `- \`${a}\` — замена (replace);`),
			...p.updated.map((a) => `- \`${a}\` — обновление на месте (update);`),
			'- остальные ресурсы без изменений.',
			'',
			'Операции плана: `create` и `destroy` у каждого заменяемого ресурса (новый и старый объект), `update` у обновляемых. Порядок:',
			'',
			'- `update` или `create` ресурса ждёт `create` каждого заменяемого ресурса, на который он ссылается (через атрибут или `depends_on`);',
			'- замена без `create_before_destroy`: сначала `destroy` старого объекта, затем `create` нового;',
			'- замена с `create_before_destroy = true`: сначала `create` нового; `destroy` старого — только после `create` и после `update` всех ресурсов, которые на него ссылаются;'
		);
	} else if (p.classId === 'destroy-order') {
		lines.push(
			'Все ресурсы описания (ниже) созданы, выполняется удаление всей инфраструктуры. Порядок:',
			'',
			'- ресурс зависит от тех, на кого ссылается в атрибутах, и от перечисленных в `depends_on`;',
			'- ресурс удаляется (`destroy`) только после того, как удалены все ресурсы, которые от него зависят;'
		);
	} else {
		lines.push(
			'Описание (ниже) применяется с нуля: все ресурсы создаются. Порядок:',
			'',
			'- ресурс зависит от тех, на кого ссылается в атрибутах, и от перечисленных в `depends_on`;',
			'- ресурс создаётся (`create`) только после того, как созданы все, от кого он зависит;'
		);
	}
	lines.push(
		`- все операции длятся одинаково и идут волнами: в каждой волне запускаются готовые операции (всё, чего они ждут, завершено), но не больше ${p.parallelism} одновременно; если готовых больше, берутся первые по алфавиту строки \`<адрес> <операция>\`; следующая волна начинается, когда завершена вся текущая.`,
		'',
		'Введите все операции по порядку, по строке `<номер волны> <адрес> <операция>`; внутри волны — по алфавиту адресов. Например:',
		'',
		'```',
		'1 cloud_network.main create',
		'2 cloud_security_group.web create',
		'2 cloud_subnet.a create',
		'```'
	);
	return lines.join('\n');
}

// An independent reference: parses the shown description, builds the operations and their order and runs the waves.
const PYTHON_REFERENCE = `import json, re

data = json.loads(input())
resources = {}
for rtype, name, body in re.findall(r'^resource "(\\w+)" "(\\w+)" \\{\\n(.*?)^\\}', data["hcl"], re.S | re.M):
    deps = set()
    for line in body.split("\\n"):
        for target in re.findall(r"\\b(cloud_\\w+\\.\\w+)", line.split("=", 1)[1] if "=" in line else ""):
            deps.add(target)
    resources[rtype + "." + name] = {"deps": deps, "cbd": "create_before_destroy = true" in body}

waits = {}
mode = data["mode"]
if mode == "create":
    for a, r in resources.items():
        waits[a + " create"] = {d + " create" for d in r["deps"]}
elif mode == "destroy":
    for a in resources:
        waits[a + " destroy"] = {b + " destroy" for b, r in resources.items() if a in r["deps"]}
else:
    replaced, updated = data["replaced"], data["updated"]
    for a in replaced:
        waits[a + " create"] = set()
        waits[a + " destroy"] = set()
    for a in updated:
        waits[a + " update"] = set()
    for a, r in resources.items():
        op = "create" if a in replaced else "update" if a in updated else None
        if op:
            waits[a + " " + op] |= {d + " create" for d in r["deps"] if d in replaced}
    for a in replaced:
        if resources[a]["cbd"]:
            waits[a + " destroy"].add(a + " create")
            waits[a + " destroy"] |= {u + " update" for u in updated if a in resources[u]["deps"]}
        else:
            waits[a + " create"].add(a + " destroy")

done = set()
wave = 0
while len(done) < len(waits):
    wave += 1
    ready = sorted(op for op in waits if op not in done and waits[op] <= done)
    assert ready, "cycle"
    for op in ready[: data["parallelism"]]:
        print(wave, op)
        done.add(op)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/create-waves': ['ignore-parallelism'],
	'senior/destroy-order': ['destroy-forward', 'ignore-parallelism'],
	'senior/depends-on': ['ignore-depends-on', 'ignore-parallelism'],
	'senior/replace-cbd': ['cbd-ignored', 'cbd-destroy-early']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = waves(p, RIGHT);
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = waves(p, { ...RIGHT, ...change });
				return [id, value.join('\n') === key ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const source = hcl(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'hcl', source } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({
					hcl: source,
					mode: input.classId === 'destroy-order' ? 'destroy' : input.classId === 'replace-cbd' ? 'replace' : 'create',
					parallelism: p.parallelism,
					replaced: p.replaced,
					updated: p.updated
				})
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
