// Build cache of a Dockerfile: after a stated change (a source file, the lock file, the text of a RUN, a build argument,
// a new digest of a base image), which RUN, COPY and ADD instructions run again instead of coming from the cache.
// Single stage for an intern; several stages, stage bases, `COPY --from` and a stage the target does not need for a
// junior.
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

/** What differs from the build whose layers are all in the cache. */
interface Change {
	files: string[];
	/** Lines of the shown Dockerfile whose text was edited, with the old text. */
	lines: { line: number; old: string }[];
	args: { name: string; old: string; value: string }[];
	/** Base images whose tag now points to a new digest. */
	images: string[];
}

interface Scenario {
	lines: string[];
	context: string[];
	change: Change;
}

/** How a solver applies the cache rules; the right solver has every switch on its documented value. */
interface Rules {
	chain: boolean;
	files: boolean;
	network: boolean;
	arg: 'use' | 'declaration' | 'ignore';
	stages: boolean;
	copyFrom: boolean;
	fromStage: boolean;
	onlyNeeded: boolean;
}

const RIGHT: Rules = {
	chain: true,
	files: true,
	network: false,
	arg: 'use',
	stages: true,
	copyFrom: true,
	fromStage: true,
	onlyNeeded: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'only-changed': { chain: false },
	'text-only': { files: false },
	'network-reruns': { network: true },
	'arg-at-declaration': { arg: 'declaration' },
	'arg-ignored': { arg: 'ignore' },
	'whole-file-after': { stages: false },
	'copy-from-cached': { copyFrom: false },
	'from-stage-cached': { fromStage: false },
	'unused-stage-built': { onlyNeeded: false }
};

const LAYER_OPS = new Set(['RUN', 'COPY', 'ADD']);
const NETWORK = /apt-get update|apk add|curl |wget /;

interface Instr {
	line: number;
	op: string;
	rest: string;
	text: string;
}

interface Stage {
	name: string | null;
	base: string;
	instrs: Instr[];
}

function parse(lines: readonly string[]): Stage[] {
	const stages: Stage[] = [];
	lines.forEach((raw, i) => {
		const text = raw.trim();
		if (text === '' || text.startsWith('#')) return;
		const [op = '', ...restParts] = text.split(/\s+/);
		const rest = restParts.join(' ');
		if (op.toUpperCase() === 'FROM') {
			const [base = '', as, name] = restParts;
			stages.push({ name: as?.toUpperCase() === 'AS' ? (name ?? null) : null, base, instrs: [] });
			return;
		}
		stages[stages.length - 1]?.instrs.push({ line: i + 1, op: op.toUpperCase(), rest, text });
	});
	return stages;
}

function stageIndex(stages: readonly Stage[], ref: string): number {
	const byName = stages.findIndex((s) => s.name === ref);
	if (byName >= 0) return byName;
	return /^\d+$/.test(ref) ? Number(ref) : -1;
}

function copyParts(rest: string): { from: string | null; sources: string[] } {
	const tokens = rest.split(/\s+/);
	const from = tokens.find((t) => t.startsWith('--from='))?.slice('--from='.length) ?? null;
	const plain = tokens.filter((t) => !t.startsWith('--'));
	return { from, sources: plain.slice(0, -1) };
}

function globRegex(pattern: string): RegExp {
	const body = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replaceAll('*', '[^/]*')
		.replaceAll('?', '[^/]');
	return new RegExp(`^${body}$`);
}

