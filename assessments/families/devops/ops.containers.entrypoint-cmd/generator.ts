// Which process a container starts: ENTRYPOINT and CMD in exec and shell form, arguments of `docker run`,
// `--entrypoint`; for a junior, the configuration inherited from the base image (a new ENTRYPOINT drops the inherited
// CMD), USER and WORKDIR with `-u` and `-w`. The answer is the argv of the process, one element per line.
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

interface BaseConfig {
	image: string;
	entrypoint: string[] | null;
	cmd: string[] | null;
	user: string;
	workdir: string;
}

interface Scenario {
	lines: string[];
	base: BaseConfig;
	tag: string;
	/** The `docker run` command line, quoted for a POSIX shell. */
	run: string[];
}

interface Rules {
	argsAppend: boolean;
	shellAsExec: boolean;
	shellDropsArgs: boolean;
	epKeepsCmd: boolean;
	firstWins: boolean;
	execExpands: boolean;
	dropBaseEp: boolean;
	inheritCmdAfterEp: boolean;
	epResetsOwnCmd: boolean;
	shellCmdWords: boolean;
	workdirFromRoot: boolean;
	runFlagsIgnored: boolean;
}

const RIGHT: Rules = {
	argsAppend: false,
	shellAsExec: false,
	shellDropsArgs: false,
	epKeepsCmd: false,
	firstWins: false,
	execExpands: false,
	dropBaseEp: false,
	inheritCmdAfterEp: false,
	epResetsOwnCmd: false,
	shellCmdWords: false,
	workdirFromRoot: false,
	runFlagsIgnored: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'args-append': { argsAppend: true },
	'shell-as-exec': { shellAsExec: true },
	'shell-drops-args': { shellDropsArgs: true },
	'entrypoint-keeps-cmd': { epKeepsCmd: true },
	'first-wins': { firstWins: true },
	'exec-expands-vars': { execExpands: true },
	'drop-base-entrypoint': { dropBaseEp: true },
	'inherit-cmd-after-entrypoint': { inheritCmdAfterEp: true },
	'entrypoint-resets-own-cmd': { epResetsOwnCmd: true },
	'shell-cmd-words': { shellCmdWords: true },
	'workdir-from-root': { workdirFromRoot: true },
	'run-flags-ignored': { runFlagsIgnored: true }
};

/** Tokens of a POSIX command line with single and double quotes (no escapes inside the generated lines). */
function shellWords(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let has = false;
	let quote: string | null = null;
	for (const ch of line) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
		} else if (ch === ' ') {
			if (has) out.push(cur);
			cur = '';
			has = false;
		} else {
			cur += ch;
			has = true;
		}
	}
	if (has) out.push(cur);
	return out;
}

function quote(word: string): string {
	return /^[A-Za-z0-9_./:=,@%+-]+$/.test(word) ? word : `"${word}"`;
}

interface Form {
	exec: boolean;
	words: string[];
	text: string;
}

function form(rest: string): Form {
	if (rest.startsWith('[')) return { exec: true, words: JSON.parse(rest) as string[], text: rest };
	return { exec: false, words: [], text: rest };
}

