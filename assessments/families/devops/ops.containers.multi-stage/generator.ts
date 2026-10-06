// Multi-stage builds with `--target`: which stages BuildKit builds (the target and what it depends on through FROM and
// COPY --from, by name or by index) and which files end up in the target image. For a middle, build arguments decide:
// a global ARG is seen only by FROM, inside a stage only after its own ARG, and --build-arg beats every default.
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

interface Scenario {
	lines: string[];
	target: string;
	buildArgs: Record<string, string>;
}

interface Rules {
	legacy: boolean;
	targetIgnored: boolean;
	indexFromOne: boolean;
	fromStageFresh: boolean;
	depsFiles: boolean;
	globalVisible: boolean;
	redeclaredEmpty: boolean;
	buildArgIgnored: boolean;
	stageDefaultWins: boolean;
}

const RIGHT: Rules = {
	legacy: false,
	targetIgnored: false,
	indexFromOne: false,
	fromStageFresh: false,
	depsFiles: false,
	globalVisible: false,
	redeclaredEmpty: false,
	buildArgIgnored: false,
	stageDefaultWins: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'builds-all-before-target': { legacy: true },
	'target-ignored': { targetIgnored: true },
	'index-from-one': { indexFromOne: true },
	'from-stage-fresh': { fromStageFresh: true },
	'files-of-all-stages': { depsFiles: true },
	'global-arg-visible': { globalVisible: true },
	'redeclared-arg-empty': { redeclaredEmpty: true },
	'build-arg-ignored': { buildArgIgnored: true },
	'stage-default-wins': { stageDefaultWins: true }
};

interface StageDef {
	base: string;
	name: string;
	body: string[];
}

function expand(text: string, scope: ReadonlyMap<string, string>): string {
	return text.replace(
		/\$\{(\w+)\}|\$(\w+)/g,
		(_, a: string | undefined, b: string | undefined) => scope.get(a ?? b ?? '') ?? ''
	);
}

const OUTPUT = /(?:-o |-O |--outfile=|> ?)(\S+)/;

/** `<stage names built>` and `<files of the target>` under the rules, as one set of lines. */
function evaluate(s: Scenario, rules: Rules): string[] {
	const buildArgs = rules.buildArgIgnored ? {} : s.buildArgs;
	const globals = new Map<string, string>();
	const stages: StageDef[] = [];
	for (const raw of s.lines) {
		const text = raw.trim();
		if (text === '' || text.startsWith('#')) continue;
		const [op = '', ...rest] = text.split(/\s+/);
		if (op === 'FROM') {
			stages.push({ base: rest[0] ?? '', name: rest[2] ?? String(stages.length), body: [] });
		} else if (stages.length === 0 && op === 'ARG') {
			const [name = '', value = ''] = (rest[0] ?? '').split('=');
			globals.set(name, buildArgs[name] ?? value);
		} else stages[stages.length - 1]?.body.push(text);
	}
	const indexOf = (ref: string): number => {
		const byName = stages.findIndex((st) => st.name === ref);
		if (byName >= 0) return byName;
		if (/^\d+$/.test(ref)) return Number(ref) - (rules.indexFromOne ? 1 : 0);
		return -1;
	};
	// Bases after the global arguments are substituted.
	const bases = stages.map((st) => expand(st.base, globals));
	const deps = stages.map((st, i) => {
		const out: number[] = [];
		const base = indexOf(bases[i] ?? '');
		if (base >= 0 && base < i) out.push(base);
		for (const line of st.body) {
			const from = line.match(/--from=(\S+)/)?.[1];
			if (from !== undefined) {
				const j = indexOf(from);
				if (j >= 0 && j < i) out.push(j);
			}
		}
		return out;
	});
	const target = rules.targetIgnored ? stages.length - 1 : stages.findIndex((st) => st.name === s.target);
	const built = new Set<number>();
	const visit = (i: number): void => {
		if (built.has(i)) return;
		built.add(i);
		for (const j of deps[i] ?? []) visit(j);
	};
	if (rules.legacy) for (let i = 0; i <= target; i += 1) built.add(i);
	else visit(target);
	// Files of every stage, in order.
	const files: Set<string>[] = [];
	stages.forEach((st, i) => {
		const own = new Set<string>();
		const base = indexOf(bases[i] ?? '');
		if (base >= 0 && base < i && !rules.fromStageFresh) for (const f of files[base] ?? []) own.add(f);
		const scope = new Map<string, string>();
		if (rules.globalVisible) for (const [k, v] of globals) scope.set(k, v);
		for (const line of st.body) {
			const [op = '', ...rest] = line.split(/\s+/);
			if (op === 'ARG') {
				const [name = '', value] = (rest[0] ?? '').split('=');
				if (value !== undefined) scope.set(name, rules.stageDefaultWins ? value : (buildArgs[name] ?? value));
				else
					scope.set(
						name,
						rules.redeclaredEmpty ? (buildArgs[name] ?? '') : (globals.get(name) ?? buildArgs[name] ?? '')
					);
			} else if (op === 'RUN') {
				const m = expand(line, scope).match(OUTPUT);
				if (m?.[1]) own.add(m[1]);
			} else if (op === 'COPY') {
				const words = expand(line, scope).split(/\s+/).slice(1);
				const from = words.find((w) => w.startsWith('--from='))?.slice('--from='.length);
				const plain = words.filter((w) => !w.startsWith('--'));
				const dest = plain[plain.length - 1] ?? '/';
				const j = from === undefined ? -1 : indexOf(from);
				const source = files[j] ?? new Set<string>();
				for (const src of plain.slice(0, -1)) {
					if (src.endsWith('/')) {
						for (const f of source) if (f.startsWith(src)) own.add(dest + f.slice(src.length));
					} else if (source.has(src)) own.add(dest + src.slice(src.lastIndexOf('/') + 1));
				}
			}
		}
		files.push(own);
	});
	const out = new Set<string>();
	for (const i of built) out.add(stages[i]?.name ?? '');
	if (rules.depsFiles) for (const i of built) for (const f of files[i] ?? []) out.add(f);
	else for (const f of files[target] ?? []) out.add(f);
	return [...out].sort();
}

