// A Dockerfile and its specification (not root, listens on its port on every interface, dependencies cached across
// source edits, no secret in the final image, no compiler in the final image); exactly one line breaks the
// specification. The candidate names that line. One stage for an intern; several stages for a junior, where the
// defect hides in what a stage inherits or copies, in a build argument or in the exec form of CMD.
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

/** A line of a template: its role (for the defects and the wrong answers) and its text. */
type Line = [tag: string | null, text: string];

interface Spec {
	port: number;
	manifests: string[];
	install: string;
	secrets: string[];
	/** Junior: secret files the build stage copies on purpose — dependencies cannot be installed without them. */
	buildNeeds: string[];
	perBuild: string[];
}

interface Program {
	lines: Line[];
	spec: Spec;
}

interface Defect {
	tag: string;
	text: string;
	/** A line of the same requirement that is right as it is. */
	neighbour: string;
}

const COMMENTS = [
	'# Образ сервиса заказов.',
	'# Сборка: docker build --secret id=<секрет>,src=<файл> -t api .',
	'# Запуск: docker run -p <порт>:<порт> api',
	'# Поддерживает команда платформы.',
	'# Базовые образы обновляет Renovate.',
	'# Изменения согласовывать в канале #platform.',
	'# Секреты передаются только через --secret.'
];
const LABELS = ['LABEL team="platform"', 'LABEL tier="backend"', 'LABEL com.example.oncall="platform-duty"'];

const GLOBAL_ARGS = ['ARG APP_UID=10001', 'ARG REGISTRY=registry.example.com', 'ARG BASE_TAG=stable'];

/** Comments and global build arguments before the first FROM. */
function header(rng: Rng): Line[] {
	// The syntax directive is honoured only on the first line.
	const directive = rng.bool() ? ['# syntax=docker/dockerfile:1'] : [];
	// A uniform number of lines (not a sum of draws) spreads the line numbers of the defect.
	const total = rng.int(0, COMMENTS.length + GLOBAL_ARGS.length);
	const args = rng.int(Math.max(0, total - COMMENTS.length), Math.min(total, GLOBAL_ARGS.length));
	return [...directive, ...rng.sample(COMMENTS, total - args), ...rng.sample(GLOBAL_ARGS, args)].map((c): Line => [
		null,
		c
	]);
}

const FILLERS = [
	'',
	'',
	'',
	'# зависимости',
	'# исходники и сборка',
	'# запуск',
	'# см. docs/docker.md',
	'LABEL org.opencontainers.image.source="https://git.example.com/shop/api"',
	'ENV LANG=C.UTF-8',
	'ENV FEATURE_FLAGS=default'
];

/**
 * Lines that change nothing in the specification: they spread the line numbers. Each program draws them from its own
 * pool, so no line repeats.
 */
function fillers(rng: Rng): (max: number) => Line[] {
	const pool = rng.shuffle(FILLERS);
	return (max) => Array.from({ length: rng.int(0, max) }, (): Line => [null, pool.pop() ?? '']);
}

/** 0–2 preparation steps that change nothing in the specification. */
function setup(rng: Rng, steps: readonly string[]): Line[] {
	return rng.sample(steps, rng.int(0, steps.length)).map((t): Line => [null, t]);
}

/** EXPOSE, USER and an optional label in random order. */
function tail(rng: Rng, port: number, user: string): Line[] {
	const lines: Line[] = [
		['expose', `EXPOSE ${port}`],
		['user', user],
		...rng.sample(LABELS, rng.int(0, 3)).map((t): Line => [null, t]),
		...maybe(rng, 0.4, [[null, 'STOPSIGNAL SIGTERM'] as Line])
	];
	return rng.shuffle(lines);
}

