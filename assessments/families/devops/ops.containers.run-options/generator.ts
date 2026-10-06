// What a container gets from its image and the options of `docker run`: published ports (`-p`, `-P`, EXPOSE),
// environment variables (ENV, ARG, `-e`, `--env-file`), mounted directories (named volumes and bind mounts), user
// and working directory. For a junior: port ranges and repeated `-p`, a base image that exposes ports and sets
// variables, user and working directory, build arguments and their scope, and a named volume reused by a newer image.
// The answer is a set of facts, one per line.
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

type Kind = 'ports' | 'ports-user' | 'env' | 'files';

interface Base {
	image: string;
	/** Shown as `docker inspect` output (a junior); otherwise the statement says the base sets nothing. */
	shown: boolean;
	expose: string[];
	env: [string, string][];
	user: string;
	workdir: string;
}

interface Scenario {
	kind: Kind;
	lines: string[];
	base: Base;
	/** The `docker build` command line, when build arguments matter. */
	build: string[] | null;
	/** `docker run` command lines, executed in order; the question is about the last one. */
	runs: string[][];
	envFiles: Record<string, string[]>;
	hostEnv: Record<string, string>;
	/** Image tag → directory → file names. */
	images: Record<string, Record<string, string[]>>;
	hostDirs: Record<string, string[]>;
	/** Named volumes that exist before the first run, with their files. */
	volumes: Record<string, string[]>;
	/** Files a container creates: the index of its run and the full path. */
	writes: { run: number; path: string }[];
	askNames: string[];
	askDirs: string[];
}

/** How a solver applies the rules; the right solver has every switch off. */
interface Rules {
	exposePublishes: boolean;
	swap: boolean;
	localhostDefault: boolean;
	pRequiresExpose: boolean;
	rangeFirstOnly: boolean;
	repeatLastWins: boolean;
	publishAllSamePort: boolean;
	publishAllOverrides: boolean;
	inheritedExposeIgnored: boolean;
	runFlagsIgnored: boolean;
	inheritedUserLost: boolean;
	argVisible: boolean;
	firstWins: boolean;
	imageEnvWins: boolean;
	cmdlineOrder: boolean;
	buildArgIgnored: boolean;
	globalArgVisible: boolean;
	envRefRuntime: boolean;
	baseEnvLost: boolean;
	mountMerges: boolean;
	bindCopies: boolean;
	volumeEmpty: boolean;
	volumeRecopies: boolean;
}

const RIGHT: Rules = {
	exposePublishes: false,
	swap: false,
	localhostDefault: false,
	pRequiresExpose: false,
	rangeFirstOnly: false,
	repeatLastWins: false,
	publishAllSamePort: false,
	publishAllOverrides: false,
	inheritedExposeIgnored: false,
	runFlagsIgnored: false,
	inheritedUserLost: false,
	argVisible: false,
	firstWins: false,
	imageEnvWins: false,
	cmdlineOrder: false,
	buildArgIgnored: false,
	globalArgVisible: false,
	envRefRuntime: false,
	baseEnvLost: false,
	mountMerges: false,
	bindCopies: false,
	volumeEmpty: false,
	volumeRecopies: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'expose-publishes': { exposePublishes: true },
	'swap-host-container': { swap: true },
	'localhost-default': { localhostDefault: true },
	'p-requires-expose': { pRequiresExpose: true },
	'range-first-only': { rangeFirstOnly: true },
	'repeat-last-wins': { repeatLastWins: true },
	'publish-all-same-port': { publishAllSamePort: true },
	'publish-all-overrides': { publishAllOverrides: true },
	'inherited-expose-ignored': { inheritedExposeIgnored: true },
	'run-flags-ignored': { runFlagsIgnored: true },
	'inherited-user-lost': { inheritedUserLost: true },
	'arg-visible': { argVisible: true },
	'first-wins': { firstWins: true },
	'image-env-wins': { imageEnvWins: true },
	'cmdline-order': { cmdlineOrder: true },
	'build-arg-ignored': { buildArgIgnored: true },
	'global-arg-visible': { globalArgVisible: true },
	'env-ref-runtime': { envRefRuntime: true },
	'base-env-lost': { baseEnvLost: true },
	'mount-merges': { mountMerges: true },
	'bind-copies': { bindCopies: true },
	'volume-empty': { volumeEmpty: true },
	'volume-recopies': { volumeRecopies: true }
};

// --- Parsing -----------------------------------------------------------------------------------------------------

interface Mount {
	bind: boolean;
	src: string;
	dst: string;
}

interface Run {
	publish: string[];
	publishAll: boolean;
	/** `-e` and `--env-file` in command-line order. */
	env: { file: boolean; value: string }[];
	mounts: Mount[];
	user: string | null;
	workdir: string | null;
	image: string;
}

const VALUE_FLAGS = new Set(['-p', '-e', '--env-file', '-v', '--mount', '-u', '-w', '--name']);

