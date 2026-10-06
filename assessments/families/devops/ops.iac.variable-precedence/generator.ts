// Values of input variables from all their sources — defaults, environment, terraform.tfvars, *.auto.tfvars in the
// lexical order of their names, -var and -var-file in the order of the command line — and the number of instances a
// `count` over them creates. A .tfvars file that is neither terraform.tfvars nor *.auto.tfvars is read only by -var-file.
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

type Val = number | boolean | string | string[];
type Vars = Partial<Record<VarName, Val>>;
type VarName = 'replicas' | 'zones' | 'enabled' | 'instance_type';

const VARS: VarName[] = ['replicas', 'zones', 'enabled', 'instance_type'];

/** A source of values: a file in the directory, the environment, or a `-var` of the command line. */
interface Source {
	kind: 'env' | 'tfvars' | 'auto' | 'file' | 'var';
	file: string | null;
	values: Vars;
	/** Position on the command line; null — not on it. */
	cli: number | null;
}

interface Params {
	defaults: Required<Record<VarName, Val>>;
	sources: Source[];
}

interface Rules {
	numericOrder: boolean;
	tfvarsOverAuto: boolean;
	varBeatsVarFile: boolean;
	firstWins: boolean;
	envHighest: boolean;
	allTfvarsLoaded: boolean;
}

const RIGHT: Rules = {
	numericOrder: false,
	tfvarsOverAuto: false,
	varBeatsVarFile: false,
	firstWins: false,
	envHighest: false,
	allTfvarsLoaded: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'numeric-order': { numericOrder: true },
	'tfvars-over-auto': { tfvarsOverAuto: true },
	'var-beats-var-file': { varBeatsVarFile: true },
	'first-wins': { firstWins: true },
	'env-highest': { envHighest: true },
	'all-tfvars-loaded': { allTfvarsLoaded: true }
};

const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const leadingNumber = (name: string): number => Number.parseInt(name, 10);

/** The sources in the order they are applied: a later one overrides an earlier one. */
function applied(p: Params, rules: Rules): Source[] {
	const env = p.sources.filter((s) => s.kind === 'env');
	const tfvars = p.sources.filter((s) => s.kind === 'tfvars');
	const autos = p.sources
		.filter((s) => s.kind === 'auto')
		.sort((a, b) =>
			rules.numericOrder
				? leadingNumber(a.file ?? '') - leadingNumber(b.file ?? '')
				: lexical(a.file ?? '', b.file ?? '')
		);
	const unused = rules.allTfvarsLoaded ? p.sources.filter((s) => s.kind === 'file' && s.cli === null) : [];
	let cli = p.sources.filter((s) => s.cli !== null).sort((a, b) => (a.cli ?? 0) - (b.cli ?? 0));
	if (rules.varBeatsVarFile) cli = [...cli.filter((s) => s.kind === 'file'), ...cli.filter((s) => s.kind === 'var')];
	if (rules.firstWins) cli = [...cli].reverse();
	const files = rules.tfvarsOverAuto ? [...unused, ...autos, ...tfvars] : [...tfvars, ...unused, ...autos];
	return rules.envHighest ? [...files, ...cli, ...env] : [...env, ...files, ...cli];
}