/** Whether a COPY source covers a file of the context: `.`, a directory, a glob or the file itself. */
function covers(source: string, file: string): boolean {
	const s = source.replace(/^\.\//, '').replace(/\/$/, '');
	if (s === '.' || s === '') return true;
	if (s.includes('*') || s.includes('?')) return globRegex(s).test(file);
	return file === s || file.startsWith(`${s}/`);
}

function mentions(text: string, name: string): boolean {
	return new RegExp(`\\$\\{?${name}\\b`).test(text);
}

/** Stages the last stage needs: its base stages and the sources of `COPY --from`, transitively. */
function neededStages(stages: readonly Stage[]): Set<number> {
	const needed = new Set<number>();
	const visit = (i: number): void => {
		if (i < 0 || needed.has(i)) return;
		needed.add(i);
		const stage = stages[i];
		if (!stage) return;
		visit(stageIndex(stages, stage.base));
		for (const ins of stage.instrs) {
			if (ins.op !== 'COPY' && ins.op !== 'ADD') continue;
			const { from } = copyParts(ins.rest);
			if (from !== null) visit(stageIndex(stages, from));
		}
	};
	visit(stages.length - 1);
	return needed;
}

/** Lines of the RUN, COPY and ADD instructions that run again, ascending. */
function rebuilt(s: Scenario, rules: Rules): number[] {
	const stages = parse(s.lines);
	const needed = neededStages(stages);
	const rerunStages = new Set<number>();
	const out: number[] = [];
	stages.forEach((stage, index) => {
		if (rules.onlyNeeded && rules.stages && !needed.has(index)) return;
		const baseStage = stageIndex(stages, stage.base);
		const baseInvalid =
			s.change.images.includes(stage.base) || (baseStage >= 0 && rerunStages.has(baseStage) && rules.fromStage);
		let invalid = baseInvalid;
		const changedArgs = new Set<string>();
		for (const ins of stage.instrs) {
			let direct = s.change.lines.some((l) => l.line === ins.line);
			if (ins.op === 'ARG') {
				const name = ins.rest.split('=')[0] ?? '';
				if (rules.arg !== 'ignore' && s.change.args.some((a) => a.name === name)) {
					changedArgs.add(name);
					if (rules.arg === 'declaration') direct = true;
				}
			} else if (
				rules.arg === 'use' &&
				changedArgs.size > 0 &&
				(ins.op === 'RUN' || [...changedArgs].some((n) => mentions(ins.text, n)))
			) {
				direct = true;
			}
			if (ins.op === 'COPY' || ins.op === 'ADD') {
				const { from, sources } = copyParts(ins.rest);
				if (from !== null) {
					if (rules.copyFrom && rerunStages.has(stageIndex(stages, from))) direct = true;
				} else if (rules.files && s.change.files.some((f) => sources.some((src) => covers(src, f)))) {
					direct = true;
				}
			}
			if (ins.op === 'RUN' && rules.network && NETWORK.test(ins.rest)) direct = true;
			let rerun: boolean;
			if (rules.chain) {
				invalid ||= direct;
				rerun = invalid;
			} else rerun = direct || baseInvalid;
			if (rerun && LAYER_OPS.has(ins.op)) {
				out.push(ins.line);
				rerunStages.add(index);
			}
		}
	});
	if (rules.stages) return out.sort((a, b) => a - b);
	// The file read as one chain: everything after the first instruction that runs again.
	const first = Math.min(...out);
	return stages
		.flatMap((st) => st.instrs)
		.filter((ins) => LAYER_OPS.has(ins.op) && ins.line >= first)
		.map((ins) => ins.line);
}

function answerOf(lines: number[]): string[] {
	return lines.length === 0 ? ['-'] : lines.map(String);
}

// --- Scenarios -------------------------------------------------------------------------------------------------

interface Archetype {
	bases: string[];
	workdir: string;
	manifests: string[];
	lock: string;
	install: string[];
	build: string[];
	sources: string[];
	sourceCopies: string[];
	others: string[];
	tail: string[];
	args: { name: string; values: string[] }[];
}

const HEX = '0123456789abcdef';
function sha(rng: Rng): string {
	return Array.from({ length: 7 }, () => HEX.charAt(rng.int(0, HEX.length - 1))).join('');
}

const NODE: Archetype = {
	bases: ['node:22-bookworm-slim', 'node:20-bookworm-slim', 'node:22-alpine'],
	workdir: '/app',
	manifests: ['package.json', 'package-lock.json'],
	lock: 'package-lock.json',
	install: ['npm ci --omit=dev', 'npm ci', 'npm ci --no-audit --no-fund'],
	build: ['npm run build', 'npm run build -- --sourcemap', 'npx tsc -p tsconfig.build.json'],
	sources: ['src/server.ts', 'src/routes/orders.ts', 'src/db/pool.ts', 'src/config.ts', 'public/index.html'],
	sourceCopies: ['COPY src ./src', 'COPY public ./public', 'COPY tsconfig.json tsconfig.build.json ./'],
	others: ['README.md', 'docker-compose.yml', 'tsconfig.json', 'tsconfig.build.json', '.eslintrc.json'],
	tail: ['EXPOSE 3000', 'USER node', 'CMD ["node", "dist/server.js"]'],
	args: [
		{ name: 'APP_VERSION', values: ['1.4.2', '1.5.0', '2.0.1', '2.1.0'] },
		{ name: 'GIT_SHA', values: [] }
	]
};

const PYTHON: Archetype = {
	bases: ['python:3.12-slim', 'python:3.13-slim', 'python:3.11-slim-bookworm'],
	workdir: '/srv',
	manifests: ['requirements.txt'],
	lock: 'requirements.txt',
	install: [
		'pip install --no-cache-dir -r requirements.txt',
		'pip install -r requirements.txt',
		'python -m pip install --no-cache-dir -r requirements.txt'
	],
	build: ['python -m compileall -q app', 'python -m app.collect_static', 'python -m compileall app'],
	sources: ['app/main.py', 'app/models.py', 'app/api/routes.py', 'app/settings.py', 'migrations/0007_orders.py'],
	sourceCopies: ['COPY app ./app', 'COPY migrations ./migrations', 'COPY gunicorn.conf.py ./'],
	others: ['README.md', 'Makefile', 'gunicorn.conf.py', 'pytest.ini', '.flake8'],
	tail: ['EXPOSE 8000', 'USER 10001', 'CMD ["gunicorn", "-c", "gunicorn.conf.py", "app.main:app"]'],
	args: [
		{ name: 'RELEASE', values: ['2026.10.1', '2026.10.2', '2026.11.0', '2026.9.4'] },
		{ name: 'BUILD_ID', values: [] }
	]
};

const GO: Archetype = {
	bases: ['golang:1.23-bookworm', 'golang:1.22-bookworm', 'golang:1.23-alpine'],
	workdir: '/src',
	manifests: ['go.mod', 'go.sum'],
	lock: 'go.sum',
	install: ['go mod download', 'go mod download -x', 'go mod download && go mod verify'],
	build: [
		'CGO_ENABLED=0 go build -o /usr/local/bin/api ./cmd/api',
		'go build -trimpath -o /usr/local/bin/api ./cmd/api',
		'go vet ./...'
	],
	sources: ['cmd/api/main.go', 'internal/store/orders.go', 'internal/http/router.go', 'internal/config/load.go'],
	sourceCopies: ['COPY cmd ./cmd', 'COPY internal ./internal', 'COPY configs ./configs'],
	others: ['README.md', 'Makefile', '.golangci.yml', 'configs/app.yaml', 'docs/api.md'],
	tail: ['EXPOSE 8080', 'USER 65532', 'ENTRYPOINT ["/usr/local/bin/api"]'],
	args: [
		{ name: 'VERSION', values: ['v1.8.0', 'v1.8.1', 'v1.9.0', 'v2.0.0'] },
		{ name: 'COMMIT', values: [] }
	]
};

function sysRun(rng: Rng, base: string): string {
	if (base.includes('alpine')) return `RUN apk add --no-cache ${rng.pick(['tini', 'curl', 'tzdata'])} ca-certificates`;
	return `RUN apt-get update && apt-get install -y --no-install-recommends ${rng.pick(['curl', 'tini', 'libpq5', 'dumb-init'])} ca-certificates`;
}

function argValues(rng: Rng, spec: { name: string; values: string[] }): [string, string] {
	if (spec.values.length >= 2) {
		const [a, b] = rng.sample(spec.values, 2);
		return [a ?? '', b ?? ''];
	}
	const a = sha(rng);
	let b = sha(rng);
	while (a === b) b = sha(rng);
	return [a, b];
}

const COMMENTS = [
	'# syntax=docker/dockerfile:1',
	'# Образ сервиса заказов',
	'# Собирается в CI на каждый коммит',
	'# Базовый образ закреплён по тегу'
];

/** One stage of an intern: the class decides the layout and the change. */
function internScenario(rng: Rng, classId: string): Scenario {
	const a = rng.pick([NODE, PYTHON, GO]);
	const base = rng.pick(a.bases);
	const lines: string[] = [...rng.sample(COMMENTS, rng.int(0, 3))];
	lines.push(`FROM ${base}`);
	lines.push(...rng.sample(['ENV TZ=Europe/Moscow', 'ENV LANG=C.UTF-8', 'LABEL team="platform"'], rng.int(0, 2)));
	const sys = sysRun(rng, base);
	lines.push(sys);
	if (rng.bool(0.4)) lines.push(rng.pick(['RUN useradd --system --uid 10001 app', 'RUN mkdir -p /var/cache/app']));
	if (rng.bool(0.4)) lines.push('');
	lines.push(`WORKDIR ${a.workdir}`);
	if (rng.bool(0.3))
		lines.push(rng.pick(['ENV PIP_DISABLE_PIP_VERSION_CHECK=1', 'ENV CI=true', 'ENV GOFLAGS=-mod=mod']));
	const install = `RUN ${rng.pick(a.install)}`;
	const build = rng.sample(a.build, rng.int(1, 2)).map((b) => `RUN ${b}`);
	const copySources = rng.bool(0.5)
		? ['COPY . .']
		: [a.sourceCopies[0] ?? 'COPY . .', ...rng.sample(a.sourceCopies.slice(1), rng.int(0, 2))];
	const change: Change = { files: [], lines: [], args: [], images: [] };
	const argSpec = rng.pick(a.args);
	const argPlacement = rng.int(0, 2);
	const arg = (): string[] => {
		const [old, value] = argValues(rng, argSpec);
		change.args.push({ name: argSpec.name, old, value });
		return [`ARG ${argSpec.name}`];
	};
	const label = `LABEL org.opencontainers.image.version=$${argSpec.name}`;
	if (classId === 'copy-all-early') {
		if (rng.bool(0.5)) lines.push('');
		lines.push('COPY . .', install);
		if (rng.bool(0.5)) lines.push(rng.pick(['ENV PATH=/app/bin:$PATH', 'ENV APP_ENV=production', '']));
		lines.push(...rng.sample(a.build, rng.int(1, 3)).map((b) => `RUN ${b}`));
	} else {
		if (classId === 'build-arg' && argPlacement !== 2) lines.push(...arg());
		lines.push(`COPY ${a.manifests.join(' ')} ./`);
		if (classId === 'build-arg' && argPlacement === 1) lines.push(label);
		lines.push(install);
		if (rng.bool(0.4)) lines.push('');
		if (classId === 'build-arg' && argPlacement === 2) lines.push(...arg());
		lines.push(...copySources, ...build);
		if (classId === 'build-arg' && argPlacement !== 1 && rng.bool(0.5)) lines.push(label);
	}
	if (rng.bool(0.4)) lines.push(rng.pick(['RUN mkdir -p /var/log/app', 'RUN rm -rf /tmp/*']));
	if (rng.bool(0.4)) lines.push('');
	const tail = a.tail.filter(() => rng.bool(0.6));
	const cmd = a.tail[a.tail.length - 1] ?? '';
	lines.push(...tail.filter((t) => t !== cmd), cmd);
	const context = [...a.manifests, ...a.sources, ...a.others];
	if (classId === 'copy-all-early') change.files.push(rng.pick(a.sources));
	else if (classId === 'lock-file') change.files.push(a.lock);
	else if (classId === 'run-text') {
		// Edit a RUN that has a layer instruction after it.
		const runs = lines
			.map((text, i) => ({ text, line: i + 1 }))
			.filter((l) => l.text.startsWith('RUN ') && lines.slice(l.line).some((t) => /^(RUN|COPY|ADD) /.test(t)));
		const target = rng.pick(runs);
		const old = target.text;
		const edited =
			old === sys
				? `${old.replace(' ca-certificates', '')} ${rng.pick(['jq', 'unzip', 'git', 'make'])} ca-certificates`
				: `${old} ${rng.pick(['--verbose', '--quiet', '--no-color', '--log-level=warn'])}`;
		lines[target.line - 1] = edited;
		change.lines.push({ line: target.line, old });
	}
	return { lines, context, change };
}

interface Template {
	lines: string[];
	context: string[];
	/** Files copied only by the build stages, the lock file, the first base image, files only an unused stage copies. */
	builderFiles: string[];
	lock: string;
	firstBase: string;
	unusedFiles: string[];
	hasUnused: boolean;
}

function nodeTemplate(rng: Rng, unused: boolean): Template {
	const v = rng.pick(['20', '22']);
	const lines: string[] = [
		...rng.sample(COMMENTS, rng.int(0, 2)),
		`FROM node:${v}-bookworm AS deps`,
		'WORKDIR /app',
		'COPY package.json package-lock.json ./',
		`RUN ${rng.pick(['npm ci', 'npm ci --no-audit'])}`,
		'',
		'FROM deps AS build',
		...(rng.bool() ? ['COPY tsconfig.json ./'] : []),
		'COPY src ./src',
		`RUN ${rng.pick(['npm run build', 'npx tsc -p tsconfig.json'])}`,
		...(rng.bool() ? ['RUN npm prune --omit=dev'] : []),
		''
	];
	if (unused)
		lines.push('FROM build AS test', 'COPY test ./test', `RUN ${rng.pick(['npm test', 'npx vitest run'])}`, '');
	lines.push(
		`FROM node:${v}-bookworm-slim AS runtime`,
		`RUN apt-get update && apt-get install -y --no-install-recommends ${rng.pick(['tini', 'dumb-init', 'curl'])}`,
		'WORKDIR /app',
		...(rng.bool() ? ['ENV NODE_ENV=production'] : []),
		'COPY --from=build /app/node_modules ./node_modules',
		'COPY --from=build /app/dist ./dist',
		...(rng.bool(0.6) ? ['COPY config ./config'] : []),
		'USER node',
		'CMD ["node", "dist/server.js"]'
	);
	return {
		lines,
		context: [
			'package.json',
			'package-lock.json',
			'tsconfig.json',
			'src/server.ts',
			'src/routes/orders.ts',
			'config/default.json',
			'test/orders.test.ts',
			'README.md'
		],
		builderFiles: ['src/server.ts', 'src/routes/orders.ts'],
		lock: 'package-lock.json',
		firstBase: `node:${v}-bookworm`,
		unusedFiles: ['test/orders.test.ts'],
		hasUnused: unused
	};
}

function goTemplate(rng: Rng, unused: boolean): Template {
	const v = rng.pick(['1.22', '1.23']);
	const lines: string[] = [
		...rng.sample(COMMENTS, rng.int(0, 2)),
		`FROM golang:${v}-bookworm AS build`,
		'WORKDIR /src',
		'COPY go.mod go.sum ./',
		'RUN go mod download',
		'COPY cmd ./cmd',
		'COPY internal ./internal',
		`RUN CGO_ENABLED=0 go build ${rng.pick(['', '-trimpath '])}-o /out/api ./cmd/api`,
		''
	];
	if (unused) lines.push('FROM build AS lint', 'COPY .golangci.yml ./', 'RUN golangci-lint run ./...', '');
	lines.push(
		`FROM ${rng.pick(['alpine:3.20', 'alpine:3.19'])} AS runtime`,
		`RUN apk add --no-cache ${rng.pick(['ca-certificates', 'tzdata', 'ca-certificates tzdata'])}`,
		...(rng.bool() ? ['WORKDIR /app'] : []),
		'COPY --from=build /out/api /usr/local/bin/api',
		...(rng.bool(0.6) ? ['COPY configs/app.yaml /etc/api/app.yaml'] : []),
		'USER 65532',
		'ENTRYPOINT ["/usr/local/bin/api"]'
	);
	return {
		lines,
		context: [
			'go.mod',
			'go.sum',
			'cmd/api/main.go',
			'internal/store/orders.go',
			'configs/app.yaml',
			'.golangci.yml',
			'README.md'
		],
		builderFiles: ['cmd/api/main.go', 'internal/store/orders.go'],
		lock: 'go.sum',
		firstBase: `golang:${v}-bookworm`,
		unusedFiles: ['.golangci.yml'],
		hasUnused: unused
	};
}

function pythonTemplate(rng: Rng, unused: boolean): Template {
	const v = rng.pick(['3.12', '3.13']);
	const lines: string[] = [
		...rng.sample(COMMENTS, rng.int(0, 2)),
		`FROM python:${v} AS builder`,
		'WORKDIR /app',
		'RUN python -m venv /opt/venv',
		'COPY requirements.txt .',
		'RUN /opt/venv/bin/pip install -r requirements.txt',
		'COPY app ./app',
		...(rng.bool() ? ['RUN /opt/venv/bin/python -m compileall -q app'] : []),
		''
	];
	if (unused)
		lines.push('FROM builder AS test', 'COPY tests ./tests', 'RUN /opt/venv/bin/python -m pytest -q tests', '');
	lines.push(
		`FROM python:${v}-slim AS runtime`,
		`RUN apt-get update && apt-get install -y --no-install-recommends ${rng.pick(['libpq5', 'libxml2', 'curl'])}`,
		'WORKDIR /app',
		'COPY --from=builder /opt/venv /opt/venv',
		'COPY --from=builder /app/app ./app',
		...(rng.bool(0.6) ? ['COPY gunicorn.conf.py ./'] : []),
		'USER 10001',
		'CMD ["/opt/venv/bin/gunicorn", "-c", "gunicorn.conf.py", "app.main:app"]'
	);
	return {
		lines,
		context: [
			'requirements.txt',
			'app/main.py',
			'app/models.py',
			'tests/test_orders.py',
			'gunicorn.conf.py',
			'README.md'
		],
		builderFiles: ['app/main.py', 'app/models.py'],
		lock: 'requirements.txt',
		firstBase: `python:${v}`,
		unusedFiles: ['tests/test_orders.py'],
		hasUnused: unused
	};
}

function juniorScenario(rng: Rng, classId: string): Scenario {
	const unused = classId === 'unused-stage' || rng.bool(0.3);
	const t = rng.pick([nodeTemplate, goTemplate, pythonTemplate])(rng, unused);
	const change: Change = { files: [], lines: [], args: [], images: [] };
	if (classId === 'builder-source') change.files.push(rng.pick(t.builderFiles));
	else if (classId === 'base-update') change.images.push(t.firstBase);
	else if (classId === 'deps-lock') change.files.push(t.lock);
	else change.files.push(rng.bool(0.08) ? rng.pick(t.unusedFiles) : rng.pick(t.builderFiles));
	return { lines: t.lines, context: t.context, change };
}

// --- Statement -------------------------------------------------------------------------------------------------

function describeChange(c: Change): string[] {
	const out: string[] = [];
	for (const f of c.files) out.push(`- изменилось содержимое файла \`${f}\`;`);
	for (const l of c.lines)
		out.push(`- в строке ${l.line} изменили текст инструкции; раньше она была такой: \`${l.old}\`;`);
	for (const a of c.args)
		out.push(
			`- сборка запускается с \`--build-arg ${a.name}=${a.value}\`, а прошлая шла с \`--build-arg ${a.name}=${a.old}\`;`
		);
	for (const i of c.images)
		out.push(`- в реестре обновился образ \`${i}\`: тот же тег указывает на новый дайджест, сборка берёт новый;`);
	out.push('- больше ничего не изменилось.');
	return out;
}

function statement(s: Scenario, junior: boolean): string {
	return [
		'Образ уже собирали, и все слои прошлой сборки лежат в кэше BuildKit. Ниже — `Dockerfile` в его нынешнем виде (номера строк — как в редакторе) и то, что изменилось с прошлой сборки:',
		'',
		...describeChange(s.change),
		'',
		`Файлы контекста сборки: ${s.context.map((f) => `\`${f}\``).join(', ')}. Файла \`.dockerignore\` нет. Сборка: \`docker build .\`${junior ? ' (цель — последняя стадия)' : ''}.`,
		'',
		'Правила кэша в этой задаче:',
		'',
		`1. Инструкции ${junior ? 'каждой стадии ' : ''}проверяются по порядку. Если кэш инструкции недействителен, все следующие за ней инструкции ${junior ? 'этой стадии ' : ''}тоже выполняются заново. Если изменился базовый образ (\`FROM\`), заново выполняется всё${junior ? ' в стадии' : ''}.`,
		'2. Кэш инструкции недействителен, если изменился её текст; для `COPY`/`ADD` — ещё и если изменилось содержимое хотя бы одного копируемого файла (источник `.` — весь контекст, папка — все файлы в ней). Для `RUN` проверяется только текст: что команда скачала бы из сети сейчас, кэш не проверяет.',
		'3. Новое значение `ARG` делает недействительным кэш первой после объявления `ARG` инструкции, которая этот аргумент использует: любой `RUN` (аргументы видны ему как переменные окружения) или инструкции, где он упомянут явно (`$NAME`, `${NAME}`). Само объявление `ARG` кэш не сбрасывает.',
		...(junior
			? [
					'4. Стадия, построенная на другой стадии (`FROM deps AS build`), выполняется заново целиком, если в базовой стадии заново выполнилась хотя бы одна инструкция `RUN`, `COPY` или `ADD`.',
					'5. `COPY --from=<стадия>` выполняется заново, если в стадии-источнике заново выполнилась хотя бы одна инструкция `RUN`, `COPY` или `ADD` (считаем, что её файлы изменились); иначе её проверяют по правилам 1–2.',
					'6. BuildKit собирает только стадии, нужные последней: на которые она ссылается через `FROM` или `COPY --from` — прямо или через другие стадии. Остальные стадии не выполняются вовсе.'
				]
			: []),
		'',
		'Введите номера строк с инструкциями `RUN`, `COPY` и `ADD`, которые в этой сборке выполнятся заново (не возьмутся из кэша), по возрастанию, по одному в строке. Если таких нет — одна строка `-`. Например:',
		'',
		'```',
		'6',
		'7',
		'9',
		'```'
	].join('\n');
}