function joinPath(base: string, path: string): string {
	const full = path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`;
	const parts: string[] = [];
	for (const p of full.split('/')) {
		if (p === '' || p === '.') continue;
		if (p === '..') parts.pop();
		else parts.push(p);
	}
	return `/${parts.join('/')}`;
}

/** The answer lines: `user=`, `workdir=` for a junior, then the argv. */
function evaluate(s: Scenario, rules: Rules, junior: boolean): string[] {
	const env = new Map<string, string>();
	let ep: Form | null = null;
	let cmd: Form | null = null;
	let epSet = false;
	let cmdSet = false;
	let user = s.base.user;
	let workdir = s.base.workdir;
	for (const raw of s.lines) {
		const text = raw.trim();
		if (text === '' || text.startsWith('#')) continue;
		const space = text.indexOf(' ');
		const op = text.slice(0, space).toUpperCase();
		const rest = text.slice(space + 1).trim();
		if (op === 'ENV') {
			const [k = '', ...v] = rest.split('=');
			env.set(k, v.join('='));
		} else if (op === 'USER') user = rest;
		else if (op === 'WORKDIR') workdir = joinPath(rules.workdirFromRoot ? '/' : workdir, rest);
		else if (op === 'ENTRYPOINT') {
			if (rules.firstWins && epSet) continue;
			ep = form(rest);
			epSet = true;
			if (!cmdSet || rules.epResetsOwnCmd) cmd = null;
		} else if (op === 'CMD') {
			if (rules.firstWins && cmdSet) continue;
			cmd = form(rest);
			cmdSet = true;
		}
	}
	const inheritedEp: string[] | null = epSet || rules.dropBaseEp ? null : s.base.entrypoint;
	let inheritedCmd: string[] | null = null;
	if (!cmdSet && (!epSet || rules.inheritCmdAfterEp)) inheritedCmd = s.base.cmd;
	const expand = (w: string): string =>
		rules.execExpands ? w.replace(/\$\{?([A-Z_]+)\}?/g, (_, name: string) => env.get(name) ?? '') : w;
	const argv = (f: Form, asCmd: boolean): string[] => {
		if (f.exec) return f.words.map(expand);
		if (rules.shellAsExec || (asCmd && rules.shellCmdWords && ep !== null && ep.exec)) return f.text.split(/\s+/);
		return ['/bin/sh', '-c', f.text];
	};
	// docker run [options] image [args]
	const words = shellWords(s.run.join(' ')).slice(2);
	let runUser: string | null = null;
	let runWorkdir: string | null = null;
	let runEp: string | null = null;
	let i = 0;
	while (i < words.length && (words[i] ?? '').startsWith('-')) {
		const flag = words[i] ?? '';
		if (flag === '--rm' || flag === '-d' || flag === '-it') i += 1;
		else {
			const value = words[i + 1] ?? '';
			if (flag === '-u' || flag === '--user') runUser = value;
			else if (flag === '-w' || flag === '--workdir') runWorkdir = value;
			else if (flag === '--entrypoint') runEp = value;
			i += 2;
		}
	}
	const args = words.slice(i + 1);
	let entry: string[] = ep ? argv(ep, false) : (inheritedEp ?? []);
	let command: string[] = cmd ? argv(cmd, true) : (inheritedCmd ?? []);
	if (runEp !== null) {
		entry = [runEp];
		if (!rules.epKeepsCmd) command = [];
	}
	if (args.length > 0) command = rules.argsAppend ? [...command, ...args] : args;
	if (rules.shellDropsArgs && runEp === null && ep !== null && !ep.exec) command = [];
	const head = junior
		? [
				`user=${rules.runFlagsIgnored ? user : (runUser ?? user)}`,
				`workdir=${rules.runFlagsIgnored ? workdir : (runWorkdir ?? workdir)}`
			]
		: [];
	return [...head, ...entry, ...command];
}

// --- Scenarios -------------------------------------------------------------------------------------------------

interface App {
	image: string;
	entry: string[];
	cmd: string[];
	/** The same CMD with the port taken from the environment, which exec form does not expand. */
	cmdVar: string[];
	shellEntry: string;
	shellCmd: string;
	alt: string[];
	env: string | null;
}

function apps(rng: Rng): App[] {
	const port = rng.int(30, 99) * 100 + rng.pick([0, 80]);
	const workers = rng.int(2, 9);
	const queue = rng.pick(['emails', 'reports', 'billing', 'exports', 'webhooks', 'search', 'audit']);
	const n = rng.int(2, 40);
	const port2 = rng.int(10, 99) * 100 + rng.int(1, 9);
	return [
		{
			image: rng.pick(['python:3.12-slim', 'python:3.13-slim']),
			entry: ['gunicorn'],
			cmd: ['--bind', `0.0.0.0:${port}`, '--workers', String(workers), 'app.main:app'],
			cmdVar: ['--bind', '0.0.0.0:$PORT', '--workers', String(workers), 'app.main:app'],
			shellEntry: `exec gunicorn --bind 0.0.0.0:$PORT --workers ${workers} app.main:app`,
			shellCmd: `gunicorn --bind 0.0.0.0:$PORT --workers ${workers} app.main:app`,
			alt: rng.pick([
				['python', 'manage.py', 'migrate', rng.pick(['orders', 'users', 'billing']), `00${n}`],
				['--bind', `0.0.0.0:${port2}`, '--workers', String(n), 'app.admin:app'],
				['celery', '-A', 'app', 'worker', '-Q', queue, '-c', String(n)]
			]),
			env: `PORT=${port}`
		},
		{
			image: rng.pick(['node:22-bookworm-slim', 'node:20-alpine']),
			entry: ['node'],
			cmd: ['dist/server.js', '--port', String(port)],
			cmdVar: ['dist/server.js', '--port', '${PORT}'],
			shellEntry: `node dist/server.js --port $PORT`,
			shellCmd: `node dist/server.js --port $PORT --cluster ${workers}`,
			alt: rng.pick([
				['dist/migrate.js', '--to', `v${n}`],
				['dist/worker.js', '--queue', queue, '--concurrency', String(n)],
				[`--max-old-space-size=${n * 128}`, 'dist/server.js']
			]),
			env: `PORT=${port}`
		},
		{
			image: rng.pick(['debian:12-slim', 'alpine:3.20']),
			entry: ['/usr/local/bin/api'],
			cmd: ['serve', '--config', `/etc/api/${rng.pick(['prod', 'stage', 'main'])}.yaml`],
			cmdVar: ['serve', '--listen', ':$PORT'],
			shellEntry: `/usr/local/bin/api serve --log-level ${rng.pick(['info', 'warn', 'debug'])}`,
			shellCmd: `/usr/local/bin/api serve --listen :$PORT`,
			alt: rng.pick([
				['migrate', '--steps', String(n)],
				['healthcheck', '--timeout', `${n}s`],
				['serve', '--port', String(port2), '--queue', queue]
			]),
			env: `PORT=${port}`
		},
		{
			image: rng.pick(['nginx:1.27-alpine', 'nginx:1.26']),
			entry: ['/docker-entrypoint.sh'],
			cmd: ['nginx', '-g', 'daemon off;'],
			cmdVar: ['nginx', '-g', 'worker_processes $WORKERS;'],
			shellEntry: `/docker-entrypoint.sh nginx -g 'daemon off;'`,
			shellCmd: `nginx -g 'daemon off;' -c /etc/nginx/${rng.pick(['site', 'edge', 'proxy'])}.conf`,
			alt: rng.pick([
				['nginx', '-t', '-c', `/etc/nginx/${queue}.conf`],
				['nginx', '-g', `worker_processes ${n};`],
				['sh', '-c', `sleep ${n}`]
			]),
			env: `WORKERS=${workers}`
		}
	];
}

const json = (words: readonly string[]): string => JSON.stringify(words).replaceAll('","', '", "');

function runLine(image: string, flags: string[], args: string[]): string[] {
	return ['docker', 'run', '--rm', ...flags, image, ...args.map(quote)];
}

const TAG = (rng: Rng): string =>
	`registry.local/${rng.pick(['shop', 'billing', 'crm', 'search'])}/${rng.pick(['api', 'worker', 'web', 'jobs'])}:${rng.int(1, 40)}.${rng.int(0, 9)}`;

function internScenario(rng: Rng, classId: string): Scenario {
	const app = rng.pick(apps(rng));
	const tag = TAG(rng);
	const lines: string[] = [`FROM ${app.image}`];
	if (app.env && rng.bool(0.6)) lines.push(`ENV ${app.env}`);
	lines.push('WORKDIR /app', 'COPY . .');
	if (rng.bool(0.4)) lines.push(rng.pick(['USER 10001', 'USER app', 'EXPOSE 8080']));
	const withArgs = rng.bool(0.7);
	let args: string[];
	let flags: string[] = [];
	if (classId === 'exec-pair') {
		if (rng.bool(0.3)) lines.push(`CMD ${json(app.alt)}`);
		lines.push(`ENTRYPOINT ${json(app.entry)}`, `CMD ${json(rng.bool(0.35) ? app.cmdVar : app.cmd)}`);
		args = withArgs || rng.bool(0.5) ? app.alt : [];
	} else if (classId === 'shell-entrypoint') {
		if (rng.bool(0.3)) lines.push(`CMD ${json(app.alt)}`);
		lines.push(`ENTRYPOINT ${app.shellEntry}`);
		if (rng.bool(0.7)) lines.push(`CMD ${json(rng.bool(0.35) ? app.cmdVar : app.cmd)}`);
		args = withArgs ? app.alt : [];
	} else if (classId === 'cmd-only') {
		if (rng.bool(0.3)) lines.push(`CMD ${json(app.alt)}`);
		const execCmd = rng.bool(0.35) ? app.cmdVar : app.cmd;
		lines.push(rng.bool(0.6) ? `CMD ${json([...app.entry, ...execCmd])}` : `CMD ${app.shellCmd}`);
		args = rng.bool(0.75) ? app.alt : [];
	} else {
		lines.push(`ENTRYPOINT ${json(app.entry)}`, `CMD ${json(app.cmd)}`);
		const ep = rng.bool(0.15)
			? rng.pick(['/bin/sh', 'sh', '/bin/bash', '/usr/bin/env', 'printenv', 'id'])
			: `${rng.pick(['/app/bin', '/usr/local/bin', '/opt/tools'])}/${rng.pick(['migrate', 'seed', 'console', 'healthcheck', 'reindex', 'warmup', 'backup', 'cron', 'export', 'report', 'cleanup'])}`;
		flags = ['--entrypoint', ep];
		args = rng.bool(0.3) ? rng.pick([['-c', 'env'], ['/etc/os-release'], ['--version']]) : [];
	}
	return {
		lines,
		base: { image: app.image, entrypoint: null, cmd: null, user: 'root', workdir: '/' },
		tag,
		run: runLine(tag, flags, args)
	};
}

const BASE_EP = [['tini', '--'], ['/usr/bin/dumb-init', '--'], ['docker-entrypoint.sh'], ['/entrypoint.sh']];
const BASE_CMD = [['python3'], ['node'], ['sh'], ['/bin/bash'], ['bash', '-l']];
const USERS = ['app', '1000', 'nobody', 'svc', '10001:10001'];
const DIRS = ['/srv', '/opt/app', '/home/app', '/var/lib/svc', '/workspace'];

function juniorScenario(rng: Rng, classId: string): Scenario {
	const app = rng.pick(apps(rng));
	const tag = TAG(rng);
	const baseImage = `registry.local/base/${rng.pick(['python', 'node', 'runtime', 'distro'])}:${rng.int(2, 9)}`;
	const base: BaseConfig = {
		image: baseImage,
		entrypoint: rng.pick(BASE_EP),
		cmd: rng.pick(BASE_CMD),
		user: rng.pick(['root', ...USERS]),
		workdir: rng.pick(['/', ...DIRS])
	};
	const lines: string[] = [`FROM ${baseImage}`];
	if (app.env && rng.bool(0.5)) lines.push(`ENV ${app.env}`);
	const relative = classId === 'user-workdir' || rng.bool(0.5);
	if (relative) {
		if (base.workdir === '/') base.workdir = rng.pick(DIRS);
		lines.push(`WORKDIR ${rng.pick(['app', 'service', 'current', 'releases/current'])}`);
	} else if (rng.bool(0.5)) lines.push(`WORKDIR ${rng.pick(DIRS)}`);
	lines.push('COPY . .');
	if (rng.bool(0.5) || classId === 'user-workdir') lines.push(`USER ${rng.pick(USERS)}`);
	const flags: string[] = [];
	let args: string[] = [];
	if (classId === 'inherit-entrypoint') {
		lines.push(`CMD ${json([...app.entry, ...app.cmd])}`);
		args = rng.bool(0.3) ? app.alt : [];
	} else if (classId === 'reset-cmd') {
		lines.push(`ENTRYPOINT ${json(app.entry)}`);
	} else if (classId === 'exec-ep-shell-cmd') {
		const entry = `ENTRYPOINT ${json(rng.pick(BASE_EP))}`;
		// A CMD of this Dockerfile before ENTRYPOINT is kept: only the inherited one is dropped.
		lines.push(...(rng.bool(0.4) ? [`CMD ${app.shellCmd}`, entry] : [entry, `CMD ${app.shellCmd}`]));
	} else {
		lines.push(`CMD ${json([...app.entry, ...app.cmd])}`);
		if (rng.bool(0.7)) flags.push('-u', rng.pick(['0', 'root', '2000', 'deploy']));
		if (rng.bool(0.6) || flags.length === 0) flags.push('-w', rng.pick(['/tmp', '/data', '/srv/run']));
		args = rng.bool(0.3) ? app.alt : [];
	}
	return { lines, base, tag, run: runLine(tag, flags, args) };
}

// --- Statement -------------------------------------------------------------------------------------------------

function statement(s: Scenario, junior: boolean): string {
	const show = (v: string[] | null): string => (v === null ? 'не задан' : `\`${json(v)}\``);
	return [
		`Образ \`${s.tag}\` собран из \`Dockerfile\` ниже. Контейнер запускают так:`,
		'',
		'```',
		s.run.join(' '),
		'```',
		'',
		junior
			? `Конфигурация базового образа \`${s.base.image}\` (как её показывает \`docker inspect\`): Entrypoint — ${show(s.base.entrypoint)}, Cmd — ${show(s.base.cmd)}, User — \`${s.base.user}\`, WorkingDir — \`${s.base.workdir}\`.`
			: `Считайте, что в базовом образе \`${s.base.image}\` ENTRYPOINT и CMD не заданы, пользователь — \`root\`, рабочий каталог — \`/\`.`,
		'',
		'Правила:',
		'',
		'1. Exec-форма (`["a", "b"]`) — готовый список аргументов; переменные окружения в нём не подставляются. Shell-форма (`CMD a b`) превращается в `["/bin/sh", "-c", "a b"]` — весь текст одним аргументом.',
		'2. Команда процесса — ENTRYPOINT, за которым дописан CMD. Действует последняя инструкция ENTRYPOINT и последняя CMD.',
		'3. Аргументы после имени образа в `docker run` целиком заменяют CMD. К shell-форме ENTRYPOINT они (или CMD) тоже дописываются после её трёх элементов — shell получит их как `$0`, `$1`…',
		'4. `--entrypoint <программа>` заменяет ENTRYPOINT одной программой и отбрасывает CMD образа; аргументы `docker run` идут ей.',
		...(junior
			? [
					'5. ENTRYPOINT, USER, WORKDIR и CMD наследуются от базового образа. Инструкция ENTRYPOINT сбрасывает CMD, унаследованный от базы; CMD, заданный в этом же `Dockerfile` (до или после ENTRYPOINT), сохраняется.',
					'6. Относительный WORKDIR отсчитывается от текущего рабочего каталога. `-u` и `-w` в `docker run` заменяют пользователя и рабочий каталог.'
				]
			: []),
		'',
		junior
			? 'Введите построчно: `user=<пользователь>`, `workdir=<каталог>`, затем аргументы процесса по одному в строке, в порядке. Пользователя пишите так, как он задан (`app`, `1000`, `10001:10001`). Например:'
			: 'Введите аргументы процесса (argv), который запустится в контейнере, по одному в строке, в порядке. Например:',
		'',
		'```',
		...(junior ? ['user=app', 'workdir=/srv/app'] : []),
		'/bin/sh',
		'-c',
		'echo ready',
		'```'
	].join('\n');
}