const LABEL_POOL = [
	'LABEL org.opencontainers.image.title="api"',
	'LABEL org.opencontainers.image.description="HTTP API сервиса"',
	'LABEL org.opencontainers.image.vendor="shop"',
	'LABEL org.opencontainers.image.licenses="Apache-2.0"',
	'LABEL org.opencontainers.image.authors="platform@example.com"',
	'LABEL org.opencontainers.image.documentation="https://docs.example.com/api"',
	'LABEL org.opencontainers.image.url="https://shop.example.com"',
	'LABEL com.example.owner="platform"'
];
const ENV_POOL = [
	'TZ=UTC',
	'LC_ALL=C.UTF-8',
	'LOG_LEVEL=info',
	'APP_ENV=production',
	'METRICS_ENABLED=true',
	'TRACING_SAMPLE_RATE=0.1',
	'CACHE_TTL=300',
	'REQUEST_TIMEOUT=30'
];
const PACKAGES = [
	'curl',
	'tzdata',
	'libxml2',
	'locales',
	'netcat-openbsd',
	'gosu',
	'procps',
	'libjpeg62-turbo',
	'libffi8',
	'openssl',
	'less',
	'jq'
];

/**
 * A metadata block of 0–10 lines, uniform (it spreads the line numbers): labels and one ENV with one variable per
 * line.
 */
function metadata(rng: Rng): Line[] {
	const total = rng.int(0, 10);
	const labels = rng.int(Math.max(0, total - ENV_POOL.length), Math.min(total, LABEL_POOL.length));
	const vars = rng.sample(ENV_POOL, total - labels);
	const env = vars.map((v, i): Line => [null, `${i === 0 ? 'ENV ' : '    '}${v}${i < vars.length - 1 ? ' \\' : ''}`]);
	return [...rng.sample(LABEL_POOL, labels).map((t): Line => [null, t]), ...env];
}

/**
 * Installation of system packages: one line, or one package per line with continuations. The tag marks the line that
 * names the first package (the whole line in the one-line form).
 */
function aptBlock(rng: Rng, tag: string, first: string): Line[] {
	const packages = [first, ...rng.sample(PACKAGES, rng.int(0, 5))];
	if (rng.bool(0.15))
		return [
			[
				tag,
				`RUN apt-get update && apt-get install -y --no-install-recommends ${packages.join(' ')} && rm -rf /var/lib/apt/lists/*`
			]
		];
	return [
		[null, 'RUN apt-get update \\'],
		[null, '    && apt-get install -y --no-install-recommends \\'],
		...packages.map((p, i): Line => [i === 0 ? tag : null, `        ${p} \\`]),
		[null, '    && rm -rf /var/lib/apt/lists/*']
	];
}

function maybe(rng: Rng, p: number, lines: Line[]): Line[] {
	return rng.bool(p) ? lines : [];
}

// --- Intern: one stage ---------------------------------------------------------------------------------------

function internProgram(rng: Rng): Program {
	const fill = fillers(rng);
	// Labels and environment go either right after FROM or before the tail of the file.
	const meta = metadata(rng);
	const lateMeta = rng.bool();
	const port = rng.int(30, 90) * 100 + rng.pick([0, 0, 80]);
	const shellCmd = rng.bool(0.4);
	if (rng.bool()) {
		const v = rng.pick(['3.12', '3.13']);
		const lines: Line[] = [
			...header(rng),
			['from-final', `FROM python:${v}-slim`],
			...(lateMeta ? [] : meta),
			...maybe(rng, 0.5, [[null, 'ENV PYTHONDONTWRITEBYTECODE=1']]),
			...fill(6),
			['env-port', `ENV PORT=${port}`],
			...aptBlock(rng, 'apt', 'libpq5'),
			['useradd', 'RUN useradd --create-home --uid 10001 app'],
			...fill(3),
			[null, 'WORKDIR /app'],
			...setup(rng, ['RUN pip install --no-cache-dir --upgrade pip', 'RUN mkdir -p /app/data /app/logs']),
			['manifests', 'COPY requirements.txt ./'],
			[
				'install',
				'RUN --mount=type=secret,id=pipconf,target=/etc/pip.conf pip install --no-cache-dir -r requirements.txt'
			],
			...fill(3),
			['copy-all', 'COPY . .'],
			...rng
				.sample(
					[
						'RUN python -m compileall -q app',
						'RUN python manage.py collectstatic --noinput',
						'RUN mkdir -p /app/media'
					],
					rng.int(0, 3)
				)
				.map((t): Line => [null, t]),
			...fill(3),
			...(lateMeta ? meta : []),
			...tail(rng, port, 'USER app'),
			[
				'cmd',
				shellCmd
					? 'CMD uvicorn app.main:app --host 0.0.0.0 --port $PORT'
					: `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "${port}"]`
			]
		];
		return {
			lines,
			spec: {
				port,
				manifests: ['requirements.txt'],
				install: 'pip install',
				secrets: ['pip.conf'],
				buildNeeds: [],
				perBuild: []
			}
		};
	}
	const v = rng.pick(['20', '22']);
	const lines: Line[] = [
		...header(rng),
		['from-final', `FROM node:${v}-bookworm-slim`],
		...(lateMeta ? [] : meta),
		[null, 'ENV NODE_ENV=production'],
		...fill(6),
		['env-port', `ENV PORT=${port}`],
		...aptBlock(rng, 'apt', 'tini'),
		[null, 'WORKDIR /app'],
		...setup(rng, ['RUN corepack enable', 'RUN mkdir -p /app/data /app/logs']),
		['manifests', 'COPY package.json package-lock.json ./'],
		['install', 'RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci'],
		...fill(3),
		['copy-all', 'COPY . .'],
		[null, 'RUN npm run build'],
		...rng
			.sample(['RUN npm run generate:types', 'RUN mkdir -p /app/uploads', 'RUN npm run i18n:compile'], rng.int(0, 3))
			.map((t): Line => [null, t]),
		['useradd', 'RUN chown -R node:node /app'],
		...fill(3),
		...(lateMeta ? meta : []),
		...tail(rng, port, 'USER node'),
		[
			'cmd',
			shellCmd
				? 'CMD node dist/server.js --host 0.0.0.0 --port $PORT'
				: `CMD ["node", "dist/server.js", "--host", "0.0.0.0", "--port", "${port}"]`
		]
	];
	return {
		lines,
		spec: {
			port,
			manifests: ['package.json', 'package-lock.json'],
			install: 'npm ci',
			secrets: ['.npmrc'],
			buildNeeds: [],
			perBuild: []
		}
	};
}