// --- Reference ---------------------------------------------------------------------------------------------------

const PYTHON_REFERENCE = `import json
import re

data = json.loads(input())
lines = data["dockerfile"].split("\\n")
change = data["change"]

stages = []
for number, raw in enumerate(lines, start=1):
    text = raw.strip()
    if not text or text.startswith("#"):
        continue
    words = text.split()
    op = words[0].upper()
    if op == "FROM":
        name = words[3] if len(words) >= 4 and words[2].upper() == "AS" else None
        stages.append({"name": name, "base": words[1], "items": []})
    else:
        stages[-1]["items"].append((number, op, words[1:], text))


def find_stage(ref):
    for i, st in enumerate(stages):
        if st["name"] == ref:
            return i
    return int(ref) if ref.isdigit() else None


def split_copy(args):
    source_stage = None
    plain = []
    for a in args:
        if a.startswith("--from="):
            source_stage = a[len("--from="):]
        elif not a.startswith("--"):
            plain.append(a)
    return source_stage, plain[:-1]


def pattern_matches(pattern, path):
    regex = ""
    for ch in pattern:
        if ch == "*":
            regex += "[^/]*"
        elif ch == "?":
            regex += "[^/]"
        else:
            regex += re.escape(ch)
    return re.fullmatch(regex, path) is not None


def copied(source, path):
    if source.startswith("./"):
        source = source[2:]
    source = source.rstrip("/")
    if source in (".", ""):
        return True
    if "*" in source or "?" in source:
        return pattern_matches(source, path)
    return path == source or path.startswith(source + "/")


needed = set()
todo = [len(stages) - 1]
while todo:
    i = todo.pop()
    if i is None or i in needed:
        continue
    needed.add(i)
    refs = [stages[i]["base"]]
    for number, op, args, text in stages[i]["items"]:
        if op in ("COPY", "ADD"):
            src_stage, _ = split_copy(args)
            if src_stage is not None:
                refs.append(src_stage)
    for ref in refs:
        j = find_stage(ref)
        if j is not None:
            todo.append(j)

changed_args = {a["name"] for a in change["args"]}
edited = {l["line"] for l in change["lines"]}
rerun_stages = set()
result = []
for i, st in enumerate(stages):
    if i not in needed:
        continue
    base = find_stage(st["base"])
    broken = st["base"] in change["images"] or (base is not None and base in rerun_stages)
    declared = set()
    for number, op, args, text in st["items"]:
        stale = number in edited
        if op == "ARG":
            name = args[0].split("=")[0]
            if name in changed_args:
                declared.add(name)
        elif declared and (op == "RUN" or any(re.search(r"\\$\\{?" + n + r"\\b", text) for n in declared)):
            stale = True
        if op in ("COPY", "ADD"):
            src_stage, sources = split_copy(args)
            if src_stage is not None:
                if find_stage(src_stage) in rerun_stages:
                    stale = True
            elif any(copied(s, f) for s in sources for f in change["files"]):
                stale = True
        broken = broken or stale
        if broken and op in ("RUN", "COPY", "ADD"):
            result.append(number)
            rerun_stages.add(i)
print("\\n".join(str(n) for n in sorted(result)) if result else "-")
`;