// --- Reference ---------------------------------------------------------------------------------------------------

const PYTHON_REFERENCE = `import json
import shlex

data = json.loads(input())
base = data["base"]
junior = data["junior"]


def parse_form(rest):
    if rest.startswith("["):
        return json.loads(rest)
    return ["/bin/sh", "-c", rest]


def resolve(cwd, path):
    full = path if path.startswith("/") else cwd.rstrip("/") + "/" + path
    out = []
    for p in full.split("/"):
        if p in ("", "."):
            continue
        if p == "..":
            if out:
                out.pop()
        else:
            out.append(p)
    return "/" + "/".join(out)


entrypoint = base["entrypoint"]
cmd = base["cmd"]
user = base["user"]
cwd = base["workdir"]
cmd_in_file = False
for raw in data["dockerfile"].split("\\n"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    op, _, rest = line.partition(" ")
    op = op.upper()
    rest = rest.strip()
    if op == "USER":
        user = rest
    elif op == "WORKDIR":
        cwd = resolve(cwd, rest)
    elif op == "ENTRYPOINT":
        entrypoint = parse_form(rest)
        if not cmd_in_file:
            cmd = None
    elif op == "CMD":
        cmd = parse_form(rest)
        cmd_in_file = True

words = shlex.split(data["run"])[2:]
i = 0
while i < len(words) and words[i].startswith("-"):
    if words[i] in ("--rm", "-d", "-it"):
        i += 1
        continue
    flag, value = words[i], words[i + 1]
    if flag in ("-u", "--user"):
        user = value
    elif flag in ("-w", "--workdir"):
        cwd = value
    elif flag == "--entrypoint":
        entrypoint = [value]
        cmd = None
    i += 2
args = words[i + 1:]
if args:
    cmd = args
argv = (entrypoint or []) + (cmd or [])
out = (["user=" + user, "workdir=" + cwd] if junior else []) + argv
print("\\n".join(out))
`;

