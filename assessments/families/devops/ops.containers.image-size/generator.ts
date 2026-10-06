// Size of a built image from the sizes of its layers: a file deleted in a later layer still weighs, one deleted in the
// same RUN does not, a rewritten or re-owned file is stored again; for a junior, a multi-stage build keeps only the
// final stage, its base and what `COPY --from` brings. The answer is the image size and the megabytes the container
// cannot see.
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

type Effect =
	| { op: 'create'; path: string; size: number }
	| { op: 'delete'; path: string }
	| { op: 'touch'; path: string; recursive: boolean };

interface Scenario {
	lines: string[];
	/** What every command of a RUN (split by `&&`) does to the file system. */
	effects: Record<string, Effect[]>;
	images: Record<string, number>;
	/** Items of the build context (a file or a whole folder) and their sizes in MB. */
	context: Record<string, number>;
}

interface Rules {
	rmShrinks: boolean;
	sameRunCounts: boolean;
	overwriteReplaces: boolean;
	chmodFree: boolean;
	countsBuilder: boolean;
	stageBaseFresh: boolean;
}

const RIGHT: Rules = {
	rmShrinks: false,
	sameRunCounts: false,
	overwriteReplaces: false,
	chmodFree: false,
	countsBuilder: false,
	stageBaseFresh: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'rm-shrinks': { rmShrinks: true },
	'same-run-counts': { sameRunCounts: true },
	'overwrite-replaces': { overwriteReplaces: true },
	'chmod-free': { chmodFree: true },
	'counts-builder': { countsBuilder: true },
	'stage-base-fresh': { stageBaseFresh: true }
};