// --- Scenarios -------------------------------------------------------------------------------------------------

const BUILD = ['build', 'builder', 'compile'];
const TEST = ['test', 'check', 'verify'];
const TOOLS = ['tools', 'debug', 'lint'];
const ASSETS = ['assets', 'web', 'frontend'];
const FINAL = ['runtime', 'final', 'prod', 'app'];
const BINS = ['api', 'server', 'worker', 'gateway', 'billing', 'notifier', 'indexer', 'scheduler'];

function names(rng: Rng): { build: string; test: string; tools: string; assets: string; final: string } {
	return {
		build: rng.pick(BUILD),
		test: rng.pick(TEST),
		tools: rng.pick(TOOLS),
		assets: rng.pick(ASSETS),
		final: rng.pick(FINAL)
	};
}

function juniorScenario(rng: Rng, classId: string): Scenario {
	const n = names(rng);
	const [bin1 = 'api', bin2 = 'worker'] = rng.sample(BINS, 2);
	const report = `/src/${rng.pick(['unit', 'go-test', 'junit'])}-report.txt`;
	const stages: StageDef[] = [];
	const goV = rng.pick(['1.22', '1.23']);
	stages.push({
		base: `golang:${goV}`,
		name: n.build,
		body: [
			'WORKDIR /src',
			'COPY . .',
			`RUN go build -o /out/${bin1} ./cmd/${bin1}`,
			...(rng.bool(0.7) ? [`RUN go build -o /out/${bin2} ./cmd/${bin2}`] : [])
		]
	});
	const withAssets = rng.bool(0.6) || classId === 'copy-from-index';
	if (withAssets)
		stages.push({
			base: rng.pick(['node:22', 'node:20']),
			name: n.assets,
			body: [
				'WORKDIR /web',
				'COPY web/ .',
				`RUN npx esbuild src/main.ts --bundle --outfile=/web/dist/${rng.pick(['app', 'main', 'bundle'])}.js`
			]
		});
	stages.push({ base: n.build, name: n.test, body: [`RUN go test ./... > ${report}`] });
	const withTools = classId === 'unused-before' || rng.bool(0.5);
	const probe = rng.pick(['grpc-health-probe', 'wait-for', 'migrate']);
	if (withTools)
		stages.push({
			base: rng.pick(['alpine:3.20', 'curlimages/curl:8.10.1']),
			name: n.tools,
			body: [`RUN wget -O /usr/local/bin/${probe} https://downloads.example.com/${probe}`]
		});
	// A stage with defaults the final stage may be built on.
	const withBase = classId === 'from-stage-chain' || rng.bool(0.3);
	const baseName = rng.pick(['base', 'common', 'os']);
	if (withBase)
		stages.push({
			base: rng.pick(['alpine:3.20', 'debian:12-slim']),
			name: baseName,
			body: [`RUN echo "tz=UTC" > /etc/${rng.pick(['defaults', 'base', 'common'])}.conf`]
		});
	const finalBody: string[] = [];
	const byIndex = classId === 'copy-from-index' || rng.bool(0.25);
	const ref = (name: string): string => (byIndex ? String(stages.findIndex((st) => st.name === name)) : name);
	finalBody.push(`COPY --from=${ref(n.build)} /out/${bin1} /usr/local/bin/`);
	if (withAssets && rng.bool(0.8)) finalBody.push(`COPY --from=${ref(n.assets)} /web/dist/ /srv/www/`);
	if (withTools && classId !== 'unused-before' && rng.bool(0.5))
		finalBody.push(`COPY --from=${ref(n.tools)} /usr/local/bin/${probe} /usr/local/bin/`);
	finalBody.push(`RUN echo ok > /etc/${n.final}.ready`);
	stages.push({
		base: withBase && rng.bool(0.8) ? baseName : rng.pick(['alpine:3.20', 'gcr.io/distroless/static-debian12']),
		name: n.final,
		body: finalBody
	});
	let target = n.final;
	if (classId === 'target-mid') target = rng.bool(0.6) ? n.test : withAssets ? n.assets : n.test;
	else if (classId === 'from-stage-chain' && rng.bool(0.3)) target = n.test;
	return { lines: render([], stages), target, buildArgs: {} };
}