function answerOf(p: Params, rules: Rules): string {
	const v: Record<VarName, Val> = { ...p.defaults };
	for (const s of applied(p, rules)) Object.assign(v, s.values);
	const zones = (v.zones as string[]).length;
	const count = v.enabled ? (v.replicas as number) * zones : 0;
	return `${String(v.replicas)} ${zones} ${String(v.enabled)} ${String(v.instance_type)} ${count}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const ZONES = ['ru-a', 'ru-b', 'ru-c'];
const TYPES = ['s2.small', 's2.medium', 's2.large', 's3.medium', 's3.large', 'c2.xlarge'];

function value(rng: Rng, name: VarName): Val {
	switch (name) {
		case 'replicas':
			return rng.int(1, 9);
		case 'zones':
			return rng.sample(ZONES, rng.int(1, 3)).sort();
		case 'enabled':
			return rng.bool(0.75);
		case 'instance_type':
			return rng.pick(TYPES);
	}
}

function values(rng: Rng, names: readonly VarName[]): Vars {
	return Object.fromEntries(names.map((n) => [n, value(rng, n)]));
}

const some = (rng: Rng, min: number, max: number): VarName[] => rng.sample(VARS, rng.int(min, max));

/** Two or three auto files whose numeric and lexical orders differ. */
function autoNames(rng: Rng, count: number): string[] {
	const small = rng.int(2, 8);
	const big = rng.int(10, 39);
	const words = rng.sample(['base', 'scale', 'zones', 'override', 'prod', 'team', 'network'], 3);
	const names = [`${small}-${words[0] ?? 'a'}.auto.tfvars`, `${big}-${words[1] ?? 'b'}.auto.tfvars`];
	if (count > 2) names.push(`${rng.int(small + 1, 9)}-${words[2] ?? 'c'}.auto.tfvars`);
	return rng.shuffle(names);
}

function scenario(rng: Rng, classId: string): Params {
	const defaults = {
		replicas: rng.int(1, 3),
		zones: [rng.pick(ZONES)],
		enabled: true,
		instance_type: rng.pick(TYPES)
	};
	const sources: Source[] = [];
	const src = (kind: Source['kind'], file: string | null, names: readonly VarName[], cli: number | null = null) =>
		sources.push({ kind, file, values: values(rng, names), cli });
	src('tfvars', 'terraform.tfvars', some(rng, 1, 2));
	if (classId === 'auto-order') {
		const shared = rng.pick(VARS);
		for (const name of autoNames(rng, rng.int(2, 3))) src('auto', name, [...new Set([shared, ...some(rng, 0, 1)])]);
		if (rng.bool(0.5)) src('var', null, some(rng, 1, 1), 0);
	}
	if (classId === 'cli-order') {
		const shared = rng.pick(VARS);
		const kinds = rng
			.shuffle(['file', 'var', rng.pick(['file', 'var'] as const), 'file'] as const)
			.slice(0, rng.int(3, 4));
		const fileNames = rng.sample(['prod.tfvars', 'override.tfvars', 'scale.tfvars', 'eu.tfvars'], 4);
		kinds.forEach((kind, i) => {
			const names = kind === 'var' ? [shared] : [...new Set([shared, ...some(rng, 0, 1)])];
			src(kind, kind === 'file' ? (fileNames[i] ?? 'x.tfvars') : null, names, i);
		});
		if (rng.bool(0.4)) src('auto', autoNames(rng, 2)[0] ?? '1-a.auto.tfvars', some(rng, 1, 1));
	}
	if (classId === 'env-lowest' || classId === 'count-off') {
		src('env', null, some(rng, 2, 3));
		src('file', rng.pick(['staging.tfvars', 'dev.tfvars', 'test.tfvars']), some(rng, 1, 2));
		if (rng.bool(0.6)) src('auto', autoNames(rng, 2)[0] ?? '1-a.auto.tfvars', some(rng, 1, 1));
		if (classId === 'count-off') {
			const first = rng.pick(['file', 'var'] as const);
			const second = first === 'file' ? 'var' : 'file';
			src(first, first === 'file' ? 'prod.tfvars' : null, first === 'var' ? ['enabled'] : some(rng, 1, 2), 0);
			src(second, second === 'file' ? 'prod.tfvars' : null, second === 'var' ? ['enabled'] : some(rng, 1, 2), 1);
		} else if (rng.bool(0.5)) src('file', 'prod.tfvars', some(rng, 1, 2), 0);
	}
	return { defaults, sources };
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function hclValue(v: Val): string {
	if (Array.isArray(v)) return `[${v.map((x) => `"${x}"`).join(', ')}]`;
	if (typeof v === 'string') return `"${v}"`;
	return String(v);
}

function cliValue(v: Val): string {
	if (Array.isArray(v)) return `[${v.map((x) => `"${x}"`).join(',')}]`;
	return String(v);
}

function files(p: Params): string {
	const typeOf: Record<VarName, string> = {
		replicas: 'number',
		zones: 'list(string)',
		enabled: 'bool',
		instance_type: 'string'
	};
	const out = [
		'# ---- variables.tf',
		...VARS.flatMap((n) => [
			`variable "${n}" {`,
			`  type    = ${typeOf[n]}`,
			`  default = ${hclValue(p.defaults[n])}`,
			'}',
			''
		]),
		'# ---- main.tf',
		'resource "cloud_instance" "app" {',
		'  count         = var.enabled ? var.replicas * length(var.zones) : 0',
		'  instance_type = var.instance_type',
		'  zone          = var.zones[count.index % length(var.zones)]',
		'}'
	];
	const fileSources = p.sources.filter((s) => s.file !== null).sort((a, b) => lexical(a.file ?? '', b.file ?? ''));
	for (const s of fileSources) {
		out.push('', `# ---- ${s.file ?? ''}`);
		for (const n of VARS) if (s.values[n] !== undefined) out.push(`${n} = ${hclValue(s.values[n])}`);
	}
	return out.join('\n');
}