function textOf(p: Program, tag: string): string {
	const line = p.lines.find(([t]) => t === tag);
	if (!line) throw new Error(`no line ${tag}`);
	return line[1];
}

function internDefect(rng: Rng, p: Program, classId: string): Defect {
	const cmd = textOf(p, 'cmd');
	const user = textOf(p, 'user').slice('USER '.length);
	if (classId === 'root') {
		return { tag: 'user', text: rng.pick(['USER root', 'USER 0', `# USER ${user}`, 'USER 0:0']), neighbour: 'useradd' };
	}
	if (classId === 'port') {
		const other = p.spec.port + rng.pick([1, 80, 1000, -100]);
		const variant = cmd.includes('$PORT') ? rng.int(0, 2) : rng.int(0, 1);
		if (variant === 0)
			return { tag: 'cmd', text: cmd.replace('0.0.0.0', rng.pick(['127.0.0.1', 'localhost'])), neighbour: 'expose' };
		if (variant === 1) return { tag: 'expose', text: `EXPOSE ${other}`, neighbour: 'cmd' };
		return { tag: 'env-port', text: `ENV PORT=${other}`, neighbour: 'expose' };
	}
	if (classId === 'cache') return { tag: 'manifests', text: rng.pick(['COPY . .', 'COPY . ./']), neighbour: 'install' };
	// The secret is not in the build context (statement): it leaks only by a copy out of the secret mount.
	const secret = p.spec.secrets[0] ?? '';
	const install = textOf(p, 'install');
	const target = install.match(/target=(\S+)/)?.[1] ?? '';
	const command = install.slice(install.indexOf(' ', install.indexOf('--mount')) + 1);
	return {
		tag: 'install',
		text: install.replace(
			command,
			rng.bool() ? `cp ${target} /app/${secret} && ${command}` : `${command} && cp ${target} ./${secret}`
		),
		neighbour: 'manifests'
	};
}

// --- Junior: several stages ----------------------------------------------------------------------------------