function parseRun(words: readonly string[]): Run {
	const run: Run = { publish: [], publishAll: false, env: [], mounts: [], user: null, workdir: null, image: '' };
	let i = 2;
	while (i < words.length && (words[i] ?? '').startsWith('-')) {
		const flag = words[i] ?? '';
		if (!VALUE_FLAGS.has(flag)) {
			if (flag === '-P') run.publishAll = true;
			i += 1;
			continue;
		}
		const value = words[i + 1] ?? '';
		if (flag === '-p') run.publish.push(value);
		else if (flag === '-e') run.env.push({ file: false, value });
		else if (flag === '--env-file') run.env.push({ file: true, value });
		else if (flag === '-u') run.user = value;
		else if (flag === '-w') run.workdir = value;
		else if (flag === '-v') {
			const [src = '', dst = ''] = value.split(':');
			run.mounts.push({ bind: src.startsWith('/'), src, dst });
		} else if (flag === '--mount') {
			const kv = new Map(value.split(',').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
			run.mounts.push({ bind: kv.get('type') === 'bind', src: kv.get('src') ?? '', dst: kv.get('dst') ?? '' });
		}
		i += 2;
	}
	run.image = words[i] ?? '';
	return run;
}

function instructions(lines: readonly string[]): { op: string; rest: string }[] {
	return lines
		.map((l) => l.trim())
		.filter((l) => l !== '' && !l.startsWith('#'))
		.map((l) => {
			const space = l.indexOf(' ');
			return { op: l.slice(0, space).toUpperCase(), rest: l.slice(space + 1).trim() };
		});
}

const portKey = (p: string): string => (p.includes('/') ? p : `${p}/tcp`);

function portRange(text: string): number[] {
	const [a = '', b] = text.split('-');
	const from = Number(a);
	const to = b === undefined ? from : Number(b);
	const out: number[] = [];
	for (let p = from; p <= to; p += 1) out.push(p);
	return out;
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

const lastRun = (s: Scenario): Run => parseRun(s.runs[s.runs.length - 1] ?? []);

// --- Model -------------------------------------------------------------------------------------------------------

function evalPorts(s: Scenario, rules: Rules): string[] {
	const run = lastRun(s);
	const exposed: string[] = rules.inheritedExposeIgnored ? [] : s.base.expose.map(portKey);
	for (const { op, rest } of instructions(s.lines))
		if (op === 'EXPOSE') for (const p of rest.split(/\s+/)) exposed.push(portKey(p));
	const bindings: { ip: string; host: string; port: number; proto: string }[] = [];
	for (const spec of run.publish) {
		const [main = '', proto = 'tcp'] = spec.split('/');
		const parts = main.split(':');
		let ip = '';
		let host = '';
		let container = parts[0] ?? '';
		if (parts.length === 2) [host, container] = [parts[0] ?? '', parts[1] ?? ''];
		if (parts.length === 3) [ip, host, container] = [parts[0] ?? '', parts[1] ?? '', parts[2] ?? ''];
		if (rules.swap && host !== '') [host, container] = [container, host];
		let ports = portRange(container);
		if (rules.rangeFirstOnly) ports = ports.slice(0, 1);
		const hosts = host === '' ? null : portRange(host);
		ports.forEach((port, k) =>
			bindings.push({
				ip: ip === '' ? (rules.localhostDefault ? '127.0.0.1' : '0.0.0.0') : ip,
				host: hosts ? String(hosts[k]) : 'random',
				port,
				proto
			})
		);
	}
	let kept = rules.pRequiresExpose ? bindings.filter((b) => exposed.includes(`${b.port}/${b.proto}`)) : bindings;
	if (rules.repeatLastWins) {
		const all = kept;
		kept = all.filter((b, k) => !all.slice(k + 1).some((x) => x.port === b.port && x.proto === b.proto));
	}
	const bound = new Set(kept.map((b) => `${b.port}/${b.proto}`));
	const out = kept.map((b) => `${b.ip}:${b.host}->${b.port}/${b.proto}`);
	for (const key of new Set(exposed)) {
		const port = key.slice(0, key.indexOf('/'));
		if (run.publishAll) {
			if (!bound.has(key) || rules.publishAllOverrides)
				out.push(`0.0.0.0:${rules.publishAllSamePort ? port : 'random'}->${key}`);
		} else if (rules.exposePublishes && !bound.has(key)) out.push(`0.0.0.0:${port}->${key}`);
	}
	return out;
}

function evalUser(s: Scenario, rules: Rules): string[] {
	const run = lastRun(s);
	let user = rules.inheritedUserLost ? 'root' : s.base.user;
	let workdir = rules.inheritedUserLost ? '/' : s.base.workdir;
	for (const { op, rest } of instructions(s.lines)) {
		if (op === 'USER') user = rest;
		if (op === 'WORKDIR') workdir = joinPath(workdir, rest);
	}
	if (!rules.runFlagsIgnored) {
		user = run.user ?? user;
		workdir = run.workdir ?? workdir;
	}
	return [`user=${user}`, `workdir=${workdir}`];
}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function substitute(text: string, lookup: (name: string) => string | undefined): string {
	return text.replace(REF, (_, a?: string, b?: string) => lookup(a ?? b ?? '') ?? '');
}

function refs(text: string): string[] {
	return [...text.matchAll(REF)].map((m) => m[1] ?? m[2] ?? '');
}

function buildArgs(s: Scenario): Map<string, string> {
	const out = new Map<string, string>();
	const words = s.build ?? [];
	words.forEach((w, k) => {
		if (w !== '--build-arg') return;
		const pair = words[k + 1] ?? '';
		out.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
	});
	return out;
}

function evalEnv(s: Scenario, rules: Rules): string[] {
	const given = rules.buildArgIgnored ? new Map<string, string>() : buildArgs(s);
	const global = new Map<string, string>();
	const args = new Map<string, string>();
	let env = new Map<string, string>();
	const templates: [string, string][] = [];
	let stage = false;
	for (const { op, rest } of instructions(s.lines)) {
		if (op === 'FROM') {
			stage = true;
			env = new Map(rules.baseEnvLost ? [] : s.base.env);
			args.clear();
		} else if (op === 'ARG') {
			const eq = rest.indexOf('=');
			const name = eq < 0 ? rest : rest.slice(0, eq);
			const fallback = eq < 0 ? (stage ? global.get(name) : undefined) : rest.slice(eq + 1);
			(stage ? args : global).set(name, given.get(name) ?? fallback ?? '');
		} else if (op === 'ENV') {
			const eq = rest.indexOf('=');
			const name = rest.slice(0, eq);
			const raw = rest.slice(eq + 1);
			env.set(
				name,
				substitute(raw, (n) => env.get(n) ?? args.get(n) ?? (rules.globalArgVisible ? global.get(n) : undefined))
			);
			templates.push([name, raw]);
		}
	}
	const run = lastRun(s);
	const entries = rules.cmdlineOrder ? run.env : [...run.env.filter((e) => e.file), ...run.env.filter((e) => !e.file)];
	const pairs: [string, string][] = [];
	const pair = (text: string): [string, string] => {
		const eq = text.indexOf('=');
		return eq < 0 ? [text, s.hostEnv[text] ?? ''] : [text.slice(0, eq), text.slice(eq + 1)];
	};
	for (const e of entries) {
		if (!e.file) pairs.push(pair(e.value));
		else for (const line of s.envFiles[e.value] ?? []) if (line !== '' && !line.startsWith('#')) pairs.push(pair(line));
	}
	const final = new Map(env);
	const fromRun = new Set<string>();
	for (const [name, value] of pairs) {
		if (rules.imageEnvWins && env.has(name)) continue;
		if (rules.firstWins && fromRun.has(name)) continue;
		final.set(name, value);
		fromRun.add(name);
	}
	if (rules.envRefRuntime)
		for (const [name, raw] of templates)
			if (!fromRun.has(name) && refs(raw).some((n) => fromRun.has(n)))
				final.set(
					name,
					substitute(raw, (n) => final.get(n) ?? args.get(n))
				);
	if (rules.argVisible) for (const [name, value] of args) if (!final.has(name)) final.set(name, value);
	return s.askNames.map((name) => {
		const value = final.get(name);
		return value === undefined ? `${name} unset` : `${name}=${value}`;
	});
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

function evalFiles(s: Scenario, rules: Rules): string[] {
	const volumes = new Map(Object.entries(s.volumes).map(([k, v]) => [k, [...v]]));
	const host = new Map(Object.entries(s.hostDirs).map(([k, v]) => [k, [...v]]));
	const out: string[] = [];
	s.runs.forEach((words, index) => {
		const run = parseRun(words);
		const image = s.images[run.image] ?? {};
		for (const m of run.mounts) {
			const inImage = image[m.dst] ?? [];
			if (m.bind) {
				if (rules.bindCopies) host.set(m.src, union(host.get(m.src) ?? [], inImage));
			} else {
				const current = volumes.get(m.src) ?? [];
				if (current.length === 0) volumes.set(m.src, rules.volumeEmpty ? [] : [...inImage]);
				else if (rules.volumeRecopies) volumes.set(m.src, union(current, inImage));
			}
		}
		const store = (m: Mount): Map<string, string[]> => (m.bind ? host : volumes);
		for (const w of s.writes) {
			if (w.run !== index) continue;
			const slash = w.path.lastIndexOf('/');
			const m = run.mounts.find((x) => x.dst === w.path.slice(0, slash));
			if (m) store(m).set(m.src, union(store(m).get(m.src) ?? [], [w.path.slice(slash + 1)]));
		}
		if (index !== s.runs.length - 1) return;
		for (const dir of s.askDirs) {
			const m = run.mounts.find((x) => x.dst === dir);
			let files = m ? (store(m).get(m.src) ?? []) : (image[dir] ?? []);
			if (m && rules.mountMerges) files = union(files, image[dir] ?? []);
			for (const f of files) out.push(`${dir}/${f}`);
		}
	});
	return out;
}

function evaluate(s: Scenario, rules: Rules): string[] {
	let out: string[];
	if (s.kind === 'ports') out = evalPorts(s, rules);
	else if (s.kind === 'ports-user') out = [...evalPorts(s, rules), ...evalUser(s, rules)];
	else if (s.kind === 'env') out = evalEnv(s, rules);
	else out = evalFiles(s, rules);
	const set = [...new Set(out)].sort();
	return set.length === 0 ? ['-'] : set;
}

// --- Scenarios ---------------------------------------------------------------------------------------------------

const TCP = [80, 443, 3000, 4000, 5000, 5432, 5672, 6379, 8000, 8080, 8081, 8443, 8888, 9000, 9090, 9100, 9200];
const UDP = [53, 123, 161, 514, 1812, 5353, 8125];
const LOCAL_IPS = ['127.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.4.10'];
const USERS = ['app', '1000', 'nobody', 'svc', '10001:10001', 'www-data'];
const DIRS = ['/srv', '/opt/app', '/home/app', '/var/lib/svc', '/workspace', '/srv/app'];

function tag(rng: Rng): string {
	const team = rng.pick(['shop', 'billing', 'crm', 'search', 'media']);
	const app = rng.pick(['api', 'worker', 'web', 'gateway', 'collector']);
	return `registry.local/${team}/${app}:${rng.int(1, 40)}.${rng.int(0, 9)}`;
}

const baseImage = (rng: Rng): string =>
	`registry.local/base/${rng.pick(['runtime', 'web', 'python', 'node'])}:${rng.int(2, 9)}`;

const hostPort = (rng: Rng): number => rng.int(10, 640) * 100 + rng.int(0, 99);

/** Distinct container ports as `port` or `port/udp`; the first one may be UDP. */
function containerPorts(rng: Rng, count: number, udp: boolean): string[] {
	const out = new Set<string>();
	while (out.size < count) {
		if (udp && out.size === 0 && rng.bool(0.4)) out.add(`${rng.pick(UDP)}/udp`);
		else out.add(String(rng.bool(0.7) ? rng.pick(TCP) : rng.int(1025, 9999)));
	}
	return rng.shuffle([...out]);
}

/** A TCP port that is none of `taken`. */
function freshPort(rng: Rng, taken: readonly string[]): string {
	for (;;) {
		const p = String(rng.bool(0.5) ? rng.pick(TCP) : rng.int(1025, 9999));
		if (!taken.includes(p)) return p;
	}
}

function exposeLines(rng: Rng, ports: readonly string[]): string[] {
	return rng.bool(0.5) ? [`EXPOSE ${ports.join(' ')}`] : ports.map((p) => `EXPOSE ${p}`);
}

const CMDS = ['CMD ["./server"]', 'CMD ["python", "-m", "app"]', 'CMD ["node", "dist/main.js"]'];

function plainBase(rng: Rng): Base {
	return {
		image: rng.pick(['debian:12-slim', 'alpine:3.20', 'python:3.12-slim', 'node:22-bookworm-slim']),
		shown: false,
		expose: [],
		env: [],
		user: 'root',
		workdir: '/'
	};
}

function scenario(kind: Kind, base: Base, lines: string[], runs: string[][]): Scenario {
	return {
		kind,
		lines,
		base,
		build: null,
		runs,
		envFiles: {},
		hostEnv: {},
		images: {},
		hostDirs: {},
		volumes: {},
		writes: [],
		askNames: [],
		askDirs: []
	};
}

const runOf = (image: string, flags: readonly string[][]): string[] => ['docker', 'run', '-d', ...flags.flat(), image];

const bindSpec = (rng: Rng): string =>
	rng.bool(0.4) ? `${rng.pick(LOCAL_IPS)}:${hostPort(rng)}` : String(hostPort(rng));

function internPorts(rng: Rng): Scenario {
	const base = plainBase(rng);
	const exposed = containerPorts(rng, rng.int(2, 3), true);
	const flags: string[][] = [['-p', `${hostPort(rng)}:${exposed[0] ?? ''}`]];
	if (exposed.length === 3) {
		const second = exposed[1] ?? '';
		flags.push(['-p', rng.bool(0.5) ? `${bindSpec(rng)}:${second}` : second]);
	}
	const extra = freshPort(
		rng,
		exposed.map((p) => p.replace('/udp', ''))
	);
	flags.push(['-p', `${bindSpec(rng)}:${extra}${rng.bool(0.2) ? '/udp' : ''}`]);
	const lines = [
		`FROM ${base.image}`,
		`WORKDIR ${rng.pick(DIRS)}`,
		'COPY . .',
		...exposeLines(rng, exposed),
		rng.pick(CMDS)
	];
	return scenario('ports', base, lines, [runOf(tag(rng), rng.shuffle(flags))]);
}

function internPublishAll(rng: Rng): Scenario {
	const base = plainBase(rng);
	const exposed = containerPorts(rng, rng.int(2, 3), true);
	const flags: string[][] = [['-P']];
	if (rng.bool(0.6))
		flags.push([
			'-p',
			`${bindSpec(rng)}:${freshPort(
				rng,
				exposed.map((p) => p.replace('/udp', ''))
			)}`
		]);
	const user = rng.bool(0.6);
	if (user) flags.push(['-u', rng.pick(['0', 'root', '2000', 'deploy'])]);
	if (!user || rng.bool(0.5)) flags.push(['-w', rng.pick(['/tmp', '/data', '/srv/run'])]);
	const lines = [
		`FROM ${base.image}`,
		`WORKDIR ${rng.pick(DIRS)}`,
		'COPY . .',
		...exposeLines(rng, exposed),
		`USER ${rng.pick(USERS)}`,
		rng.pick(CMDS)
	];
	return scenario('ports-user', base, lines, [runOf(tag(rng), rng.shuffle(flags))]);
}

function juniorPorts(rng: Rng): Scenario {
	const all = containerPorts(rng, 4, true);
	const baseExpose = all.slice(0, rng.int(1, 2));
	const own = all.slice(baseExpose.length, baseExpose.length + rng.int(1, 2));
	const base: Base = { image: baseImage(rng), shown: true, expose: baseExpose, env: [], user: 'root', workdir: '/' };
	const exposed = [...baseExpose, ...own];
	const width = rng.int(1, 3);
	const from = rng.int(70, 98) * 100 + rng.int(0, 90);
	const hostFrom = hostPort(rng);
	const flags: string[][] = [['-p', `${hostFrom}-${hostFrom + width}:${from}-${from + width}`]];
	const target = rng.pick(exposed);
	if (rng.bool(0.6))
		flags.push(['-p', `${hostPort(rng)}:${target}`], ['-p', `${rng.pick(LOCAL_IPS)}:${hostPort(rng)}:${target}`]);
	else flags.push(['-p', `${rng.pick(LOCAL_IPS)}::${target}`]);
	if (rng.bool(0.4)) flags.push(['-p', `${hostPort(rng)}:${freshPort(rng, all)}`]);
	const lines = [
		`FROM ${base.image}`,
		`WORKDIR ${rng.pick(DIRS)}`,
		'COPY . .',
		...exposeLines(rng, own),
		rng.pick(CMDS)
	];
	return scenario('ports', base, lines, [runOf(tag(rng), rng.shuffle(flags))]);
}

function juniorPublishAll(rng: Rng): Scenario {
	const all = containerPorts(rng, 4, true);
	const baseExpose = all.slice(0, 2);
	const own = all.slice(2, 2 + rng.int(1, 2));
	const base: Base = {
		image: baseImage(rng),
		shown: true,
		expose: baseExpose,
		env: [],
		user: rng.pick(USERS),
		workdir: rng.pick(DIRS)
	};
	const explicit = rng.bool(0.5) ? (baseExpose[0] ?? '') : (own[0] ?? '');
	const flags: string[][] = [['-P'], ['-p', `${bindSpec(rng)}:${explicit}`]];
	if (rng.bool(0.4)) flags.push(['-u', rng.pick(['0', 'root', '2000', 'deploy'])]);
	const lines = [`FROM ${base.image}`];
	if (rng.bool(0.6)) lines.push(`WORKDIR ${rng.pick(['app', 'current', 'releases/current'])}`);
	lines.push('COPY . .', ...exposeLines(rng, own));
	if (rng.bool(0.4)) lines.push(`USER ${rng.pick(USERS)}`);
	lines.push(rng.pick(CMDS));
	return scenario('ports-user', base, lines, [runOf(tag(rng), rng.shuffle(flags))]);
}

const ENV_NAMES = [
	'APP_ENV',
	'LOG_LEVEL',
	'PORT',
	'DB_HOST',
	'CACHE_TTL',
	'WORKERS',
	'REGION',
	'TZ',
	'QUEUE',
	'FEATURE_FLAGS',
	'MAX_UPLOAD_MB',
	'SENTRY_ENV'
];

function envValue(rng: Rng, name: string): string {
	switch (name) {
		case 'APP_ENV':
		case 'SENTRY_ENV':
			return rng.pick(['production', 'staging', 'dev', 'qa', 'demo', 'preprod']) + String(rng.int(1, 9));
		case 'LOG_LEVEL':
			return `${rng.pick(['debug', 'info', 'warn', 'error', 'trace'])}${rng.int(1, 9)}`;
		case 'DB_HOST':
			return `${rng.pick(['postgres', 'db', 'pg-main', 'pg-replica'])}-${rng.int(1, 99)}`;
		case 'REGION':
			return `${rng.pick(['eu-central', 'ru-msk', 'ru-spb', 'us-east', 'ap-south'])}-${rng.int(1, 9)}`;
		case 'TZ':
			return rng.pick(['UTC', 'Europe/Moscow', 'Asia/Novosibirsk', 'Europe/Berlin', 'Asia/Yekaterinburg']);
		case 'QUEUE':
			return `${rng.pick(['emails', 'reports', 'billing', 'exports', 'webhooks'])}-${rng.int(1, 99)}`;
		case 'FEATURE_FLAGS':
			return rng.sample(['search', 'beta', 'dark', 'export', 'chat', 'promo', 'audit'], 2).join(',');
		default:
			return String(rng.int(2, 9999));
	}
}

/** A value of `name` that differs from `other`. */
function otherValue(rng: Rng, name: string, other: string): string {
	for (;;) {
		const v = envValue(rng, name);
		if (v !== other) return v;
	}
}

const BUILD_ARGS = ['GIT_SHA', 'BUILD_NUMBER', 'PIP_INDEX_URL', 'NPM_REGISTRY', 'BUILD_DATE'];

function buildArgValue(rng: Rng, name: string): string {
	if (name === 'GIT_SHA') return rng.int(0x1000000, 0xfffffff).toString(16);
	if (name === 'BUILD_NUMBER') return String(rng.int(100, 9999));
	if (name === 'BUILD_DATE') {
		const two = (n: number): string => String(n).padStart(2, '0');
		return `2026-${two(rng.int(1, 12))}-${two(rng.int(1, 28))}`;
	}
	return `https://mirror${rng.int(1, 99)}.local/${name === 'PIP_INDEX_URL' ? 'simple' : 'npm'}`;
}

function internEnv(rng: Rng): Scenario {
	const base = plainBase(rng);
	const [a = '', b = '', c = '', d = '', rep = '', fromHost = ''] = rng.sample(ENV_NAMES, 6);
	const arg = rng.pick(BUILD_ARGS);
	const imageB = envValue(rng, b);
	const lines = [
		`FROM ${base.image}`,
		`ARG ${arg}=${buildArgValue(rng, arg)}`,
		`RUN echo "$${arg}" > /build-info`,
		`ENV ${a}=${envValue(rng, a)}`,
		`ENV ${b}=${imageB}`,
		...(rng.bool(0.5) ? [`ENV ${c}=${envValue(rng, c)}`] : []),
		`WORKDIR ${rng.pick(DIRS)}`,
		'COPY . .',
		rng.pick(CMDS)
	];
	const fileName = rng.pick(['app.env', 'prod.env', 'stage.env', 'service.env']);
	const fileD = envValue(rng, d);
	const fileLines = rng.shuffle([`${b}=${otherValue(rng, b, imageB)}`, `${d}=${fileD}`]);
	if (rng.bool(0.5)) fileLines.unshift(`# ${rng.pick(['overrides', 'stage settings', 'do not commit'])}`);
	const first = envValue(rng, rep);
	const flags: string[][] = rng.shuffle([
		['-e', `${d}=${otherValue(rng, d, fileD)}`],
		['-e', fromHost],
		...(rng.bool(0.5) ? [['-e', `${a}=${envValue(rng, a)}`]] : [])
	]);
	// The repeated name: two `-e` with different values, in this order.
	const at = rng.int(0, flags.length);
	flags.splice(at, 0, ['-e', `${rep}=${first}`]);
	flags.splice(rng.int(at + 1, flags.length), 0, ['-e', `${rep}=${otherValue(rng, rep, first)}`]);
	flags.splice(rng.int(0, flags.length), 0, ['--env-file', fileName]);
	const s = scenario('env', base, lines, [runOf(tag(rng), flags)]);
	s.envFiles = { [fileName]: fileLines };
	s.hostEnv = { [fromHost]: envValue(rng, fromHost) };
	s.askNames = rng.shuffle([a, b, c, d, rep, fromHost, arg]);
	return s;
}

const STD_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function juniorEnv(rng: Rng): Scenario {
	const globalArg = rng.pick(['BASE_TAG', 'RUNTIME_VERSION', 'DISTRO_TAG']);
	const globalValue = `${rng.int(2, 9)}.${rng.int(0, 30)}`;
	const exported = rng.pick(['RUNTIME_TAG', 'BASE_VERSION', 'IMAGE_BASE']);
	const versionArg = rng.pick(['APP_VERSION', 'RELEASE_ARG', 'VERSION']);
	const versionEnv = rng.pick(['SERVICE_VERSION', 'APP_RELEASE', 'BUILD_VERSION']);
	const versionDefault = `1.${rng.int(0, 30)}.${rng.int(0, 9)}`;
	const [hostVar, urlVar, scheme, port] = rng.pick([
		['DB_HOST', 'DATABASE_URL', 'postgres', 5432],
		['REDIS_HOST', 'REDIS_URL', 'redis', 6379],
		['BROKER_HOST', 'BROKER_URL', 'amqp', 5672]
	] as const);
	const app = rng.pick(['shop', 'billing', 'crm', 'search', 'media']);
	const lang = rng.pick(['C.UTF-8', 'en_US.UTF-8', 'ru_RU.UTF-8']);
	const homeVar = rng.pick(['PYTHON_HOME', 'NODE_HOME', 'JAVA_HOME']);
	const base: Base = {
		image: `registry.local/base/runtime:${globalValue}`,
		shown: true,
		expose: [],
		env: [
			['PATH', STD_PATH],
			['LANG', lang],
			[homeVar, `/usr/local/${homeVar.split('_')[0]?.toLowerCase() ?? ''}`]
		],
		user: 'root',
		workdir: '/'
	};
	const imageHost = `${hostVar.split('_')[0]?.toLowerCase() ?? ''}-${rng.int(1, 99)}`;
	const lines = [
		`ARG ${globalArg}=${globalValue}`,
		`FROM registry.local/base/runtime:\${${globalArg}}`,
		...(rng.bool(0.5) ? [`ARG ${globalArg}`] : []),
		`ARG ${versionArg}=${versionDefault}`,
		`ENV ${exported}=\${${globalArg}}`,
		`ENV ${versionEnv}=$${versionArg}`,
		`ENV ${hostVar}=${imageHost}`,
		`ENV ${urlVar}=${scheme}://\${${hostVar}}:${port}/${app}`,
		`ENV PATH=/opt/${app}/bin:$PATH`,
		`WORKDIR /opt/${app}`,
		'COPY . .',
		rng.pick(CMDS)
	];
	const t = tag(rng);
	const build = ['docker', 'build'];
	if (rng.bool(0.6)) build.push('--build-arg', `${versionArg}=2.${rng.int(0, 30)}.${rng.int(0, 9)}`);
	build.push('-t', t, '.');
	const flags: string[][] = [
		['-e', `${hostVar}=${hostVar.split('_')[0]?.toLowerCase() ?? ''}-replica-${rng.int(1, 9)}`]
	];
	const s = scenario('env', base, lines, []);
	if (rng.bool(0.5)) {
		const fileName = rng.pick(['app.env', 'prod.env', 'stage.env']);
		flags.push(['--env-file', fileName]);
		s.envFiles = {
			[fileName]: [`LANG=${rng.pick(['de_DE.UTF-8', 'fr_FR.UTF-8', 'POSIX'])}`, `TZ=${envValue(rng, 'TZ')}`]
		};
	}
	s.runs = [runOf(t, rng.shuffle(flags))];
	s.build = build;
	s.askNames = rng.shuffle([exported, versionEnv, versionArg, hostVar, urlVar, 'PATH', 'LANG', homeVar]);
	return s;
}

const DIR_FILES: Record<string, string[]> = {
	config: ['app.yaml', 'logging.yaml', 'features.json', 'db.toml', 'limits.yaml', 'routes.yaml'],
	data: ['seed.db', 'index.bin', 'state.json', 'catalog.db', 'users.db'],
	uploads: ['avatar-default.png', 'readme.txt', 'logo.svg', 'banner.jpg'],
	static: ['main.js', 'main.css', 'favicon.ico', 'robots.txt', 'app.js'],
	plugins: ['auth.so', 'metrics.so', 'cache.so', 'export.so'],
	templates: ['mail.html', 'invoice.html', 'report.html', 'reset.html'],
	certs: ['ca.pem', 'server.pem', 'server.key', 'client.pem']
};

function files(rng: Rng, dir: string, count: number, numbered: boolean): string[] {
	const pool = DIR_FILES[dir] ?? [];
	return rng.sample(pool, count).map((f) => {
		if (!numbered || rng.bool(0.5)) return f;
		const dot = f.lastIndexOf('.');
		return `${f.slice(0, dot)}-${rng.int(2, 99)}${f.slice(dot)}`;
	});
}

/** A mount flag; `ro` allows a read-only bind mount (only where nothing is written). */
function mountFlag(rng: Rng, bind: boolean, src: string, dst: string, ro: boolean): string[] {
	if (rng.bool(0.3)) return ['--mount', `type=${bind ? 'bind' : 'volume'},src=${src},dst=${dst}`];
	return ['-v', `${src}:${dst}${bind && ro && rng.bool(0.3) ? ':ro' : ''}`];
}

/** Directories for a named volume (data the service writes), a bind mount (settings from the host) and no mount. */
function mountDirs(rng: Rng): [string, string, string] {
	const plain = rng.pick(['static', 'templates']);
	return [rng.pick(['data', 'uploads']), rng.pick(['config', 'certs', 'plugins']), plain];
}

function internFiles(rng: Rng): Scenario {
	const base = plainBase(rng);
	const root = rng.pick(['/srv/app', '/opt/app', '/var/www/app', '/app']);
	const project = rng.pick(['shop', 'billing', 'crm', 'wiki', 'media']);
	const [volDir, bindDir, plainDir] = mountDirs(rng);
	const t = tag(rng);
	const image: Record<string, string[]> = {};
	for (const dir of [volDir, bindDir, plainDir]) image[`${root}/${dir}`] = files(rng, dir, rng.int(2, 3), true);
	const volume = `${project}-${volDir}`;
	const hostPath = `${rng.pick(['/srv', '/home/deploy', '/mnt/data'])}/${project}/${bindDir}`;
	const s = scenario('files', base, [], []);
	if (rng.bool(0.45)) s.volumes = { [volume]: files(rng, volDir, rng.int(1, 2), true) };
	s.hostDirs = { [hostPath]: files(rng, bindDir, rng.int(1, 3), true) };
	const flags = rng.shuffle([
		mountFlag(rng, false, volume, `${root}/${volDir}`, true),
		mountFlag(rng, true, hostPath, `${root}/${bindDir}`, true)
	]);
	s.lines = [
		`FROM ${base.image}`,
		`WORKDIR ${root}`,
		...rng.shuffle([volDir, bindDir, plainDir]).map((d) => `COPY ${d}/ ./${d}/`),
		rng.pick(CMDS)
	];
	s.images = { [t]: image };
	s.runs = [runOf(t, flags)];
	s.askDirs = [volDir, bindDir, plainDir].map((d) => `${root}/${d}`);
	return s;
}

function juniorFiles(rng: Rng): Scenario {
	const base = plainBase(rng);
	const root = rng.pick(['/var/lib/app', '/srv/app', '/opt/service']);
	const project = rng.pick(['shop', 'billing', 'crm', 'wiki', 'media']);
	const [volDir, bindDir, plainDir] = mountDirs(rng);
	const repo = tag(rng).replace(/:.*$/, '');
	const major = rng.int(1, 9);
	const minor = rng.int(0, 20);
	const [t1, t2] = [`${repo}:${major}.${minor}`, `${repo}:${major}.${minor + 1}`];
	const v1Vol = files(rng, volDir, rng.int(2, 3), false);
	const v2Vol = union(rng.sample(v1Vol, rng.int(1, v1Vol.length)), [
		`${rng.pick(['migrated', 'defaults', 'schema', 'extra'])}-v${minor + 1}.${rng.pick(['json', 'db', 'yaml'])}`
	]);
	const bindFiles = files(rng, bindDir, 2, false);
	const plain1 = files(rng, plainDir, 2, false);
	const plain2 = union(plain1.slice(0, 1), [`${rng.pick(['bundle', 'chunk', 'vendor'])}-${rng.int(100, 999)}.js`]);
	const dir = (d: string): string => `${root}/${d}`;
	const volume = `${project}-${volDir}`;
	const hostPath = `${rng.pick(['/srv', '/home/deploy', '/mnt/data'])}/${project}/${bindDir}`;
	const s = scenario('files', base, [], []);
	s.lines = [
		`FROM ${base.image}`,
		`WORKDIR ${root}`,
		...[volDir, bindDir, plainDir].map((d) => `COPY ${d}/ ./${d}/`),
		rng.pick(CMDS)
	];
	s.images = {
		[t1]: { [dir(volDir)]: v1Vol, [dir(bindDir)]: bindFiles, [dir(plainDir)]: plain1 },
		[t2]: { [dir(volDir)]: v2Vol, [dir(bindDir)]: bindFiles, [dir(plainDir)]: plain2 }
	};
	if (rng.bool(0.25)) s.volumes = { [volume]: files(rng, volDir, 1, true) };
	s.hostDirs = { [hostPath]: rng.bool(0.2) ? [] : files(rng, bindDir, rng.int(1, 2), true) };
	const mounts = (): string[][] =>
		rng.shuffle([
			mountFlag(rng, false, volume, dir(volDir), false),
			mountFlag(rng, true, hostPath, dir(bindDir), false)
		]);
	s.runs = [runOf(t1, mounts()), runOf(t2, mounts())];
	s.writes = [
		{ run: 0, path: `${dir(volDir)}/${rng.pick(['session', 'cache', 'upload', 'journal'])}-${rng.int(1, 999)}.dat` }
	];
	if (rng.bool(0.5))
		s.writes.push({
			run: 0,
			path: `${dir(bindDir)}/${rng.pick(['local', 'override', 'tuned'])}-${rng.int(1, 99)}.conf`
		});
	s.askDirs = [volDir, bindDir, plainDir].map(dir);
	return s;
}

// --- Statement ---------------------------------------------------------------------------------------------------

const PORT_RULES = [
	'`EXPOSE` только объявляет порт контейнера (протокол по умолчанию — tcp) и сам ничего не публикует на хосте. Объявленные порты наследуются от базового образа.',
	'`-p [адрес:]порт_хоста:порт_контейнера[/протокол]` публикует порт контейнера на порту хоста. Адрес не указан — `0.0.0.0` (IPv6 не учитываем), протокол — tcp. Порт контейнера не обязан быть объявлен в `EXPOSE`.',
	'`-p порт_контейнера` и `-p адрес::порт_контейнера` — порт хоста выбирает Docker, в ответе пишите вместо него `random`.',
	'`-P` публикует каждый порт, объявленный через `EXPOSE` (в том числе унаследованный), на порту хоста, который выбирает Docker, с адресом `0.0.0.0` — кроме портов, для которых в команде есть `-p`: у них действует только `-p`.'
];

const JUNIOR_PORT_RULES = [
	'Диапазон `-p 9000-9002:7000-7002` публикует пары по порядку: 9000→7000, 9001→7001, 9002→7002. Несколько `-p` для одного порта контейнера публикуют его на каждом из указанных портов хоста.'
];

const USER_RULES = [
	'Пользователь и рабочий каталог — из последних `USER` и `WORKDIR` (относительный `WORKDIR` отсчитывается от текущего каталога); без них — унаследованные от базового образа. `-u` и `-w` в `docker run` заменяют их.'
];

const ENV_RULES = [
	'`ENV` задаёт переменную окружения образа: она видна процессу контейнера и наследуется от базового образа.',
	'`ARG` — переменная только времени сборки: её значение доступно следующим инструкциям `Dockerfile`, но в окружение запущенного контейнера она не попадает. `--build-arg` в `docker build` заменяет значение по умолчанию.',
	'`$ИМЯ` и `${ИМЯ}` в `ENV` подставляются при сборке — значением `ENV` или `ARG`, заданным выше; не заданное — пустая строка. При запуске значение не пересчитывается.',
	'`docker run`: сначала читаются все `--env-file` (строки `ИМЯ=значение`, значение берётся буквально; пустые строки и строки с `#` пропускаются), затем все `-e` — независимо от их места в командной строке. `-e ИМЯ` без значения берёт значение из окружения шелла, где запущен `docker run`. При повторе имени действует последнее. Всё это перекрывает `ENV` образа.'
];

const JUNIOR_ENV_RULES = [
	'`ARG` до первого `FROM` виден только в строках `FROM`. После `FROM` его значение доступно, только если объявить его заново — `ARG ИМЯ` без значения (тогда берётся значение глобального `ARG`).'
];

const FILE_RULES = [
	'`-v имя:/путь` и `--mount type=volume,src=имя,dst=/путь` — именованный том; `-v /путь/хоста:/путь` и `--mount type=bind,src=/путь/хоста,dst=/путь` — bind-mount каталога хоста. Суффикс `:ro` на видимые файлы не влияет.',
	'Смонтированный каталог целиком закрывает каталог образа по тому же пути: файлы образа там не видны.',
	'Именованный том, которого ещё нет, создаётся и при монтировании заполняется копией содержимого каталога образа по этому пути. Уже существующий непустой том не меняется — в нём то, что в нём было.',
	'Bind-mount ничего не копирует: в контейнере видно ровно содержимое каталога хоста.',
	'Файлы, созданные процессом в смонтированном каталоге, остаются в томе или в каталоге хоста после удаления контейнера.'
];

const listing = (names: readonly string[]): string =>
	names.length === 0 ? 'пусто' : names.map((n) => `\`${n}\``).join(', ');

function baseText(s: Scenario): string {
	const b = s.base;
	if (!b.shown)
		return `Считайте, что базовый образ \`${b.image}\` не объявляет портов и переменных окружения, пользователь в нём — \`root\`, рабочий каталог — \`/\`.`;
	const parts: string[] = [];
	if (s.kind === 'env') parts.push(`Env — ${b.env.map(([k, v]) => `\`${k}=${v}\``).join(', ')}`);
	else {
		parts.push(`ExposedPorts — ${listing(b.expose.map(portKey))}`);
		if (s.kind === 'ports-user') parts.push(`User — \`${b.user}\``, `WorkingDir — \`${b.workdir}\``);
	}
	return `Конфигурация базового образа \`${b.image}\` (как её показывает \`docker inspect\`): ${parts.join('; ')}.`;
}