function under(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

function resolve(workdir: string, path: string): string {
	const p = path.startsWith('/') ? path : `${workdir}/${path}`;
	const parts: string[] = [];
	for (const part of p.split('/')) {
		if (part === '' || part === '.') continue;
		parts.push(part);
	}
	return `/${parts.join('/')}`;
}

interface StageState {
	name: string | null;
	files: Map<string, number>;
	total: number;
	own: number;
	workdir: string;
}

function sum(values: Iterable<number>): number {
	let total = 0;
	for (const v of values) total += v;
	return total;
}

/** `<image size> <hidden MB>` under the given rules. */
function measure(s: Scenario, rules: Rules): string {
	const stages: StageState[] = [];
	let cur: StageState | null = null;
	for (const raw of s.lines) {
		const text = raw.trim();
		if (text === '' || text.startsWith('#')) continue;
		const [op = '', ...args] = text.split(/\s+/);
		const verb = op.toUpperCase();
		if (verb === 'FROM') {
			const [image = '', as, name] = args;
			const stageName = as?.toUpperCase() === 'AS' ? (name ?? null) : null;
			const parent = stages.find((st) => st.name === image);
			if (parent) {
				const visible = sum(parent.files.values());
				const total = rules.stageBaseFresh ? visible : parent.total;
				cur = { name: stageName, files: new Map(parent.files), total, own: 0, workdir: parent.workdir };
			} else {
				const size = s.images[image] ?? 0;
				cur = { name: stageName, files: new Map([[`<${image}>`, size]]), total: size, own: size, workdir: '/' };
			}
			stages.push(cur);
			continue;
		}
		if (!cur) continue;
		const state = cur;
		if (verb === 'WORKDIR') {
			state.workdir = resolve(state.workdir, args[0] ?? '/');
			continue;
		}
		const touched = new Map<string, number>();
		let extra = 0;
		const put = (path: string, size: number): void => {
			const old = state.files.get(path);
			if (rules.overwriteReplaces && old !== undefined && !touched.has(path)) extra -= old;
			state.files.set(path, size);
			touched.set(path, size);
		};
		if (verb === 'COPY' || verb === 'ADD') {
			const from = args.find((a) => a.startsWith('--from='))?.slice('--from='.length);
			const plain = args.filter((a) => !a.startsWith('--'));
			const dest = plain[plain.length - 1] ?? '.';
			const sources = plain.slice(0, -1);
			if (from !== undefined) {
				const source = stages.find((st) => st.name === from);
				if (!source) throw new Error(`no stage ${from}`);
				const target = resolve(state.workdir, dest);
				for (const src of sources) {
					const root = resolve(source.workdir, src);
					for (const [path, size] of source.files) {
						if (under(path, root)) put(target + path.slice(root.length), size);
					}
				}
			} else {
				const intoDir = dest === '.' || dest.endsWith('/');
				for (const src of sources) {
					const item = src.replace(/^\.\//, '').replace(/\/$/, '');
					if (item === '.' || item === '') {
						for (const [name, size] of Object.entries(s.context))
							put(resolve(resolve(state.workdir, dest), name), size);
					} else {
						const size = s.context[item];
						if (size === undefined) throw new Error(`no context item ${item}`);
						put(intoDir ? resolve(resolve(state.workdir, dest), item) : resolve(state.workdir, dest), size);
					}
				}
			}
		} else if (verb === 'RUN') {
			for (const command of args.join(' ').split(' && ')) {
				const effects = s.effects[command.trim()];
				if (!effects) throw new Error(`no effects for ${command}`);
				for (const e of effects) {
					if (e.op === 'create') put(e.path, e.size);
					else if (e.op === 'delete') {
						for (const [path, size] of [...state.files]) {
							if (!under(path, e.path)) continue;
							if (touched.has(path)) {
								touched.delete(path);
								if (rules.sameRunCounts) extra += size;
							} else if (rules.rmShrinks) extra -= size;
							state.files.delete(path);
						}
					} else if (!rules.chmodFree) {
						for (const [path, size] of state.files) if (under(path, e.path)) touched.set(path, size);
					}
				}
			}
		} else continue;
		const layer = sum(touched.values()) + extra;
		state.total += layer;
		state.own += layer;
	}
	const final = stages[stages.length - 1];
	if (!final) throw new Error('no stage');
	const size = rules.countsBuilder ? sum(stages.map((st) => st.own)) : final.total;
	const visible = sum(final.files.values());
	return `${size} ${size - visible}`;
}

// --- Scenarios -------------------------------------------------------------------------------------------------

interface Draft {
	lines: string[];
	effects: Record<string, Effect[]>;
	images: Record<string, number>;
	context: Record<string, number>;
}

function draft(): Draft {
	return { lines: [], effects: {}, images: {}, context: {} };
}

function run(d: Draft, commands: [string, Effect[]][]): void {
	for (const [cmd, effects] of commands) d.effects[cmd] = effects;
	d.lines.push(`RUN ${commands.map(([cmd]) => cmd).join(' && ')}`);
}

const COMMENTS = ['# syntax=docker/dockerfile:1', '# Образ API каталога', '# Собирается в CI'];

function aptInstall(rng: Rng, packages: string): [string, Effect[]][] {
	return [
		['apt-get update', [{ op: 'create', path: '/var/lib/apt/lists', size: rng.int(25, 60) }]],
		[
			`apt-get install -y --no-install-recommends ${packages}`,
			[{ op: 'create', path: '/usr/lib/gcc', size: rng.int(90, 240) }]
		]
	];
}

const RM_LISTS: [string, Effect[]] = ['rm -rf /var/lib/apt/lists/*', [{ op: 'delete', path: '/var/lib/apt/lists' }]];

/** Intern: one stage of Python or Node; the class decides where the cleanup goes and what is rewritten or re-owned. */
function internScenario(rng: Rng, classId: string): Draft {
	const d = draft();
	const node = rng.bool();
	d.lines.push(...rng.sample(COMMENTS, rng.int(0, 2)));
	const base = node
		? rng.pick(['node:22-bookworm-slim', 'node:20-bookworm-slim'])
		: rng.pick(['python:3.12-slim', 'python:3.13-slim']);
	d.images[base] = node ? rng.int(180, 260) : rng.int(110, 160);
	d.lines.push(`FROM ${base}`, 'WORKDIR /app');
	const sameRun = classId === 'rm-same' || (classId !== 'rm-later' && rng.bool());
	const laterRun = classId === 'rm-later' || (classId !== 'rm-same' && !sameRun && rng.bool());
	const apt = aptInstall(rng, node ? 'python3 make g++' : 'gcc libpq-dev');
	run(d, sameRun && rng.bool(0.7) ? [...apt, RM_LISTS] : apt);
	const deps = node ? '/app/node_modules' : '/usr/local/lib/python3/site-packages';
	const cache = node ? '/root/.npm' : '/root/.cache/pip';
	const depsSize = rng.int(60, 320);
	const cacheSize = rng.int(30, 140);
	d.lines.push(node ? 'COPY package.json package-lock.json ./' : 'COPY requirements.txt .');
	const install: [string, Effect[]] = node
		? [
				rng.pick(['npm ci --omit=dev', 'npm ci']),
				[
					{ op: 'create', path: deps, size: depsSize },
					{ op: 'create', path: cache, size: cacheSize }
				]
			]
		: [
				'pip install -r requirements.txt',
				[
					{ op: 'create', path: deps, size: depsSize },
					{ op: 'create', path: cache, size: cacheSize }
				]
			];
	const clean: [string, Effect[]] = node
		? ['npm cache clean --force', [{ op: 'delete', path: cache }]]
		: ['rm -rf /root/.cache/pip', [{ op: 'delete', path: cache }]];
	run(d, sameRun ? [install, clean] : [install]);
	if (laterRun) {
		const options: [string, Effect[]][][] = [
			[clean],
			[RM_LISTS],
			[['apt-get purge -y --auto-remove gcc', [{ op: 'delete', path: '/usr/lib/gcc' }]]]
		];
		for (const cmds of rng.sample(options, rng.int(1, 2))) run(d, cmds);
	}
	if (node) {
		d.context['package.json'] = 0;
		d.context['package-lock.json'] = 0;
		d.context.src = rng.int(3, 25);
		d.context.public = rng.int(5, 40);
	} else {
		d.context['requirements.txt'] = 0;
		d.context.app = rng.int(3, 25);
		d.context.fixtures = rng.int(5, 60);
	}
	if (classId === 'overwrite' || rng.bool(0.3)) {
		// A stale build output in the context: the build step writes the same folder again.
		const out = node ? 'dist' : 'static';
		d.context[out] = rng.int(8, 45);
		d.lines.push('COPY . .');
		const build: [string, Effect[]] = node
			? ['npm run build', [{ op: 'create', path: '/app/dist', size: rng.int(8, 45) }]]
			: ['python manage.py collectstatic --noinput', [{ op: 'create', path: '/app/static', size: rng.int(8, 45) }]];
		run(d, [build]);
	} else d.lines.push('COPY . .');
	if (classId === 'chmod' || (classId === 'overwrite' && rng.bool(0.3))) {
		const cmd = rng.pick(['chown -R 10001:10001 /app', 'chmod -R g=u /app', 'chown -R app:app /app']);
		run(d, [[cmd, [{ op: 'touch', path: '/app', recursive: true }]]]);
	}
	d.lines.push(
		...(rng.bool() ? ['USER 10001'] : []),
		node ? 'CMD ["node", "dist/server.js"]' : 'CMD ["gunicorn", "app.main:app"]'
	);
	return d;
}

/** Junior: two stages; the class decides what the final stage takes from the builder and how. */
function juniorScenario(rng: Rng, classId: string): Draft {
	const d = draft();
	const kind = rng.pick(['go', 'python', 'node'] as const);
	d.lines.push(...rng.sample(COMMENTS, rng.int(0, 2)));
	const finalOnBuilder = classId === 'final-base';
	if (kind === 'go') {
		const v = rng.pick(['1.22', '1.23']);
		d.images[`golang:${v}-bookworm`] = rng.int(780, 880);
		d.lines.push(`FROM golang:${v}-bookworm AS build`, 'WORKDIR /src', 'COPY go.mod go.sum ./');
		run(d, [['go mod download', [{ op: 'create', path: '/go/pkg/mod', size: rng.int(90, 420) }]]]);
		d.context['go.mod'] = 0;
		d.context['go.sum'] = 0;
		d.context.cmd = rng.int(1, 6);
		d.context.internal = rng.int(2, 12);
		d.context.testdata = rng.int(20, 120);
		d.lines.push('COPY . .');
		run(d, [
			[
				'CGO_ENABLED=0 go build -o /out/api ./cmd/api',
				[
					{ op: 'create', path: '/out/api', size: rng.int(12, 45) },
					{ op: 'create', path: '/root/.cache/go-build', size: rng.int(80, 320) }
				]
			]
		]);
		d.lines.push('');
		if (finalOnBuilder) {
			d.lines.push('FROM build AS runtime');
			run(d, [
				[
					'rm -rf /go/pkg/mod /root/.cache/go-build',
					[
						{ op: 'delete', path: '/go/pkg/mod' },
						{ op: 'delete', path: '/root/.cache/go-build' }
					]
				]
			]);
			d.lines.push('ENTRYPOINT ["/out/api"]');
			return d;
		}
		const runtime = rng.pick(['alpine:3.20', 'debian:12-slim']);
		d.images[runtime] = runtime.startsWith('alpine') ? rng.int(7, 9) : rng.int(70, 80);
		d.lines.push(`FROM ${runtime} AS runtime`);
		if (classId === 'copy-from-dir') {
			d.lines.push('COPY --from=build /src /app', 'COPY --from=build /out/api /usr/local/bin/api');
			run(d, [['rm -rf /app/testdata', [{ op: 'delete', path: '/app/testdata' }]]]);
		} else if (classId === 'chown-copy') {
			d.lines.push('COPY --from=build /out/api /usr/local/bin/api');
			run(d, [
				[
					rng.pick(['chmod 0755 /usr/local/bin/api', 'chown 65532:65532 /usr/local/bin/api']),
					[{ op: 'touch', path: '/usr/local/bin/api', recursive: false }]
				]
			]);
		} else d.lines.push('COPY --from=build /out/api /usr/local/bin/api');
		d.lines.push('USER 65532', 'ENTRYPOINT ["/usr/local/bin/api"]');
		return d;
	}
	if (kind === 'python') {
		const v = rng.pick(['3.12', '3.13']);
		d.images[`python:${v}`] = rng.int(980, 1060);
		d.lines.push(`FROM python:${v} AS builder`, 'WORKDIR /app');
		run(d, [...aptInstall(rng, 'build-essential'), ...(rng.bool() ? [RM_LISTS] : [])]);
		d.lines.push('COPY requirements.txt .');
		run(d, [
			[
				'pip install --prefix=/install -r requirements.txt',
				[
					{ op: 'create', path: '/install', size: rng.int(50, 260) },
					{ op: 'create', path: '/root/.cache/pip', size: rng.int(30, 150) }
				]
			]
		]);
		d.context['requirements.txt'] = 0;
		d.context.app = rng.int(3, 20);
		d.context.tests = rng.int(2, 15);
		d.context.data = rng.int(20, 110);
		d.lines.push('COPY . .', '');
		if (finalOnBuilder) {
			d.lines.push('FROM builder AS runtime');
			run(d, [
				['apt-get purge -y --auto-remove build-essential', [{ op: 'delete', path: '/usr/lib/gcc' }]],
				[
					'rm -rf /root/.cache/pip /app/tests /app/data',
					[
						{ op: 'delete', path: '/root/.cache/pip' },
						{ op: 'delete', path: '/app/tests' },
						{ op: 'delete', path: '/app/data' }
					]
				]
			]);
			d.lines.push('CMD ["python", "-m", "app"]');
			return d;
		}
		d.images[`python:${v}-slim`] = rng.int(110, 160);
		d.lines.push(`FROM python:${v}-slim AS runtime`, 'WORKDIR /app', 'COPY --from=builder /install /usr/local');
		if (classId === 'copy-from-dir') {
			d.lines.push('COPY --from=builder /app /app');
			run(d, [
				[
					'rm -rf /app/tests /app/data',
					[
						{ op: 'delete', path: '/app/tests' },
						{ op: 'delete', path: '/app/data' }
					]
				]
			]);
		} else if (classId === 'chown-copy') {
			d.lines.push('COPY --from=builder /app/app /app/app');
			run(d, [['chown -R 10001:10001 /app', [{ op: 'touch', path: '/app', recursive: true }]]]);
		} else
			d.lines.push(
				rng.pick(['COPY --from=builder /app/app /app/app', 'COPY --from=builder --chown=10001:10001 /app/app /app/app'])
			);
		d.lines.push('USER 10001', 'CMD ["python", "-m", "app"]');
		return d;
	}
	const v = rng.pick(['20', '22']);
	d.images[`node:${v}-bookworm`] = rng.int(1050, 1150);
	d.lines.push(`FROM node:${v}-bookworm AS build`, 'WORKDIR /app', 'COPY package.json package-lock.json ./');
	run(d, [
		[
			'npm ci',
			[
				{ op: 'create', path: '/app/node_modules', size: rng.int(250, 520) },
				{ op: 'create', path: '/root/.npm', size: rng.int(60, 200) }
			]
		]
	]);
	d.context['package.json'] = 0;
	d.context['package-lock.json'] = 0;
	d.context.src = rng.int(3, 20);
	d.context.test = rng.int(2, 15);
	d.lines.push('COPY . .');
	run(d, [['npm run build', [{ op: 'create', path: '/app/dist', size: rng.int(5, 40) }]]]);
	run(d, [
		[
			'npm prune --omit=dev',
			[
				{ op: 'delete', path: '/app/node_modules' },
				{ op: 'create', path: '/app/node_modules', size: rng.int(60, 200) }
			]
		]
	]);
	d.lines.push('');
	if (finalOnBuilder) {
		d.lines.push('FROM build AS runtime');
		run(d, [
			[
				'rm -rf /root/.npm /app/src /app/test',
				[
					{ op: 'delete', path: '/root/.npm' },
					{ op: 'delete', path: '/app/src' },
					{ op: 'delete', path: '/app/test' }
				]
			]
		]);
		d.lines.push('CMD ["node", "dist/server.js"]');
		return d;
	}
	d.images[`node:${v}-bookworm-slim`] = rng.int(190, 250);
	d.lines.push(`FROM node:${v}-bookworm-slim AS runtime`, 'WORKDIR /app');
	if (classId === 'copy-from-dir') {
		d.lines.push('COPY --from=build /app /app');
		run(d, [
			[
				'rm -rf /app/src /app/test',
				[
					{ op: 'delete', path: '/app/src' },
					{ op: 'delete', path: '/app/test' }
				]
			]
		]);
	} else {
		d.lines.push('COPY --from=build /app/node_modules ./node_modules', 'COPY --from=build /app/dist ./dist');
		if (classId === 'chown-copy')
			run(d, [['chown -R node:node /app', [{ op: 'touch', path: '/app', recursive: true }]]]);
	}
	d.lines.push('USER node', 'CMD ["node", "dist/server.js"]');
	return d;
}

// --- Statement -------------------------------------------------------------------------------------------------

function describeEffect(e: Effect): string {
	if (e.op === 'create') return `создаёт \`${e.path}\` (${e.size} МБ)`;
	if (e.op === 'delete') return `удаляет \`${e.path}\` со всем содержимым`;
	return `меняет владельца или права у \`${e.path}\`${e.recursive ? ' и всего содержимого' : ''}`;
}

function statement(s: Scenario, junior: boolean): string {
	const effects = Object.entries(s.effects).map(
		([cmd, list]) => `- \`${cmd}\` — ${list.map(describeEffect).join(', ')};`
	);
	return [
		'Образ собирают по `Dockerfile` ниже командой `docker build .` (без `--squash`). Исходные данные:',
		'',
		`- базовые образы: ${Object.entries(s.images)
			.map(([image, size]) => `\`${image}\` — ${size} МБ`)
			.join(', ')};`,
		`- контекст сборки (\`.dockerignore\` нет): ${Object.entries(s.context)
			.map(([item, size]) => `\`${item}\` — ${size} МБ`)
			.join(', ')} (папка считается одним целым).`,
		'',
		'Что делают команды в `RUN` (команды, соединённые `&&`, выполняются по очереди в одной инструкции):',
		'',
		...effects,
		'',
		'Правила подсчёта:',
		'',
		`1. Образ — это слои базового образа${junior ? ' итоговой стадии' : ''} и по одному слою на каждую инструкцию \`RUN\`, \`COPY\`, \`ADD\`${junior ? ' итоговой стадии' : ''}; остальные инструкции слоёв с данными не создают. Размер образа — сумма размеров всех его слоёв.`,
		'2. Слой хранит целиком каждый файл или папку, которые инструкция создала, перезаписала или у которых сменила владельца или права, — в состоянии на конец инструкции. Удаление того, что пришло из нижних слоёв, их не уменьшает: в новом слое остаётся только отметка об удалении (0 МБ). Созданное и удалённое в одной и той же инструкции в слой не попадает.',
		'3. `COPY` поверх существующего пути — это перезапись: новая версия в новом слое, старая остаётся в нижнем.',
		...(junior
			? [
					'4. В итоговый образ идёт только последняя стадия. Если она построена на другой стадии (`FROM build`), её база — все слои той стадии. `COPY --from=<стадия>` создаёт один слой с файлами в их состоянии в стадии-источнике; `--chown` в `COPY` меняет владельца в том же слое и ничего не добавляет.'
				]
			: []),
		'',
		'Найдите размер итогового образа и сколько мегабайт в нём занимают данные, которых не видно в файловой системе контейнера (удалённые или перезаписанные позже; размер образа минус размер видимых файлов, включая файлы базового образа).',
		'',
		'Введите два целых числа через пробел: размер образа в МБ и невидимые МБ. Например: `412 96`.'
	].join('\n');
}