function juniorProgram(rng: Rng, kind: 'go' | 'python' | 'node'): Program {
	const fill = fillers(rng);
	// Labels and environment of the build stage go either right after FROM or after the build.
	const meta = metadata(rng);
	const lateMeta = rng.bool();
	const port = rng.int(30, 90) * 100 + rng.pick([0, 0, 80]);
	const shellCmd = rng.bool(0.5);
	const sha = rng.pick(['GIT_SHA', 'BUILD_ID', 'COMMIT']);
	if (kind === 'go') {
		const v = rng.pick(['1.22', '1.23']);
		const runtime = rng.pick(['debian:12-slim', 'ubuntu:24.04']);
		const lines: Line[] = [
			...header(rng),
			['from-build', `FROM golang:${v}-bookworm AS build`],
			...(lateMeta ? [] : meta),
			...aptBlock(rng, 'apt-build', 'git'),
			...fill(6),
			[null, 'WORKDIR /src'],
			...setup(rng, ['RUN go env -w GOPRIVATE=git.example.com', 'RUN mkdir -p /out']),
			...fill(2),
			['pre-install', rng.pick(['ENV CGO_ENABLED=0', 'ENV GOFLAGS=-trimpath', 'ENV GOTOOLCHAIN=local'])],
			['manifests', 'COPY go.mod go.sum ./'],
			['install', 'RUN --mount=type=secret,id=netrc,target=/root/.netrc go mod download'],
			['copy-all', 'COPY . .'],
			...fill(1),
			['arg-sha', `ARG ${sha}`],
			['build-run', `RUN go build -ldflags "-X main.commit=\${${sha}}" -o /out/api ./cmd/api`],
			...(lateMeta ? meta : []),
			[null, ''],
			['from-final', `FROM ${runtime} AS runtime`],
			...metadata(rng),
			...aptBlock(rng, 'apt-final', 'ca-certificates'),
			...fill(3),
			['env-port', `ENV PORT=${port}`],
			['copy-from-main', 'COPY --from=build /out/api /usr/local/bin/api'],
			...fill(1),
			...tail(rng, port, 'USER 65532'),
			[
				'cmd',
				shellCmd
					? 'CMD /usr/local/bin/api serve --host 0.0.0.0 --port $PORT'
					: `CMD ["/usr/local/bin/api", "serve", "--host", "0.0.0.0", "--port", "${port}"]`
			]
		];
		return {
			lines,
			spec: {
				port,
				manifests: ['go.mod', 'go.sum'],
				install: 'go mod download',
				secrets: ['.netrc'],
				buildNeeds: [],
				perBuild: [sha]
			}
		};
	}
	if (kind === 'python') {
		const v = rng.pick(['3.12', '3.13']);
		const lines: Line[] = [
			...header(rng),
			['from-build', `FROM python:${v} AS build`],
			...(lateMeta ? [] : meta),
			...aptBlock(rng, 'apt-build', 'libpq-dev'),
			...fill(6),
			[null, 'WORKDIR /app'],
			...setup(rng, ['RUN pip install --no-cache-dir --upgrade pip', 'RUN mkdir -p /install']),
			...fill(2),
			['pre-install', rng.pick(['ENV PIP_NO_CACHE_DIR=1', 'ENV PIP_DISABLE_PIP_VERSION_CHECK=1'])],
			['builder-secret-copy', 'COPY requirements.txt pip.conf ./'],
			['install', 'RUN PIP_CONFIG_FILE=/app/pip.conf pip install --prefix=/install -r requirements.txt'],
			['copy-all', 'COPY . .'],
			...fill(1),
			['arg-sha', `ARG ${sha}`],
			['build-run', `RUN echo "$${sha}" > /app/REVISION`],
			...(lateMeta ? meta : []),
			[null, ''],
			['from-final', `FROM python:${v}-slim AS runtime`],
			...metadata(rng),
			...aptBlock(rng, 'apt-final', 'libpq5'),
			[null, 'WORKDIR /app'],
			...fill(3),
			['env-port', `ENV PORT=${port}`],
			[null, 'COPY --from=build /install /usr/local'],
			['copy-from-main', 'COPY --from=build /app/app ./app'],
			[null, 'COPY --from=build /app/REVISION ./'],
			...fill(1),
			...tail(rng, port, 'USER 10001'),
			[
				'cmd',
				shellCmd
					? 'CMD uvicorn app.main:app --host 0.0.0.0 --port $PORT'
					: `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "${port}"]`
			]
		];
		return {
			lines,
			spec: {
				port,
				manifests: ['requirements.txt', 'pip.conf'],
				install: 'pip install',
				secrets: ['pip.conf'],
				buildNeeds: ['pip.conf'],
				perBuild: [sha]
			}
		};
	}
	const v = rng.pick(['20', '22']);
	const lines: Line[] = [
		...header(rng),
		['from-build', `FROM node:${v}-bookworm AS build`],
		...(lateMeta ? [] : meta),
		...aptBlock(rng, 'apt-build', 'python3'),
		...fill(6),
		[null, 'WORKDIR /app'],
		...setup(rng, ['RUN corepack enable', 'RUN npm config set update-notifier false']),
		...fill(2),
		['pre-install', rng.pick(['ENV npm_config_fund=false', 'ENV npm_config_update_notifier=false'])],
		['builder-secret-copy', 'COPY package.json package-lock.json .npmrc ./'],
		['install', 'RUN npm ci'],
		['copy-all', 'COPY . .'],
		...fill(1),
		['arg-sha', `ARG ${sha}`],
		['build-run', `RUN npm run build && echo "$${sha}" > dist/REVISION && npm prune --omit=dev`],
		...(lateMeta ? meta : []),
		[null, ''],
		['from-final', `FROM node:${v}-bookworm-slim AS runtime`],
		...metadata(rng),
		...aptBlock(rng, 'apt-final', rng.pick(['tini', 'dumb-init'])),
		[null, 'WORKDIR /app'],
		[null, 'ENV NODE_ENV=production'],
		...fill(3),
		['env-port', `ENV PORT=${port}`],
		['copy-from-main', 'COPY --from=build /app/node_modules ./node_modules'],
		[null, 'COPY --from=build /app/dist ./dist'],
		...fill(1),
		...tail(rng, port, 'USER node'),
		[
			'cmd',
			shellCmd
				? 'CMD node dist/server.js --host 0.0.0.0 --port $PORT'
				: `CMD ["node", "dist/server.js", "--host", "0.0.0.0", "--port", "${port}"]`
		]
	];
	return {
		lines,
		spec: {
			port,
			manifests: ['package.json', 'package-lock.json', '.npmrc'],
			install: 'npm ci',
			secrets: ['.npmrc'],
			buildNeeds: ['.npmrc'],
			perBuild: [sha]
		}
	};
}

