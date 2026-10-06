// The build context and `.dockerignore`: which files of the context end up in the image and editing which files
// invalidates the cache of a given COPY. Patterns follow Go path matching with `**`; a pattern also matches the
// contents of a directory it names; `!` re-includes; the last matching line decides.
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
	files: string[];
	ignore: string[];
	dockerfile: string[];
	/** The line of the COPY asked about, or null when the question is what ends up in the image. */
	askLine: number | null;
}

interface Rules {
	firstMatch: boolean;
	globRecursive: boolean;
	starCrossesSlash: boolean;
	noParentMatch: boolean;
	negationIgnored: boolean;
	ignoredCountsCache: boolean;
}

const RIGHT: Rules = {
	firstMatch: false,
	globRecursive: false,
	starCrossesSlash: false,
	noParentMatch: false,
	negationIgnored: false,
	ignoredCountsCache: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'first-match': { firstMatch: true },
	'glob-recursive': { globRecursive: true },
	'star-crosses-slash': { starCrossesSlash: true },
	'no-parent-match': { noParentMatch: true },
	'negation-ignored': { negationIgnored: true },
	'ignored-counts-cache': { ignoredCountsCache: true }
};

function segmentRegex(segment: string, rules: Rules): string {
	let out = '';
	for (const ch of segment) {
		if (ch === '*') out += rules.starCrossesSlash ? '.*' : '[^/]*';
		else if (ch === '?') out += '[^/]';
		else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return out;
}

function patternRegex(pattern: string, rules: Rules): RegExp {
	const segments = pattern.split('/');
	let body = '';
	segments.forEach((segment, i) => {
		const last = i === segments.length - 1;
		if (segment === '**') body += last ? '.*' : '(?:[^/]+/)*';
		else body += segmentRegex(segment, rules) + (last ? '' : '/');
	});
	return new RegExp(`^${body}$`);
}

function clean(pattern: string): string {
	return pattern.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Whether a pattern matches a path itself or one of its parent directories. */
function matches(pattern: string, path: string, rules: Rules): boolean {
	const p = clean(pattern);
	const parts = path.split('/');
	const candidates = rules.noParentMatch ? [path] : parts.map((_, i) => parts.slice(0, i + 1).join('/'));
	if (rules.globRecursive && !p.includes('/')) {
		const re = patternRegex(p, rules);
		return parts.some((part) => re.test(part));
	}
	const re = patternRegex(p, rules);
	return candidates.some((c) => re.test(c));
}

function excluded(s: Scenario, path: string, rules: Rules): boolean {
	let result = false;
	for (const raw of s.ignore) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const negated = line.startsWith('!');
		if (negated && rules.negationIgnored) continue;
		if (!matches(negated ? line.slice(1) : line, path, rules)) continue;
		result = !negated;
		if (rules.firstMatch) return result;
	}
	return result;
}

/** Context files a COPY source covers: `.`, a directory, a glob or the file itself. */
function covers(source: string, file: string): boolean {
	const s = clean(source.replace(/^\.\//, ''));
	if (s === '.' || s === '') return true;
	if (s.includes('*') || s.includes('?')) {
		const parts = file.split('/');
		const re = patternRegex(s, RIGHT);
		return parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/')));
	}
	return file === s || file.startsWith(`${s}/`);
}

function copySources(line: string): string[] | null {
	const words = line.trim().split(/\s+/);
	if (words[0] !== 'COPY' || words.some((w) => w.startsWith('--from='))) return null;
	const plain = words.slice(1).filter((w) => !w.startsWith('--'));
	return plain.slice(0, -1);
}

function evaluate(s: Scenario, rules: Rules): string[] {
	const sent = s.files.filter((f) => !excluded(s, f, rules));
	let out: string[];
	if (s.askLine !== null) {
		const sources = copySources(s.dockerfile[s.askLine - 1] ?? '') ?? [];
		const pool = rules.ignoredCountsCache ? s.files : sent;
		out = pool.filter((f) => sources.some((src) => covers(src, f)));
	} else {
		const all = s.dockerfile.flatMap((l) => copySources(l) ?? []);
		out = sent.filter((f) => all.some((src) => covers(src, f)));
	}
	return out.length === 0 ? ['-'] : [...out].sort();
}

// --- Scenarios -------------------------------------------------------------------------------------------------

const ROOT = ['README.md', 'CHANGELOG.md', '.env', '.env.example', 'docker-compose.yml', 'tsconfig.json', 'debug.log'];
const SRC = [
	'src/index.ts',
	'src/app.ts',
	'src/routes/users.ts',
	'src/routes/orders.ts',
	'src/app.test.ts',
	'src/routes/users.test.ts',
	'src/README.md',
	'src/__snapshots__/app.test.ts.snap'
];
const DOCS = ['docs/api.md', 'docs/setup.md', 'docs/images/arch.png'];
const CONFIG = ['config/default.yaml', 'config/production.yaml', 'config/local.yaml'];
const TEST = ['test/e2e/login.spec.ts', 'test/fixtures/users.json'];
const NOISE = ['node_modules/express/index.js', '.git/HEAD', 'coverage/lcov.info'];
const LOGS = ['logs/app.log', 'logs/archive/2026-09.log', 'logs/.keep'];

function pickFiles(rng: Rng, must: readonly string[]): string[] {
	const files = new Set<string>(['package.json', 'package-lock.json', ...must]);
	for (const f of rng.sample(ROOT, rng.int(2, 5))) files.add(f);
	for (const f of rng.sample(SRC, rng.int(3, 6))) files.add(f);
	for (const f of rng.sample(DOCS, rng.int(0, 3))) files.add(f);
	for (const f of rng.sample(CONFIG, rng.int(1, 3))) files.add(f);
	for (const f of rng.sample(TEST, rng.int(0, 2))) files.add(f);
	for (const f of rng.sample(NOISE, rng.int(1, 3))) files.add(f);
	return [...files].sort();
}

function dockerfile(rng: Rng, explicit: boolean): string[] {
	const lines = [`FROM node:${rng.pick(['20', '22'])}-bookworm-slim`, 'WORKDIR /app'];
	lines.push(rng.pick(['COPY package.json package-lock.json ./', 'COPY package*.json ./']), 'RUN npm ci');
	if (explicit) {
		lines.push(rng.pick(['COPY src/ ./src/', 'COPY src ./src']));
		if (rng.bool(0.7)) lines.push(rng.pick(['COPY config/ ./config/', 'COPY config/*.yaml ./config/']));
		if (rng.bool(0.4)) lines.push(rng.pick(['COPY docs/ ./docs/', 'COPY *.md ./']));
		if (rng.bool(0.4)) lines.push('COPY tsconfig.json ./');
	} else lines.push('COPY . .');
	lines.push('RUN npm run build', 'CMD ["node", "dist/index.js"]');
	return lines;
}

const BASE_IGNORE = ['.git', 'node_modules', 'coverage/', '.env'];

function scenario(rng: Rng, classId: string): Scenario {
	const ignore: string[] = [...rng.sample(BASE_IGNORE, rng.int(1, 4))];
	let must: string[] = [];
	let explicit = rng.bool(0.3);
	let askLine: number | null = null;
	const groups: string[][] = [];
	if (classId === 'negation-order') {
		// Exclusion and re-inclusion of the same files, in either order.
		const options: [string, string, string[]][] = [
			['docs', '!docs/api.md', ['docs/api.md', 'docs/setup.md']],
			['*.md', '!README.md', ['README.md', 'CHANGELOG.md']],
			['config/*.yaml', '!config/default.yaml', ['config/default.yaml', 'config/local.yaml']],
			['**/*.test.ts', '!src/app.test.ts', ['src/app.test.ts', 'src/routes/users.test.ts']]
		];
		for (const [ex, re, files] of rng.sample(options, rng.int(2, 3))) {
			groups.push(rng.bool() ? [ex, re] : [re, ex]);
			must = [...must, ...files];
		}
	} else if (classId === 'root-glob') {
		const options: string[][] = [
			[rng.pick(['*.md', '/*.md'])],
			['*.log'],
			['*.test.ts'],
			['**/*.md', '!README.md'],
			['**/*.log'],
			['src/*.ts', '!src/index.ts']
		];
		for (const g of rng.sample(options, rng.int(2, 3))) groups.push(g);
		must = [
			'README.md',
			'src/README.md',
			'debug.log',
			'logs/app.log',
			'src/app.test.ts',
			'src/routes/users.test.ts',
			'docs/api.md'
		];
		must = rng.sample(must, rng.int(4, 7));
	} else if (classId === 'cache-trigger') {
		explicit = true;
		const options: string[][] = [
			['**/*.test.ts'],
			['src/**/__snapshots__'],
			['config/local.yaml'],
			['**/README.md'],
			['src/*.test.ts'],
			['*.md']
		];
		for (const g of rng.sample(options, rng.int(2, 3))) groups.push(g);
		must = [
			'src/app.test.ts',
			'src/routes/users.test.ts',
			'src/__snapshots__/app.test.ts.snap',
			'src/README.md',
			'config/local.yaml'
		];
		must = rng.sample(must, rng.int(3, 5));
	} else {
		const options: string[][] = [
			['logs', '!logs/.keep'],
			['docs/', '!docs/images/arch.png'],
			['test', '!test/fixtures'],
			['config/', '!config/default.yaml', 'config/production.yaml']
		];
		for (const g of rng.sample(options, rng.int(2, 3))) groups.push(g);
		must = [
			...LOGS,
			'docs/images/arch.png',
			'docs/setup.md',
			'test/fixtures/users.json',
			'test/e2e/login.spec.ts',
			'config/default.yaml',
			'config/production.yaml'
		];
		must = rng.sample(must, rng.int(5, 8));
	}
	for (const g of rng.shuffle(groups)) ignore.push(...g);
	const files = pickFiles(rng, must);
	const df = dockerfile(rng, explicit);
	if (classId === 'cache-trigger') {
		const copies = df
			.map((l, i) => ({ l, i }))
			.filter(({ l }) => l.startsWith('COPY ') && !l.includes('package'))
			.map(({ i }) => i + 1);
		askLine = rng.pick(copies);
	}
	return { files, ignore: rng.bool(0.4) ? ['# сборка', ...ignore] : ignore, dockerfile: df, askLine };
}

// --- Statement -------------------------------------------------------------------------------------------------

function statement(s: Scenario): string {
	return [
		'Контекст сборки (корень проекта) содержит файлы:',
		'',
		...s.files.map((f) => `- \`${f}\``),
		'',
		'Файл `.dockerignore`:',
		'',
		'```',
		...s.ignore,
		'```',
		'',
		'Образ собирают командой `docker build .` по `Dockerfile` ниже. Правила `.dockerignore` в этой задаче:',
		'',
		'1. Каждая непустая строка, кроме комментариев `#`, — шаблон пути от корня контекста; начальный и конечный `/` отбрасываются. `*` — любая последовательность символов, кроме `/`; `?` — один символ, кроме `/`; `**` — любое число каталогов, в том числе ни одного.',
		'2. Шаблон подходит к файлу, если совпадает с его путём целиком или с путём одного из его родительских каталогов (так шаблон каталога исключает всё его содержимое).',
		'3. Строка с `!` возвращает подходящие файлы в контекст. Решает последняя подходящая к файлу строка; если не подошла ни одна, файл остаётся в контексте.',
		'4. В образ (и в расчёт кэша `COPY`) попадают только файлы, оставшиеся в контексте. `COPY` с источником `.` берёт весь контекст, с каталогом — всё в нём, с шаблоном (`*.md`, `package*.json`) — подходящие по тем же правилам `*`.',
		'',
		s.askLine === null
			? 'Введите пути (как в списке) всех файлов контекста, которые окажутся в образе, по одному в строке, в любом порядке; если таких нет — одна строка `-`. Например:'
			: `Образ уже собран, кэш полон. Правка какого файла из списка сбросит кэш инструкции в строке ${s.askLine}? Введите пути всех таких файлов (как в списке) по одному в строке, в любом порядке; если таких нет — одна строка \`-\`. Например:`,
		'',
		'```',
		'package.json',
		'src/index.ts',
		'```'
	].join('\n');
}

// --- Reference ---------------------------------------------------------------------------------------------------

const PYTHON_REFERENCE = `import json
import re

data = json.loads(input())


def to_regex(pattern):
    parts = pattern.split("/")
    out = ""
    for i, part in enumerate(parts):
        last = i == len(parts) - 1
        if part == "**":
            out += ".*" if last else "(?:[^/]+/)*"
            continue
        for ch in part:
            if ch == "*":
                out += "[^/]*"
            elif ch == "?":
                out += "[^/]"
            else:
                out += re.escape(ch)
        if not last:
            out += "/"
    return re.compile(out)


def hits(pattern, path):
    pattern = pattern.strip("/")
    rx = to_regex(pattern)
    pieces = path.split("/")
    return any(rx.fullmatch("/".join(pieces[: i + 1])) for i in range(len(pieces)))


def ignored(path):
    verdict = False
    for raw in data["ignore"]:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("!"):
            if hits(line[1:], path):
                verdict = False
        elif hits(line, path):
            verdict = True
    return verdict


def sources(line):
    words = line.split()
    if not words or words[0] != "COPY" or any(w.startswith("--from=") for w in words):
        return []
    plain = [w for w in words[1:] if not w.startswith("--")]
    return plain[:-1]


def taken(source, path):
    if source.startswith("./"):
        source = source[2:]
    source = source.strip("/")
    if source in (".", ""):
        return True
    if "*" in source or "?" in source:
        return hits(source, path)
    return path == source or path.startswith(source + "/")


kept = [f for f in data["files"] if not ignored(f)]
if data["askLine"] is None:
    srcs = [s for line in data["dockerfile"] for s in sources(line)]
else:
    srcs = sources(data["dockerfile"][data["askLine"] - 1])
result = sorted(f for f in kept if any(taken(s, f) for s in srcs))
print("\\n".join(result) if result else "-")
`;

// --- Build -------------------------------------------------------------------------------------------------------

const REQUIRED: Record<string, string[]> = {
	'negation-order': ['first-match'],
	'root-glob': ['glob-recursive'],
	'cache-trigger': ['ignored-counts-cache'],
	'dir-reinclude': ['no-parent-match', 'negation-ignored']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 200; tries += 1) {
		const s = scenario(rng, input.classId);
		const answer = evaluate(s, RIGHT);
		const key = answer.join('\n');
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				if (id === 'ignored-counts-cache' && s.askLine === null) return [id, null];
				const value = evaluate(s, { ...RIGHT, ...change });
				return [id, value.join('\n') === key ? null : value];
			})
		);
		if ((REQUIRED[input.classId] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: statement(s), code: { language: 'dockerfile', source: s.dockerfile.join('\n') } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ files: s.files, ignore: s.ignore, dockerfile: s.dockerfile, askLine: s.askLine })
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