function numbered(rules: readonly string[]): string[] {
	return rules.map((r, k) => `${k + 1}. ${r}`);
}

function statement(s: Scenario, junior: boolean): string {
	const out: string[] = [];
	const [t = '', t2 = ''] = s.runs.map((r) => parseRun(r).image);
	if (s.kind === 'files' && s.runs.length > 1) {
		out.push(
			`Образы \`${t}\` и \`${t2}\` собраны из \`Dockerfile\` ниже (разные версии исходников). На хосте выполняют по очереди:`
		);
	} else if (s.build) out.push('Образ собирают из `Dockerfile` ниже и запускают:');
	else out.push(`Образ \`${t}\` собран из \`Dockerfile\` ниже. Контейнер запускают так:`);
	out.push('', '```', ...(s.build ? [s.build.join(' ')] : []), ...s.runs.map((r) => r.join(' ')), '```', '');
	if (s.kind !== 'files') out.push(baseText(s), '');
	for (const [name, lines] of Object.entries(s.envFiles)) out.push(`Файл \`${name}\`:`, '', '```', ...lines, '```', '');
	for (const [name, value] of Object.entries(s.hostEnv))
		out.push(`В шелле, где запускают \`docker run\`, переменная \`${name}\` равна \`${value}\`.`, '');
	if (s.kind === 'files') {
		out.push('Содержимое каталогов (только файлы, подкаталогов нет):', '');
		for (const [image, dirs] of Object.entries(s.images))
			for (const [dir, names] of Object.entries(dirs)) out.push(`- образ \`${image}\`, \`${dir}\`: ${listing(names)};`);
		for (const [dir, names] of Object.entries(s.hostDirs)) out.push(`- каталог хоста \`${dir}\`: ${listing(names)};`);
		const volumes = new Set(
			s.runs.flatMap((r) =>
				parseRun(r)
					.mounts.filter((m) => !m.bind)
					.map((m) => m.src)
			)
		);
		for (const v of volumes) {
			const existing = s.volumes[v];
			out.push(
				existing ? `- том \`${v}\` уже существует: ${listing(existing)}.` : `- тома \`${v}\` до первой команды нет.`
			);
		}
		if (s.writes.length > 0)
			out.push(
				'',
				`Процесс первого контейнера создаёт ${s.writes.length > 1 ? 'файлы' : 'файл'} ${listing(s.writes.map((w) => w.path))} и завершается; контейнер удаляют.`
			);
		out.push('');
	}
	out.push('Правила:', '');
	if (s.kind === 'ports' || s.kind === 'ports-user')
		out.push(
			...numbered([...PORT_RULES, ...(junior ? JUNIOR_PORT_RULES : []), ...(s.kind === 'ports-user' ? USER_RULES : [])])
		);
	else if (s.kind === 'env') out.push(...numbered([...ENV_RULES, ...(junior ? JUNIOR_ENV_RULES : [])]));
	else out.push(...numbered(FILE_RULES));
	out.push('');
	if (s.kind === 'ports' || s.kind === 'ports-user') {
		out.push(
			s.kind === 'ports'
				? 'Введите опубликованные порты контейнера — по одному в строке, в любом порядке, в виде `адрес:порт_хоста->порт_контейнера/протокол`. Например:'
				: 'Введите опубликованные порты контейнера — по одному в строке, в виде `адрес:порт_хоста->порт_контейнера/протокол`, — и ещё две строки: `user=<пользователь>` (как он задан: `app`, `1000`, `10001:10001`) и `workdir=<каталог>`. Порядок строк любой. Например:',
			'',
			'```',
			'0.0.0.0:random->8080/tcp',
			'127.0.0.1:15432->5432/tcp',
			...(s.kind === 'ports-user' ? ['user=app', 'workdir=/srv/app'] : []),
			'```'
		);
	} else if (s.kind === 'env') {
		out.push(
			`Какие значения увидит процесс контейнера? Для каждой переменной — ${s.askNames.map((n) => `\`${n}\``).join(', ')} — введите строку \`ИМЯ=значение\` (пустое значение — \`ИМЯ=\`), а если переменной нет в окружении — \`ИМЯ unset\`. Порядок строк любой. Например:`,
			'',
			'```',
			'LOG_LEVEL=info',
			'BUILD_ID unset',
			'```'
		);
	} else {
		out.push(
			`Какие файлы видит ${s.runs.length > 1 ? 'второй ' : ''}контейнер в каталогах ${s.askDirs.map((d) => `\`${d}\``).join(', ')}? Введите полные пути, по одному в строке, в любом порядке. Например:`,
			'',
			'```',
			'/app/config/app.yaml',
			'/app/static/main.js',
			'```'
		);
	}
	return out.join('\n');
}