// --- Build -------------------------------------------------------------------------------------------------------

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/copy-all-early': ['only-changed', 'text-only', 'network-reruns'],
	'intern/lock-file': ['only-changed', 'text-only', 'network-reruns'],
	'intern/run-text': ['only-changed'],
	'intern/build-arg': ['arg-at-declaration', 'arg-ignored'],
	'junior/builder-source': ['whole-file-after', 'copy-from-cached'],
	'junior/base-update': ['whole-file-after', 'copy-from-cached'],
	'junior/deps-lock': ['whole-file-after', 'only-changed'],
	'junior/unused-stage': ['unused-stage-built']
};

/** Misconceptions about rules the level does not involve are not probed there. */
const LEVEL_WRONG: Record<string, string[]> = {
	intern: ['only-changed', 'text-only', 'network-reruns', 'arg-at-declaration', 'arg-ignored'],
	junior: [
		'only-changed',
		'text-only',
		'whole-file-after',
		'copy-from-cached',
		'from-stage-cached',
		'unused-stage-built'
	]
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	for (let tries = 0; tries < 200; tries += 1) {
		const s = junior ? juniorScenario(rng, input.classId) : internScenario(rng, input.classId);
		const answer = answerOf(rebuilt(s, RIGHT));
		const same = (value: string[]): boolean => value.length === answer.length && value.every((v, i) => v === answer[i]);
		const allowed = LEVEL_WRONG[input.grade] ?? [];
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				if (!allowed.includes(id)) return [id, null];
				const value = answerOf(rebuilt(s, { ...RIGHT, ...change }));
				return [id, same(value) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: statement(s, junior),
				code: { language: 'dockerfile', source: s.lines.join('\n') }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ dockerfile: s.lines.join('\n'), change: s.change })
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