// --- Build -------------------------------------------------------------------------------------------------------

const REQUIRED: Record<string, string[]> = {
	'intern/exec-pair': ['args-append'],
	'intern/shell-entrypoint': ['shell-as-exec', 'shell-drops-args'],
	'intern/cmd-only': ['args-append'],
	'intern/entrypoint-flag': ['entrypoint-keeps-cmd'],
	'junior/inherit-entrypoint': ['drop-base-entrypoint'],
	'junior/reset-cmd': ['inherit-cmd-after-entrypoint'],
	'junior/exec-ep-shell-cmd': ['shell-cmd-words'],
	'junior/user-workdir': ['workdir-from-root', 'run-flags-ignored']
};

const LEVEL_WRONG: Record<string, string[]> = {
	intern: [
		'args-append',
		'shell-as-exec',
		'shell-drops-args',
		'entrypoint-keeps-cmd',
		'first-wins',
		'exec-expands-vars'
	],
	junior: [
		'args-append',
		'drop-base-entrypoint',
		'inherit-cmd-after-entrypoint',
		'entrypoint-resets-own-cmd',
		'shell-cmd-words',
		'workdir-from-root',
		'run-flags-ignored'
	]
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	for (let tries = 0; tries < 200; tries += 1) {
		const s = junior ? juniorScenario(rng, input.classId) : internScenario(rng, input.classId);
		const answer = evaluate(s, RIGHT, junior);
		const same = (v: string[]): boolean => v.length === answer.length && v.every((x, i) => x === answer[i]);
		const allowed = LEVEL_WRONG[input.grade] ?? [];
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				if (!allowed.includes(id)) return [id, null];
				const value = evaluate(s, { ...RIGHT, ...change }, junior);
				return [id, same(value) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const source = s.lines.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: statement(s, junior), code: { language: 'dockerfile', source } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ dockerfile: source, base: s.base, run: s.run.join(' '), junior })
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