// --- Reference ---------------------------------------------------------------------------------------------------

const PYTHON_REFERENCE = `import json
import re
import shlex

data = json.loads(input())
kind = data["kind"]
base = data["base"]

instrs = []
for raw in data["dockerfile"].split("\\n"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    op, _, rest = line.partition(" ")
    instrs.append((op.upper(), rest.strip()))

WITH_VALUE = {"-p", "-e", "--env-file", "-v", "--mount", "-u", "-w", "--name"}


def parse_run(cmd):
    w = shlex.split(cmd)
    run = {"p": [], "P": False, "env": [], "mounts": [], "user": None, "workdir": None}
    i = 2
    while w[i].startswith("-"):
        flag = w[i]
        if flag not in WITH_VALUE:
            if flag == "-P":
                run["P"] = True
            i += 1
            continue
        value = w[i + 1]
        i += 2
        if flag == "-p":
            run["p"].append(value)
        elif flag == "-e":
            run["env"].append(("e", value))
        elif flag == "--env-file":
            run["env"].append(("file", value))
        elif flag == "-u":
            run["user"] = value
        elif flag == "-w":
            run["workdir"] = value
        elif flag == "-v":
            src, dst = value.split(":")[:2]
            run["mounts"].append(("bind" if src.startswith("/") else "volume", src, dst))
        elif flag == "--mount":
            kv = dict(part.split("=", 1) for part in value.split(","))
            run["mounts"].append((kv["type"], kv["src"], kv["dst"]))
    run["image"] = w[i]
    return run


def with_proto(p):
    return p if "/" in p else p + "/tcp"


def ports_of(run):
    exposed = [with_proto(p) for p in base["expose"]]
    for op, rest in instrs:
        if op == "EXPOSE":
            exposed += [with_proto(p) for p in rest.split()]
    result = set()
    bound = set()
    for spec in run["p"]:
        addr, _, proto = spec.partition("/")
        proto = proto or "tcp"
        parts = addr.split(":")
        if len(parts) == 1:
            ip, hp, cp = "", "", parts[0]
        elif len(parts) == 2:
            ip, hp, cp = "", parts[0], parts[1]
        else:
            ip, hp, cp = parts

        def spread(text):
            lo, _, hi = text.partition("-")
            return list(range(int(lo), int(hi or lo) + 1))

        cps = spread(cp)
        hps = spread(hp) if hp else ["random"] * len(cps)
        assert len(hps) == len(cps)
        for c, h in zip(cps, hps):
            result.add("%s:%s->%d/%s" % (ip or "0.0.0.0", h, c, proto))
            bound.add("%d/%s" % (c, proto))
    if run["P"]:
        for e in exposed:
            if e not in bound:
                result.add("0.0.0.0:random->" + e)
    return result


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


def user_of(run):
    user, cwd = base["user"], base["workdir"]
    for op, rest in instrs:
        if op == "USER":
            user = rest
        elif op == "WORKDIR":
            cwd = resolve(cwd, rest)
    if run["user"] is not None:
        user = run["user"]
    if run["workdir"] is not None:
        cwd = run["workdir"]
    return {"user=" + user, "workdir=" + cwd}


VAR = re.compile(r"\\$\\{(\\w+)\\}|\\$(\\w+)")


def env_of(run):
    build_args = {}
    if data["build"]:
        bw = shlex.split(data["build"])
        for k, word in enumerate(bw):
            if word == "--build-arg":
                name, _, value = bw[k + 1].partition("=")
                build_args[name] = value
    glob, args, env = {}, {}, {}
    in_stage = False
    for op, rest in instrs:
        if op == "FROM":
            in_stage = True
            env = {k: v for k, v in base["env"]}
            args = {}
        elif op == "ARG":
            name, has_default, default = rest.partition("=")
            if name in build_args:
                value = build_args[name]
            elif has_default:
                value = default
            elif in_stage and name in glob:
                value = glob[name]
            else:
                value = ""
            (args if in_stage else glob)[name] = value
        elif op == "ENV":
            name, _, raw = rest.partition("=")

            def sub(m):
                n = m.group(1) or m.group(2)
                if n in env:
                    return env[n]
                return args.get(n, "")

            env[name] = VAR.sub(sub, raw)

    def pair(text):
        name, has, value = text.partition("=")
        return (name, value) if has else (name, data["host_env"][name])

    pairs = []
    for source, value in run["env"]:
        if source == "file":
            for line in data["env_files"][value]:
                if line.strip() and not line.startswith("#"):
                    pairs.append(pair(line))
    for source, value in run["env"]:
        if source == "e":
            pairs.append(pair(value))
    for name, value in pairs:
        env[name] = value
    return {n + "=" + env[n] if n in env else n + " unset" for n in data["ask_names"]}


def files_of():
    volumes = {k: list(v) for k, v in data["volumes"].items()}
    host = {k: list(v) for k, v in data["host_dirs"].items()}
    result = set()
    runs = data["runs"]
    for index, cmd in enumerate(runs):
        run = parse_run(cmd)
        image = data["images"][run["image"]]
        mounts = {dst: (kind_, src) for kind_, src, dst in run["mounts"]}
        for dst, (kind_, src) in mounts.items():
            if kind_ == "volume" and not volumes.get(src):
                volumes[src] = list(image.get(dst, []))
        for w in data["writes"]:
            if w["run"] != index:
                continue
            folder, _, name = w["path"].rpartition("/")
            kind_, src = mounts[folder]
            store = host if kind_ == "bind" else volumes
            if name not in store[src]:
                store[src].append(name)
        if index == len(runs) - 1:
            for folder in data["ask_dirs"]:
                if folder in mounts:
                    kind_, src = mounts[folder]
                    names = (host if kind_ == "bind" else volumes)[src]
                else:
                    names = image.get(folder, [])
                result.update(folder + "/" + n for n in names)
    return result


last = parse_run(data["runs"][-1])
if kind == "ports":
    answer = ports_of(last)
elif kind == "ports-user":
    answer = ports_of(last) | user_of(last)
elif kind == "env":
    answer = env_of(last)
else:
    answer = files_of()
print("\\n".join(sorted(answer)) if answer else "-")
`;