function juniorDefect(rng: Rng, p: Program, classId: string): Defect {
	const buildFrom = textOf(p, 'from-build');
	if (classId === 'compiler') {
		const fullImage = buildFrom.split(' ')[1] ?? '';
		const variant = rng.int(0, 2);
		if (variant === 0) return { tag: 'from-final', text: `FROM ${fullImage} AS runtime`, neighbour: 'from-build' };
		if (variant === 1) return { tag: 'from-final', text: 'FROM build AS runtime', neighbour: 'from-build' };
		const apt = textOf(p, 'apt-final');
		const compiler = rng.pick(['build-essential', 'gcc', 'g++']);
		const text = apt.startsWith('RUN ')
			? apt.replace('--no-install-recommends ', `--no-install-recommends ${compiler} `)
			: apt.replace(/\S+ \\$/, `${compiler} \\`);
		return { tag: 'apt-final', text, neighbour: 'from-build' };
	}
	if (classId === 'secret-stage') {
		return { tag: 'copy-from-main', text: 'COPY --from=build /app ./', neighbour: 'builder-secret-copy' };
	}
	if (classId === 'cache-arg') {
		return { tag: 'pre-install', text: `ARG ${p.spec.perBuild[0] ?? ''}`, neighbour: 'arg-sha' };
	}
	// port-exec: exec form does not expand $PORT; the shown CMD keeps the variable.
	const words = ['--host', '0.0.0.0', '--port', '$PORT'];
	const cmd = textOf(p, 'cmd');
	const head = cmd.includes('/usr/local/bin/api')
		? ['/usr/local/bin/api', 'serve']
		: cmd.includes('uvicorn')
			? ['uvicorn', 'app.main:app']
			: ['node', 'dist/server.js'];
	return {
		tag: 'cmd',
		text: `CMD ${JSON.stringify([...head, ...words]).replaceAll('","', '", "')}`,
		neighbour: 'env-port'
	};
}

// --- Statement -------------------------------------------------------------------------------------------------