// --- Reference ---------------------------------------------------------------------------------------------------

const PYTHON_REFERENCE = `import json

data = json.loads(input())
effects = data["effects"]
images = data["images"]
context = data["context"]


def norm(base, path):
    full = path if path.startswith("/") else base.rstrip("/") + "/" + path
    parts = [p for p in full.split("/") if p not in ("", ".")]
    return "/" + "/".join(parts)


def inside(path, root):
    return path == root or path.startswith(root + "/")


stages = []
for raw in data["dockerfile"].split("\\n"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    words = line.split()
    op = words[0].upper()
    if op == "FROM":
        name = words[3] if len(words) > 3 and words[2].upper() == "AS" else None
        parent = next((s for s in stages if s["name"] == words[1]), None)
        if parent is None:
            st = {"name": name, "fs": {"base:" + words[1]: images[words[1]]}, "layers": [images[words[1]]], "cwd": "/"}
        else:
            st = {"name": name, "fs": dict(parent["fs"]), "layers": list(parent["layers"]), "cwd": parent["cwd"]}
        stages.append(st)
        continue
    st = stages[-1]
    if op == "WORKDIR":
        st["cwd"] = norm(st["cwd"], words[1])
        continue
    if op not in ("RUN", "COPY", "ADD"):
        continue
    layer = {}
    if op == "RUN":
        for command in " ".join(words[1:]).split(" && "):
            for e in effects[command.strip()]:
                if e["op"] == "create":
                    st["fs"][e["path"]] = e["size"]
                    layer[e["path"]] = e["size"]
                elif e["op"] == "delete":
                    for p in [p for p in st["fs"] if inside(p, e["path"])]:
                        del st["fs"][p]
                        layer.pop(p, None)
                else:
                    for p, size in st["fs"].items():
                        if inside(p, e["path"]):
                            layer[p] = size
    else:
        source_stage = None
        plain = []
        for w in words[1:]:
            if w.startswith("--from="):
                source_stage = w.split("=", 1)[1]
            elif not w.startswith("--"):
                plain.append(w)
        dest = plain[-1]
        copied = {}
        if source_stage is not None:
            src_st = next(s for s in stages if s["name"] == source_stage)
            target = norm(st["cwd"], dest)
            for src in plain[:-1]:
                root = norm(src_st["cwd"], src)
                for p, size in src_st["fs"].items():
                    if inside(p, root):
                        copied[target + p[len(root):]] = size
        else:
            for src in plain[:-1]:
                item = src[2:] if src.startswith("./") else src
                item = item.rstrip("/")
                if item in (".", ""):
                    for name, size in context.items():
                        copied[norm(norm(st["cwd"], dest), name)] = size
                elif dest == "." or dest.endswith("/"):
                    copied[norm(norm(st["cwd"], dest), item)] = context[item]
                else:
                    copied[norm(st["cwd"], dest)] = context[item]
        for p, size in copied.items():
            st["fs"][p] = size
            layer[p] = size
    st["layers"].append(sum(layer.values()))

final = stages[-1]
size = sum(final["layers"])
print(size, size - sum(final["fs"].values()))
`;