function render(globals: string[], stages: StageDef[]): string[] {
	const lines = [...globals];
	if (globals.length) lines.push('');
	stages.forEach((st, i) => {
		if (i > 0) lines.push('');
		lines.push(`FROM ${st.base} AS ${st.name}`, ...st.body);
	});
	return lines;
}

function middleScenario(rng: Rng, classId: string): Scenario {
	const n = names(rng);
	const [app = 'api', other = 'worker', third = 'gateway'] = rng.sample(BINS, 3);
	const flavors = rng.pick([
		['slim', 'full'],
		['alpine', 'debian'],
		['minimal', 'debug']
	] as const);
	const flavor = rng.pick([...flavors]);
	const globals = [`ARG GO_VERSION=${rng.pick(['1.22', '1.23'])}`, `ARG APP=${app}`, `ARG FLAVOR=${flavor}`];
	const buildArgs: Record<string, string> = {};
	const stages: StageDef[] = [];
	stages.push({
		base: 'golang:${GO_VERSION}',
		name: n.build,
		body: [
			'WORKDIR /src',
			'COPY . .',
			'ARG APP',
			'RUN go build -o /out/${APP} ./cmd/${APP}',
			`RUN go build -o /out/${other} ./cmd/${other}`,
			`RUN go build -o /out/${third} ./cmd/${third}`
		]
	});
	// Which binary the runtime stages copy, and how APP reaches them.
	const appLine =
		classId === 'arg-not-redeclared'
			? []
			: classId === 'stage-default'
				? [`ARG APP=${third}`]
				: classId === 'arg-redeclared'
					? ['ARG APP']
					: rng.pick([['ARG APP'], [], [`ARG APP=${third}`]]);
	const runtimeA = `runtime-${flavors[0]}`;
	const runtimeB = `runtime-${flavors[1]}`;
	const copyBin = 'COPY --from=' + n.build + ' /out/${APP} /usr/local/bin/';
	stages.push({
		base: rng.pick(['alpine:3.20', 'gcr.io/distroless/static-debian12']),
		name: runtimeA,
		body: [...appLine, copyBin]
	});
	stages.push({
		base: rng.pick(['debian:12-slim', 'ubuntu:24.04']),
		name: runtimeB,
		body: [...appLine, copyBin, `RUN echo "debug=1" > /etc/${rng.pick(['app', 'svc'])}-debug.conf`]
	});
	if (rng.bool(0.5))
		stages.push({
			base: n.build,
			name: n.test,
			body: [`RUN go test ./... > /src/${rng.pick(['unit', 'junit'])}-report.txt`]
		});
	stages.push({
		base: 'runtime-${FLAVOR}',
		name: n.final,
		body: [`RUN echo ok > /etc/${n.final}.ready`]
	});
	if (classId === 'global-arg-from') buildArgs.FLAVOR = flavors.find((f) => f !== flavor) ?? flavor;
	else if (rng.bool(0.4)) buildArgs.FLAVOR = rng.pick([...flavors]);
	if (classId === 'stage-default' || (classId !== 'arg-redeclared' && rng.bool(0.4)))
		buildArgs.APP = rng.pick(BINS.filter((b) => b !== app && b !== other && b !== third));
	const target = rng.bool(0.8) || classId === 'global-arg-from' ? n.final : rng.pick([runtimeA, runtimeB]);
	return { lines: render(globals, stages), target, buildArgs };
}