function statement(spec: Spec, junior: boolean): string {
	const manifests = spec.manifests.map((m) => `\`${m}\``).join(', ');
	return [
		'`Dockerfile` сервиса должен выполнять спецификацию:',
		'',
		`1. **Не root.** Процесс в контейнере работает не от root: последняя инструкция \`USER\` итоговой стадии задаёт пользователя, отличного от \`root\` и \`0\` (часть до двоеточия). Без \`USER\` — root${junior ? ', если стадия не унаследовала пользователя от стадии-базы' : ''}.`,
		`2. **Порт.** Сервис слушает порт ${spec.port} на всех интерфейсах: в команде запуска \`--host 0.0.0.0\` и \`--port ${spec.port}\`, порт объявлен через \`EXPOSE ${spec.port}\`, а переменная окружения \`PORT\` итоговой стадии равна ${spec.port} (по ней сервис сообщает свой адрес в реестр). В shell-форме \`CMD\` переменные вида \`$PORT\` подставляются из \`ENV\`; в exec-форме (\`["…"]\`) не подставляются и передаются как есть.`,
		`3. **Кэш зависимостей.** Правка исходников не сбрасывает кэш установки зависимостей: до \`RUN\` с \`${spec.install}\` в той же стадии копируются только файлы ${manifests}${junior ? `, и до неё в стадии не объявлены аргументы, меняющиеся при каждой сборке (${spec.perBuild.map((a) => `\`${a}\``).join(', ')}): \`RUN\` видит все объявленные выше \`ARG\` и пересобирается при новом значении` : ''}.`,
		`4. **Секрет.** Файл ${spec.secrets.map((s) => `\`${s}\``).join(', ')} с токеном реестра пакетов не попадает ни в один слой ${junior ? 'итогового образа (слои других стадий в образ не идут)' : 'образа'}: \`RUN --mount=type=secret\` подключает его только на время команды, но \`COPY\` такого файла или его копирование командой внутри \`RUN\` оставляет его в слое${junior ? '; `COPY --from` переносит всё, что лежит по пути в стадии-источнике' : ''}.${
			spec.buildNeeds.length > 0
				? ` Сборочной стадии ${spec.buildNeeds.map((s) => `\`${s}\``).join(', ')} нужен для установки зависимостей: он копируется в неё до \`RUN\` с \`${spec.install}\`, и убирать его оттуда нельзя.`
				: junior
					? ''
					: ` Файла ${spec.secrets.map((s) => `\`${s}\``).join(', ')} в контексте сборки нет: он передаётся только через \`docker build --secret\`.`
		}`,
		...(junior
			? [
					'5. **Без компилятора.** В итоговом образе нет компилятора. Он есть в образах `golang:*` и в полных `python:<версия>` и `node:<версия>-bookworm` (без `-slim`, `alpine`), появляется после установки пакетов `gcc`, `g++`, `build-essential`, `build-base`, а стадия, построенная на другой стадии (`FROM build`), получает всё, что в ней было.'
				]
			: []),
		'',
		'Ровно одна строка нарушает спецификацию: если заменить только её, все требования будут выполнены. Введите номер этой строки (нумерация с 1, как в редакторе).',
		'',
		'Если исправить можно в нескольких строках — засчитывается любая из них, где замена одной инструкцией восстанавливает спецификацию. Исправление — одна простая инструкция того же вида, что исправляемая строка (закомментированную инструкцию можно раскомментировать): не добавляйте новых инструкций, ключей и флагов, новых команд в `RUN` (через `&&`, `;`) и не переносите в неё логику из другой строки.'
	].join('\n');
}

// --- Reference ---------------------------------------------------------------------------------------------------

const PYTHON_REFERENCE = `import json
import re

data = json.loads(input())
spec = data["spec"]
junior = data["junior"]
COMPILER_PACKAGES = {"gcc", "g++", "build-essential", "build-base"}


def compiler_image(image):
    if image.startswith("golang:"):
        return True
    if image.startswith("python:") or image.startswith("node:"):
        return "slim" not in image and "alpine" not in image
    return False


def logical_lines(source):
    out = []
    buffer = ""
    for raw in source.split("\\n"):
        line = raw.strip()
        if not buffer and (not line or line.startswith("#")):
            continue
        if line.endswith("\\\\"):
            buffer += line[:-1] + " "
            continue
        out.append(buffer + line)
        buffer = ""
    return out