// --- Build -------------------------------------------------------------------------------------------------------

const REQUIRED: Record<string, string[]> = {
	'intern/rm-later': ['rm-shrinks'],
	'intern/rm-same': ['same-run-counts'],
	'intern/overwrite': ['overwrite-replaces'],
	'intern/chmod': ['chmod-free'],
	'junior/builder-discard': ['counts-builder'],
	'junior/copy-from-dir': ['rm-shrinks', 'counts-builder'],
	'junior/final-base': ['stage-base-fresh', 'rm-shrinks'],
	'junior/chown-copy': ['chmod-free', 'counts-builder']
};

const LEVEL_WRONG: Record<string, string[]> = {
	intern: ['rm-shrinks', 'same-run-counts', 'overwrite-replaces', 'chmod-free'],
	junior: ['rm-shrinks', 'same-run-counts', 'chmod-free', 'counts-builder', 'stage-base-fresh']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	for (let tries = 0; tries < 200; tries += 1) {
		const s: Scenario = junior ? juniorScenario(rng, input.classId) : internScenario(rng, input.classId);
		const answer = measure(s, RIGHT);
		const allowed = LEVEL_WRONG[input.grade] ?? [];
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				if (!allowed.includes(id)) return [id, null];
				const value = measure(s, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const source = s.lines.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: statement(s, junior), code: { language: 'dockerfile', source } },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ dockerfile: source, effects: s.effects, images: s.images, context: s.context })
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