// --- Statement -------------------------------------------------------------------------------------------------

function command(s: Scenario): string {
	const args = Object.entries(s.buildArgs).map(([k, v]) => ` --build-arg ${k}=${v}`);
	return `docker build --target ${s.target}${args.join('')} .`;
}

function statement(s: Scenario, candidates: string[], middle: boolean): string {
	return [
		`Образ собирают командой \`${command(s)}\` (BuildKit) по \`Dockerfile\` ниже.`,
		'',
		'Правила:',
		'',
		'1. Собирается целевая стадия и только те стадии, от которых она зависит: её база (`FROM <стадия>`) и источники `COPY --from` — прямо или через другие стадии. Стадию называют по имени (`AS имя`) или по номеру: стадии нумеруются с 0 в порядке `FROM`.',
		'2. `FROM <стадия>` начинает стадию со всех файлов той стадии; во внешних образах (`golang:…`, `alpine:…` и т. п.) файлов из списка ниже нет.',
		'3. Каждая `RUN` здесь создаёт ровно один файл — путь после `-o`, `-O`, `--outfile=` или `>`. Файлы, скопированные из контекста (`COPY . .`, `COPY web/ .`), в задаче не учитываются.',
		'4. `COPY --from=<стадия> <путь> <каталог>/` кладёт файл в каталог под тем же именем. Если путь кончается на `/`, копируются все файлы из этого каталога стадии-источника с сохранением вложенности.',
		...(middle
			? [
					'5. `ARG` до первого `FROM` — глобальный: его значение подставляется только в строки `FROM`. Внутри стадии переменная видна после `ARG ИМЯ` в этой же стадии: без значения она берёт значение глобального `ARG`, со значением (`ARG ИМЯ=…`) — своё. `--build-arg` важнее любого значения по умолчанию. Переменная, не объявленная в стадии, подставляется пустой строкой.'
				]
			: []),
		'',
		`Файлы, о которых идёт речь: ${candidates.map((c) => `\`${c}\``).join(', ')}.`,
		'',
		'Введите по одному в строке, в любом порядке: имена всех стадий, которые будут собраны (как в `AS`), и пути файлов из списка, которые окажутся в образе целевой стадии. Например:',
		'',
		'```',
		'build',
		'runtime',
		'/usr/local/bin/api',
		'```'
	].join('\n');
}

// --- Reference ---------------------------------------------------------------------------------------------------