// --- Build -------------------------------------------------------------------------------------------------------

const SCENARIOS: Record<string, (rng: Rng) => Scenario> = {
	'intern/publish-flags': internPorts,
	'intern/env-precedence': internEnv,
	'intern/mount-shadowing': internFiles,
	'intern/publish-all': internPublishAll,
	'junior/publish-ranges': juniorPorts,
	'junior/env-build-args': juniorEnv,
	'junior/volume-reuse': juniorFiles,
	'junior/publish-all-inherit': juniorPublishAll
};

const REQUIRED: Record<string, string[]> = {
	'intern/publish-flags': ['expose-publishes', 'swap-host-container', 'p-requires-expose', 'localhost-default'],
	'intern/env-precedence': ['arg-visible', 'first-wins', 'image-env-wins'],
	'intern/mount-shadowing': ['mount-merges', 'bind-copies'],
	'intern/publish-all': ['publish-all-same-port', 'run-flags-ignored'],
	'junior/publish-ranges': ['expose-publishes', 'range-first-only', 'swap-host-container'],
	'junior/env-build-args': ['arg-visible', 'env-ref-runtime', 'base-env-lost'],
	'junior/volume-reuse': ['volume-recopies', 'mount-merges'],
	'junior/publish-all-inherit': ['inherited-expose-ignored', 'publish-all-overrides']
};