def parse(source):
    stages = []
    for line in logical_lines(source):
        op, _, rest = line.partition(" ")
        op = op.upper()
        if op == "FROM":
            words = rest.split()
            name = words[2] if len(words) > 2 and words[1].upper() == "AS" else None
            stages.append({"base": words[0], "name": name, "items": []})
        elif stages:
            stages[-1]["items"].append((op, rest.strip()))
    return stages


def violations(source):
    stages = parse(source)
    found = []
    state = {}
    for index, st in enumerate(stages):
        parent = next((state[s["name"]] for s in stages[:index] if s["name"] == st["base"]), None)
        if parent:
            s = {k: (set(v) if isinstance(v, set) else (dict(v) if isinstance(v, dict) else v)) for k, v in parent.items()}
        else:
            s = {"files": set(), "compiler": compiler_image(st["base"]), "user": "root", "env": {}, "expose": set(), "cmd": None, "cwd": "/"}
        copied = []
        args = []
        needs_ok = False
        for op, rest in st["items"]:
            if op == "WORKDIR":
                s["cwd"] = rest if rest.startswith("/") else s["cwd"].rstrip("/") + "/" + rest
            elif op == "USER":
                s["user"] = rest
            elif op == "ENV":
                for pair in rest.split():
                    k, _, v = pair.partition("=")
                    s["env"][k] = v
            elif op == "EXPOSE":
                s["expose"].update(rest.split())
            elif op == "CMD":
                s["cmd"] = rest
            elif op == "ARG":
                args.append(rest.split("=")[0])
            elif op in ("COPY", "ADD"):
                words = rest.split()
                src_stage = None
                plain = []
                for w in words:
                    if w.startswith("--from="):
                        src_stage = w.split("=", 1)[1]
                    elif not w.startswith("--"):
                        plain.append(w)
                dest = plain[-1]
                dest_dir = s["cwd"] if dest in (".", "./") else (dest if dest.startswith("/") else s["cwd"].rstrip("/") + "/" + dest.strip("./"))
                if src_stage is not None:
                    src = state[src_stage]
                    for root in plain[:-1]:
                        for f in src["files"]:
                            if f == root or f.startswith(root.rstrip("/") + "/"):
                                s["files"].add(dest_dir.rstrip("/") + f[len(root.rstrip("/")):])
                else:
                    copied.extend(plain[:-1])
                    for item in plain[:-1]:
                        if item in spec["secrets"]:
                            s["files"].add(dest_dir.rstrip("/") + "/" + item)
            elif op == "RUN":
                mounts = re.findall(r"--mount=type=secret,id=[^,\\s]+,target=(\\S+)", rest)
                for m in re.finditer(r"cp (\\S+) (\\S+)", rest):
                    if m.group(1) in mounts:
                        s["files"].add(m.group(2))
                if re.search(r"(apt-get install|apk add)", rest) and COMPILER_PACKAGES & set(rest.split()):
                    s["compiler"] = True
                if spec["install"] in rest:
                    needs_ok = needs_ok or all(n in copied for n in spec["buildNeeds"])
                    if any(c not in spec["manifests"] for c in copied):
                        found.append("cache: sources before install")
                    if junior and any(a in spec["perBuild"] for a in args):
                        found.append("cache: per-build argument before install")
        state[st["name"]] = s
        if index < len(stages) - 1 and not needs_ok:
            found.append("secret: the build stage installs dependencies without the file it needs")
        if index == len(stages) - 1:
            if s["user"].split(":")[0] in ("root", "0"):
                found.append("root")
            cmd = s["cmd"] or ""
            if cmd.startswith("["):
                argv = json.loads(cmd)
            else:
                argv = re.sub(r"\\$\\{?([A-Z_]+)\\}?", lambda m: s["env"].get(m.group(1), ""), cmd).split()
            host = argv[argv.index("--host") + 1] if "--host" in argv else None
            port = argv[argv.index("--port") + 1] if "--port" in argv else None
            if host != "0.0.0.0" or port != str(spec["port"]) or str(spec["port"]) not in s["expose"] or s["env"].get("PORT") != str(spec["port"]):
                found.append("port")
            if any(f.rsplit("/", 1)[-1] in spec["secrets"] for f in s["files"]):
                found.append("secret")
            if junior and s["compiler"]:
                found.append("compiler")
    return found