const PYTHON_REFERENCE = `import json
import re

data = json.loads(input())
build_args = data["buildArgs"]

global_args = {}
stages = []
for raw in data["dockerfile"].split("\\n"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    words = line.split()
    if words[0] == "FROM":
        stages.append({"base": words[1], "name": words[3], "body": []})
    elif not stages and words[0] == "ARG":
        name, _, default = words[1].partition("=")
        global_args[name] = build_args.get(name, default)
    else:
        stages[-1]["body"].append(line)


def substitute(text, values):
    return re.sub(r"\\$\\{(\\w+)\\}|\\$(\\w+)", lambda m: values.get(m.group(1) or m.group(2), ""), text)


def stage_index(ref):
    for i, st in enumerate(stages):
        if st["name"] == ref:
            return i
    return int(ref) if ref.isdigit() else None


files = []
needs = []
for i, st in enumerate(stages):
    base = stage_index(substitute(st["base"], global_args))
    have = set(files[base]) if base is not None else set()
    deps = [base] if base is not None else []
    scope = {}
    for line in st["body"]:
        words = line.split()
        if words[0] == "ARG":
            name, eq, default = words[1].partition("=")
            if eq:
                scope[name] = build_args.get(name, default)
            else:
                scope[name] = global_args.get(name, build_args.get(name, ""))
        elif words[0] == "RUN":
            m = re.search(r"(?:-o |-O |--outfile=|> ?)(\\S+)", substitute(line, scope))
            if m:
                have.add(m.group(1))
        elif words[0] == "COPY":
            parts = substitute(line, scope).split()[1:]
            src_ref = next((p.split("=", 1)[1] for p in parts if p.startswith("--from=")), None)
            plain = [p for p in parts if not p.startswith("--")]
            if src_ref is None:
                continue
            j = stage_index(src_ref)
            deps.append(j)
            for src in plain[:-1]:
                for f in files[j]:
                    if src.endswith("/") and f.startswith(src):
                        have.add(plain[-1] + f[len(src):])
                    elif f == src:
                        have.add(plain[-1] + f.rsplit("/", 1)[1])
    files.append(have)
    needs.append(deps)

target = stage_index(data["target"])
built = set()
todo = [target]
while todo:
    i = todo.pop()
    if i in built:
        continue
    built.add(i)
    todo.extend(needs[i])
print("\\n".join(sorted({stages[i]["name"] for i in built} | files[target])))
`;

// --- Build -------------------------------------------------------------------------------------------------------

const REQUIRED: Record<string, string[]> = {
	'junior/target-mid': ['target-ignored'],
	'junior/copy-from-index': ['index-from-one'],
	'junior/from-stage-chain': ['from-stage-fresh'],
	'junior/unused-before': ['builds-all-before-target'],
	'middle/global-arg-from': ['build-arg-ignored'],
	'middle/arg-not-redeclared': ['global-arg-visible'],
	'middle/arg-redeclared': ['redeclared-arg-empty'],
	'middle/stage-default': ['stage-default-wins']
};

const LEVEL_WRONG: Record<string, string[]> = {
	junior: ['builds-all-before-target', 'target-ignored', 'index-from-one', 'from-stage-fresh', 'files-of-all-stages'],
	middle: [
		'builds-all-before-target',
		'files-of-all-stages',
		'global-arg-visible',
		'redeclared-arg-empty',
		'build-arg-ignored',
		'stage-default-wins'
	]
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const middle = input.grade === 'middle';
	for (let tries = 0; tries < 200; tries += 1) {
		const s = middle ? middleScenario(rng, input.classId) : juniorScenario(rng, input.classId);
		const answer = evaluate(s, RIGHT);
		const key = answer.join('\n');
		const allowed = LEVEL_WRONG[input.grade] ?? [];
		const variants = Object.entries(WRONG).map(([id, change]) => {
			const value = allowed.includes(id) ? evaluate(s, { ...RIGHT, ...change }) : null;
			return [id, value === null || value.join('\n') === key ? null : value] as const;
		});
		const wrong = Object.fromEntries(variants);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		// The list names every file any reading of the file could put somewhere.
		const everything = Object.values(WRONG).map((change) =>
			evaluate(s, { ...RIGHT, ...change, depsFiles: true, targetIgnored: true, legacy: true })
		);
		const candidates = [...new Set([...answer, ...variants.flatMap(([, v]) => v ?? []), ...everything.flat()])]
			.filter((x) => x.startsWith('/'))
			.sort();
		const source = s.lines.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: statement(s, candidates, middle), code: { language: 'dockerfile', source } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ dockerfile: source, target: s.target, buildArgs: s.buildArgs })
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