const LEVEL_WRONG: Record<string, string[]> = {
	intern: [
		'expose-publishes',
		'swap-host-container',
		'localhost-default',
		'p-requires-expose',
		'publish-all-same-port',
		'run-flags-ignored',
		'arg-visible',
		'first-wins',
		'image-env-wins',
		'cmdline-order',
		'mount-merges',
		'bind-copies',
		'volume-empty'
	],
	junior: [
		'expose-publishes',
		'swap-host-container',
		'p-requires-expose',
		'range-first-only',
		'repeat-last-wins',
		'publish-all-same-port',
		'publish-all-overrides',
		'inherited-expose-ignored',
		'run-flags-ignored',
		'inherited-user-lost',
		'arg-visible',
		'image-env-wins',
		'build-arg-ignored',
		'global-arg-visible',
		'env-ref-runtime',
		'base-env-lost',
		'mount-merges',
		'bind-copies',
		'volume-empty',
		'volume-recopies'
	]
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const make = SCENARIOS[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId}`);
	for (let tries = 0; tries < 200; tries += 1) {
		const s = make(rng);
		const answer = evaluate(s, RIGHT);
		const same = (v: string[]): boolean => v.length === answer.length && v.every((x, i) => x === answer[i]);
		const allowed = LEVEL_WRONG[input.grade] ?? [];
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				if (!allowed.includes(id)) return [id, null];
				const value = evaluate(s, { ...RIGHT, ...change });
				return [id, same(value) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const source = s.lines.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: statement(s, junior), code: { language: 'dockerfile', source } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({
					kind: s.kind,
					dockerfile: source,
					base: s.base,
					build: s.build ? s.build.join(' ') : null,
					runs: s.runs.map((r) => r.join(' ')),
					env_files: s.envFiles,
					host_env: s.hostEnv,
					images: s.images,
					host_dirs: s.hostDirs,
					volumes: s.volumes,
					writes: s.writes,
					ask_names: s.askNames,
					ask_dirs: s.askDirs
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