function command(p: Params): string {
	const parts = p.sources
		.filter((s) => s.cli !== null)
		.sort((a, b) => (a.cli ?? 0) - (b.cli ?? 0))
		.flatMap((s) =>
			s.kind === 'file'
				? [`-var-file=${s.file ?? ''}`]
				: VARS.filter((n) => s.values[n] !== undefined).map((n) => `-var='${n}=${cliValue(s.values[n] as Val)}'`)
		);
	return ['terraform apply', ...parts].join(' ');
}

function environment(p: Params): string[] {
	return p.sources
		.filter((s) => s.kind === 'env')
		.flatMap((s) =>
			VARS.filter((n) => s.values[n] !== undefined).map((n) => {
				const v = s.values[n] as Val;
				return `TF_VAR_${n}=${Array.isArray(v) ? `'${cliValue(v)}'` : cliValue(v)}`;
			})
		);
}

function describe(p: Params): string {
	const env = environment(p);
	return [
		'В каталоге конфигурации лежат файлы, показанные ниже (каждый начинается со строки-комментария с его именем). Других файлов `.tfvars` нет.',
		'',
		env.length ? 'Переменные окружения:' : 'Переменных окружения `TF_VAR_*` нет.',
		...(env.length ? ['', '```', ...env, '```'] : []),
		'',
		'Команда:',
		'',
		'```',
		command(p),
		'```',
		'',
		'Значение переменной берётся из источников по порядку; каждый следующий перекрывает предыдущие:',
		'',
		'1. `default` в блоке `variable`;',
		'2. переменные окружения `TF_VAR_<имя>`;',
		'3. файл `terraform.tfvars`;',
		'4. файлы `*.auto.tfvars` — по порядку имён, как строки (посимвольно);',
		'5. опции `-var` и `-var-file` — в том порядке, в каком они стоят в командной строке.',
		'',
		'Другие файлы `.tfvars` читаются, только если указаны в `-var-file`.',
		'',
		'Введите через пробел итоговые `replicas`, число зон в `zones`, `enabled`, `instance_type` (без кавычек) и сколько экземпляров `cloud_instance.app` создаст `count`. Например: `3 2 true s2.medium 6`.'
	].join('\n');
}

// An independent reference: parses the shown files, environment and command line and applies the order of the statement.
const PYTHON_REFERENCE = `import json, re, shlex

data = json.loads(input())

def parse(text):
    text = text.strip()
    if text.startswith("["):
        return re.findall(r'"([^"]*)"', text)
    if text in ("true", "false"):
        return text == "true"
    if re.fullmatch(r"\\d+", text):
        return int(text)
    return text.strip('"')

files = {}
current = None
for line in data["files"].split("\\n"):
    m = re.match(r"^# ---- (\\S+)$", line)
    if m:
        current = m.group(1)
        files[current] = line + "\\n"
    elif current:
        files[current] += line + "\\n"

values = {}
for name, default in re.findall(r'variable "(\\w+)" \\{[^}]*?default = ([^\\n]+)', files["variables.tf"]):
    values[name] = parse(default)

def tfvars(name):
    return {k: parse(v) for k, v in re.findall(r"^(\\w+) = (.+)$", files[name], re.M)}

for line in data["env"]:
    k, v = line.split("=", 1)
    values[k[len("TF_VAR_"):]] = parse(shlex.split(v)[0])
if "terraform.tfvars" in files:
    values.update(tfvars("terraform.tfvars"))
for name in sorted(n for n in files if n.endswith(".auto.tfvars")):
    values.update(tfvars(name))
for arg in shlex.split(data["command"])[2:]:
    if arg.startswith("-var-file="):
        values.update(tfvars(arg[len("-var-file="):]))
    elif arg.startswith("-var="):
        k, v = arg[len("-var="):].split("=", 1)
        values[k] = parse(v)
zones = len(values["zones"])
count = values["replicas"] * zones if values["enabled"] else 0
print(values["replicas"], zones, "true" if values["enabled"] else "false", values["instance_type"], count)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/auto-order': ['numeric-order', 'tfvars-over-auto'],
	'senior/cli-order': ['var-beats-var-file', 'first-wins'],
	'senior/env-lowest': ['env-highest', 'all-tfvars-loaded'],
	'senior/count-off': ['all-tfvars-loaded', 'var-beats-var-file']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = answerOf(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const source = files(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'hcl', source } },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ files: source, env: environment(p), command: command(p) })
			}),
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