source = data["source"]
lines = source.split("\\n")
line = data["line"]
fixed = "\\n".join(lines[: line - 1] + [data["fix"]] + lines[line:])
before = violations(source)
after = violations(fixed)
if before and not after:
    print(line)
else:
    print("defect", before, "fixed", after)
`;

// --- Build -------------------------------------------------------------------------------------------------------

const KIND_BY_CLASS: Record<string, readonly ('go' | 'python' | 'node')[]> = {
	compiler: ['go', 'python', 'node'],
	'secret-stage': ['python', 'node'],
	'cache-arg': ['go', 'python', 'node'],
	'port-exec': ['go', 'python', 'node']
};

/** A line that looks risky to a hurried reader but meets the specification. */
const DECOYS = [
	'copy-all',
	'install',
	'apt',
	'apt-build',
	'useradd',
	'builder-secret-copy',
	'from-build',
	'arg-sha',
	'env-port',
	'expose'
];

/**
 * The range of the defect line of each class: the instance first draws a line in it uniformly, then programs until the
 * defect falls on that line. A sum of random noise piles the lines up in the middle, which makes a line number easy to
 * guess.
 */
const DEFECT_LINES: Record<string, [number, number]> = {
	'intern/root': [21, 50],
	'intern/port': [24, 52],
	'intern/cache': [10, 39],
	'intern/secret': [11, 39],
	'junior/compiler': [19, 52],
	'junior/secret-stage': [31, 65],
	'junior/cache-arg': [9, 36],
	'junior/port-exec': [36, 70]
};

interface Draft {
	p: Program;
	defect: Defect;
	index: number;
}

function draft(rng: Rng, junior: boolean, classId: string): Draft {
	const p = junior ? juniorProgram(rng, rng.pick(KIND_BY_CLASS[classId] ?? ['go'])) : internProgram(rng);
	const defect = junior ? juniorDefect(rng, p, classId) : internDefect(rng, p, classId);
	let index = p.lines.findIndex(([tag]) => tag === defect.tag);
	if (classId === 'cache-arg') {
		// Any ENV or LABEL line between WORKDIR and the dependencies may be the one turned into the argument.
		const from = p.lines.findIndex(([, text]) => text.startsWith('WORKDIR '));
		const spots = p.lines
			.map(([tag, text], i) => ({ tag, text, i }))
			.filter((l) => l.i > from && l.i < index && l.tag === null && /^(ENV|LABEL) /.test(l.text))
			.map((l) => l.i);
		index = rng.pick([index, ...spots]);
	}
	return { p, defect, index };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const range = DEFECT_LINES[`${input.grade}/${input.classId}`];
	if (!range) throw new Error(`${descriptor.key}: no defect lines for ${input.grade}/${input.classId}`);
	const target = rng.int(...range);
	let found: Draft | null = null;
	for (let tries = 0; tries < 20_000 && found === null; tries += 1) {
		const d = draft(rng, junior, input.classId);
		if (d.index + 1 === target) found = d;
	}
	if (found === null) throw new Error(`${descriptor.key}: no program with the defect on line ${target}`);
	const { p, defect, index } = found;
	// A per-build ARG is repaired by an ARG of the same kind that does not change between builds.
	const fix = input.classId === 'cache-arg' ? 'ARG TARGETARCH' : (p.lines[index]?.[1] ?? '');
	const lines = p.lines.map(([, text], i) => (i === index ? defect.text : text));
	const answer = index + 1;
	const lineOf = (tag: string): number => p.lines.findIndex(([t]) => t === tag) + 1;
	const neighbour = lineOf(defect.neighbour);
	const decoyTags = DECOYS.filter((t) => t !== defect.tag && t !== defect.neighbour && lineOf(t) > 0);
	const decoy = lineOf(rng.pick(decoyTags));
	const source = lines.join('\n');
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(p.spec, junior), code: { language: 'dockerfile', source } },
		answer: { kind: 'line_no', value: answer }
	});
	return {
		instance,
		reference: () => ({
			kind: 'output',
			source: PYTHON_REFERENCE,
			stdin: JSON.stringify({ source, line: answer, fix, spec: p.spec, junior })
		}),
		wrong: () => ({
			'same-requirement-line': { kind: 'answer', answer: { kind: 'line_no', value: neighbour } },
			'decoy-line': { kind: 'answer', answer: { kind: 'line_no', value: decoy } }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
