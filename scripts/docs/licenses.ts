// Table of the technologies of the solution with versions and licences (documentation section «Технологии»), and the
// licence check: every component must carry a licence of ALLOWED_LICENSES or an exception with a stated reason.
// Sources: `pnpm licenses` for npm packages, uv.lock for Python packages, the compose files and Dockerfiles for images
// and operating system packages, docs/models.md for models, static/fonts for fonts; licences the checkout does not
// carry come from license-data.ts. Runs with plain Node: `pnpm docs:licenses`.
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MERMAID_IMAGE, PANDOC_IMAGE } from './images.ts';
import {
	ALLOWED_LICENSES,
	CHROMIUM_LICENSE,
	FONTS,
	IMAGE_LICENSE_SOURCE,
	IMAGE_LICENSES,
	LICENSE_EXCEPTIONS,
	MODEL_LICENSE_SOURCE,
	MODELS,
	PYTHON_LICENSE_SOURCE,
	PYTHON_LICENSES,
	SYSTEM_LICENSE_SOURCE,
	SYSTEM_LICENSES,
	type ComponentKind,
	type LicenseException
} from './license-data.ts';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const TECHNOLOGIES_FILE = join(ROOT, 'docs/submission/generated/technologies.md');

export interface Component {
	kind: ComponentKind;
	name: string;
	version: string;
	license: string;
	/** Where the licence was read. */
	source: string;
	note?: string;
}

export interface ComponentGroup {
	title: string;
	description: string;
	components: Component[];
}

// --- Licence check -----------------------------------------------------------------------------------------------

/**
 * Alternatives of an SPDX expression, each a list of identifiers that all apply: `A OR (B AND C)` is not supported,
 * only a flat `OR` of `AND`s, optionally in outer parentheses. `X WITH Y` stays one identifier. Null when unparsed.
 */
export function parseExpression(expression: string): string[][] | null {
	let text = expression.trim();
	if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
	if (text === '' || /[()]/.test(text)) return null;
	return text.split(/\s+OR\s+/).map((alternative) => alternative.split(/\s+AND\s+/).map((id) => id.trim()));
}

/** Whether an expression leaves at least one alternative made of allowed licences only. */
export function isAllowed(expression: string, allowed: Readonly<Record<string, string>>): boolean {
	const alternatives = parseExpression(expression);
	return alternatives !== null && alternatives.some((ids) => ids.every((id) => Object.hasOwn(allowed, id)));
}

export class LicenseCheckError extends Error {
	readonly problems: readonly string[];

	constructor(problems: readonly string[]) {
		super(`Licence check failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
		this.name = 'LicenseCheckError';
		this.problems = problems;
	}
}

export interface ExceptedComponent {
	component: Component;
	exception: LicenseException;
}

/**
 * Checks every component against the allowed licences and the exceptions; throws a LicenseCheckError listing every
 * problem: a licence outside the list without an exception, an exception granted for another licence, and an exception
 * that matches no component or is not needed (its component is allowed anyway) — a stale exception hides nothing but
 * reads as a decision still in force. Returns the excepted components, one entry per component version.
 */
export function checkLicenses(
	components: readonly Component[],
	exceptions: readonly LicenseException[],
	allowed: Readonly<Record<string, string>> = ALLOWED_LICENSES
): ExceptedComponent[] {
	const problems: string[] = [];
	const used = new Set<LicenseException>();
	const excepted: ExceptedComponent[] = [];
	for (const component of components) {
		const exception = exceptions.find((entry) => entry.kind === component.kind && entry.name === component.name);
		if (exception !== undefined) used.add(exception);
		if (isAllowed(component.license, allowed)) continue;
		const label = `${component.kind} ${component.name}@${component.version} (${component.license})`;
		if (exception === undefined) {
			problems.push(
				parseExpression(component.license) === null
					? `${label}: licence is not an SPDX expression`
					: `${label}: licence is not allowed and has no exception in license-data.ts`
			);
		} else if (exception.license !== component.license) {
			problems.push(`${label}: the exception was granted for ${exception.license}`);
		} else if (
			!excepted.some(
				(entry) => entry.exception === exception && entry.component.version === component.version
			)
		) {
			excepted.push({ component, exception });
		}
	}
	for (const exception of exceptions) {
		if (!used.has(exception)) problems.push(`exception ${exception.kind} ${exception.name} matches no component`);
	}
	for (const exception of exceptions) {
		const covered = components.filter(
			(component) => component.kind === exception.kind && component.name === exception.name
		);
		if (covered.length > 0 && covered.every((component) => isAllowed(component.license, allowed))) {
			problems.push(`exception ${exception.kind} ${exception.name} is not needed: its licence is allowed`);
		}
	}
	if (problems.length > 0) throw new LicenseCheckError(problems);
	return excepted;
}

// --- npm ---------------------------------------------------------------------------------------------------------

interface PnpmLicenseEntry {
	name: string;
	versions: string[];
	license: string;
}

function pnpmLicenses(dir: string, prodOnly: boolean): PnpmLicenseEntry[] {
	const args = ['licenses', 'list', '--json', ...(prodOnly ? ['--prod'] : [])];
	const output = execFileSync('pnpm', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	const parsed = JSON.parse(output) as unknown;
	if (parsed === null || typeof parsed !== 'object') throw new Error(`pnpm licenses in ${dir}: unexpected output`);
	const entries: PnpmLicenseEntry[] = [];
	for (const group of Object.values(parsed)) {
		if (!Array.isArray(group)) throw new Error(`pnpm licenses in ${dir}: unexpected output`);
		for (const entry of group as unknown[]) {
			const { name, versions, license } = entry as Partial<PnpmLicenseEntry>;
			if (typeof name !== 'string' || !Array.isArray(versions) || typeof license !== 'string') {
				throw new Error(`pnpm licenses in ${dir}: entry without name, versions or licence`);
			}
			entries.push({ name, versions, license });
		}
	}
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function npmComponent(entry: PnpmLicenseEntry): Component {
	return {
		kind: 'npm',
		name: entry.name,
		version: entry.versions.join(', '),
		license: entry.license,
		source: 'package.json пакета'
	};
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Runtime dependencies with their whole tree, and the direct development dependencies (framework, build, tests). */
function npmGroups(): ComponentGroup[] {
	const manifest = readJson(join(ROOT, 'package.json'));
	const devNames = new Set(Object.keys(manifest.devDependencies ?? {}));
	const all = pnpmLicenses(ROOT, false);
	const dev = all.filter((entry) => devNames.has(entry.name));
	if (dev.length !== devNames.size) {
		const found = new Set(dev.map((entry) => entry.name));
		throw new Error(`pnpm licenses misses dev dependencies: ${[...devNames].filter((n) => !found.has(n)).join(', ')}`);
	}
	return [
		{
			title: 'Приложение: зависимости времени выполнения (npm)',
			description: 'Всё дерево `dependencies` из `package.json` — то, что ставится в образ приложения.',
			components: pnpmLicenses(ROOT, true).map(npmComponent)
		},
		{
			title: 'Приложение: фреймворк, сборка и тесты (npm, прямые)',
			description:
				'Прямые `devDependencies`: SvelteKit, Svelte, Tailwind CSS и компоненты интерфейса входят в собранный бандл; ' +
				'остальное — сборка, проверки и тесты.',
			components: dev.map(npmComponent)
		},
		{
			title: 'Имитатор ФСП ID и реестра ФСП (npm)',
			description: 'Сервис `services/fsp-mock`: OIDC-провайдер и выгрузка достижений для стенда; дерево `dependencies`.',
			components: pnpmLicenses(join(ROOT, 'services/fsp-mock'), true).map(npmComponent)
		}
	];
}

// --- Python ------------------------------------------------------------------------------------------------------

interface LockedPackage {
	name: string;
	version: string;
	virtual: boolean;
	dependencies: { name: string; marker?: string }[];
}

/** PEP 503 normalised name. */
export function normalizePythonName(name: string): string {
	return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Packages of a uv.lock: name, version, whether it is the project itself, and its runtime dependencies. */
export function parseUvLock(text: string): LockedPackage[] {
	const packages: LockedPackage[] = [];
	let current: LockedPackage | undefined;
	let section = '';
	let inDependencies = false;
	for (const line of text.split('\n')) {
		if (line === '[[package]]') {
			current = { name: '', version: '', virtual: false, dependencies: [] };
			packages.push(current);
			section = 'package';
			continue;
		}
		if (line.startsWith('[')) {
			section = line;
			inDependencies = false;
			continue;
		}
		if (current === undefined || section !== 'package') continue;
		if (inDependencies) {
			if (line.trim() === ']') {
				inDependencies = false;
				continue;
			}
			const dependency = /^\s+\{ name = "([^"]+)"(?:.*?marker = "([^"]+)")?/.exec(line);
			if (dependency?.[1] === undefined) throw new Error(`uv.lock: unexpected dependency line: ${line}`);
			current.dependencies.push({
				name: dependency[1],
				...(dependency[2] === undefined ? {} : { marker: dependency[2] })
			});
			continue;
		}
		const field = /^(\w[\w-]*) = (.*)$/.exec(line);
		if (field === null) continue;
		const [, key, value] = field;
		if (key === 'name') current.name = JSON.parse(value ?? '') as string;
		else if (key === 'version') current.version = JSON.parse(value ?? '') as string;
		else if (key === 'source') current.virtual = value?.startsWith('{ virtual') === true;
		else if (key === 'dependencies') {
			if (value === '[') inDependencies = true;
			else throw new Error(`uv.lock: dependencies of ${current.name} are not a multi-line list`);
		}
	}
	return packages;
}

/** Marker environment of our Python images: CPython on Linux. */
const MARKER_ENVIRONMENT: Readonly<Record<string, string>> = {
	sys_platform: 'linux',
	platform_system: 'Linux',
	os_name: 'posix',
	implementation_name: 'cpython',
	platform_python_implementation: 'CPython'
};

/** Evaluates a single-comparison environment marker (`var == 'x'` or `var != 'x'`); anything else is an error. */
export function markerApplies(marker: string): boolean {
	const match = /^(\w+) (==|!=) '([^']*)'$/.exec(marker.trim());
	const variable = match?.[1];
	const actual = variable === undefined ? undefined : MARKER_ENVIRONMENT[variable];
	if (match === null || actual === undefined) throw new Error(`uv.lock: unsupported environment marker: ${marker}`);
	return match[2] === '==' ? actual === match[3] : actual !== match[3];
}

/** Runtime closure of the project in a uv.lock (development groups excluded), in name order. */
export function pythonRuntimePackages(text: string): LockedPackage[] {
	const packages = parseUvLock(text);
	const byName = new Map(packages.map((entry) => [normalizePythonName(entry.name), entry]));
	const roots = packages.filter((entry) => entry.virtual);
	if (roots.length !== 1) throw new Error(`uv.lock: expected one project package, found ${roots.length}`);
	const seen = new Set<string>();
	const queue = [...(roots[0]?.dependencies ?? [])];
	while (queue.length > 0) {
		const dependency = queue.shift();
		if (dependency === undefined) break;
		if (dependency.marker !== undefined && !markerApplies(dependency.marker)) continue;
		const name = normalizePythonName(dependency.name);
		if (seen.has(name)) continue;
		const entry = byName.get(name);
		if (entry === undefined) throw new Error(`uv.lock: dependency ${dependency.name} is not locked`);
		seen.add(name);
		queue.push(...entry.dependencies);
	}
	return [...seen].sort().map((name) => byName.get(name) as LockedPackage);
}

function pythonGroup(project: string, title: string, description: string): ComponentGroup {
	const lock = readFileSync(join(ROOT, project, 'uv.lock'), 'utf8');
	return {
		title,
		description,
		components: pythonRuntimePackages(lock).map((entry) => {
			const name = normalizePythonName(entry.name);
			const known = PYTHON_LICENSES[name];
			if (known === undefined) {
				throw new Error(`${project}/uv.lock: add the licence of ${name} to PYTHON_LICENSES in license-data.ts`);
			}
			return {
				kind: 'python',
				name,
				version: entry.version,
				license: known.license,
				source: PYTHON_LICENSE_SOURCE,
				...(known.note === undefined ? {} : { note: known.note })
			};
		})
	};
}

// --- Images and operating system packages ------------------------------------------------------------------------

const COMPOSE_FILES = ['compose.yaml', 'docker-compose.prod.yml'];
/** Images built from this repository: the product itself, licensed under LICENSE. */
const OWN_IMAGE_PREFIX = 'fsp-career-';

function dockerfiles(): string[] {
	return globSync('**/Dockerfile', { cwd: ROOT, exclude: ['**/node_modules/**', 'build/**'] }).sort();
}

interface ImageReference {
	repository: string;
	tag: string;
	pinned: boolean;
}

export function parseImageReference(reference: string): ImageReference {
	const [named, digest] = reference.split('@');
	const colon = named?.lastIndexOf(':') ?? -1;
	if (named === undefined || colon <= named.lastIndexOf('/')) throw new Error(`image ${reference} has no tag`);
	return { repository: named.slice(0, colon), tag: named.slice(colon + 1), pinned: digest !== undefined };
}

function imageComponent(reference: string, usedIn: string[], kind: ComponentKind): Component {
	const { repository, tag, pinned } = parseImageReference(reference);
	const known = IMAGE_LICENSES[repository];
	if (known === undefined) throw new Error(`image ${repository}: add its licence to IMAGE_LICENSES in license-data.ts`);
	return {
		kind,
		name: repository,
		version: pinned ? `${tag} (закреплён digest)` : tag,
		license: known.license,
		source: IMAGE_LICENSE_SOURCE,
		note: `${known.software}; ${usedIn.join(', ')}`
	};
}

function imageGroup(): ComponentGroup {
	const uses = new Map<string, Set<string>>();
	const use = (reference: string, file: string) => {
		if (reference.startsWith(OWN_IMAGE_PREFIX)) return;
		if (reference.includes('$')) throw new Error(`${file}: image ${reference} is not pinned to a literal tag`);
		const files = uses.get(reference) ?? new Set<string>();
		files.add(file);
		uses.set(reference, files);
	};
	for (const file of COMPOSE_FILES) {
		for (const match of readFileSync(join(ROOT, file), 'utf8').matchAll(/^\s+image:\s*(\S+)\s*$/gm)) {
			use(match[1] ?? '', file);
		}
	}
	for (const file of dockerfiles()) {
		for (const match of readFileSync(join(ROOT, file), 'utf8').matchAll(/^ARG \w+_IMAGE=(\S+)\s*$/gm)) {
			use(match[1] ?? '', file);
		}
	}
	return {
		title: 'Контейнерные образы',
		description:
			'Сторонние образы из `compose.yaml`, `docker-compose.prod.yml` и базовые образы наших Dockerfile. Лицензия — у ' +
			'основного ПО образа; базовый слой ОС (Debian, Alpine) состоит из пакетов под их собственными лицензиями и ' +
			'используется как операционная система без изменений.',
		components: [...uses.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([reference, files]) => imageComponent(reference, [...files].sort(), 'image'))
	};
}

/** Packages a Dockerfile installs with apt-get or apk, and Go modules it builds with `go install`. */
export function dockerfilePackages(text: string): { name: string; version: string }[] {
	const joined = text.replace(/\\\n/g, ' ');
	const snapshot = /^ARG DEBIAN_SNAPSHOT=(\S+)/m.exec(text)?.[1];
	const packages: { name: string; version: string }[] = [];
	for (const match of joined.matchAll(/(apt-get install|apk add)([^&\n]*)/g)) {
		const version =
			match[1] === 'apk add'
				? 'репозиторий Alpine базового образа'
				: snapshot === undefined
					? 'репозиторий Debian базового образа'
					: `снимок Debian ${snapshot}`;
		for (const word of (match[2] ?? '').trim().split(/\s+/)) {
			if (word !== '' && !word.startsWith('-')) packages.push({ name: word, version });
		}
	}
	for (const match of joined.matchAll(/go install .*?(\S+)@\$\{(\w+)\}/g)) {
		const variable = match[2] ?? '';
		const version = new RegExp(`^ARG ${variable}=(\\S+)`, 'm').exec(text)?.[1];
		if (version === undefined) throw new Error(`go install of ${match[1] ?? ''}: ARG ${variable} has no default`);
		packages.push({ name: match[1] ?? '', version });
	}
	return packages;
}

function systemGroup(): ComponentGroup {
	const found = new Map<string, { version: string; files: Set<string> }>();
	for (const file of dockerfiles()) {
		for (const entry of dockerfilePackages(readFileSync(join(ROOT, file), 'utf8'))) {
			const known = found.get(entry.name) ?? { version: entry.version, files: new Set<string>() };
			known.files.add(dirname(file));
			found.set(entry.name, known);
		}
	}
	return {
		title: 'Пакеты ОС и модули, собираемые в наших образах',
		description: 'Устанавливаются нашими Dockerfile; версии закреплены снимком репозитория или аргументом сборки.',
		components: [...found.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, { version, files }]) => {
				const known = SYSTEM_LICENSES[name];
				if (known === undefined) throw new Error(`package ${name}: add its licence to SYSTEM_LICENSES in license-data.ts`);
				return {
					kind: 'system',
					name,
					version,
					license: known.license,
					source: SYSTEM_LICENSE_SOURCE,
					note: `${known.purpose}; ${[...files].sort().join(', ')}`
				};
			})
	};
}

// --- Models, fonts, documentation tools --------------------------------------------------------------------------

function modelGroup(): ComponentGroup {
	const guide = readFileSync(join(ROOT, 'docs/models.md'), 'utf8');
	return {
		title: 'Модели и их рантайм',
		description: 'Модели работают в закрытом контуре; как их поднять — `docs/models.md`.',
		components: MODELS.map((model) => {
			if (!guide.includes(model.reference)) {
				throw new Error(`docs/models.md does not mention ${model.reference}: update MODELS in license-data.ts`);
			}
			return {
				kind: 'model',
				name: model.name,
				version: model.version,
				license: model.license,
				source: MODEL_LICENSE_SOURCE,
				note: model.purpose
			};
		})
	};
}

function fontGroup(): ComponentGroup {
	const dirs = readdirSync(join(ROOT, 'static/fonts'), { withFileTypes: true }).filter((entry) => entry.isDirectory());
	return {
		title: 'Шрифты',
		description: 'Файлы шрифтов в `static/fonts`, рядом с каждым — текст лицензии `OFL.txt`.',
		components: dirs
			.map((dir) => dir.name)
			.sort()
			.map((dir) => {
				const font = FONTS[dir];
				if (font === undefined) throw new Error(`static/fonts/${dir}: add the font to FONTS in license-data.ts`);
				if (!existsSync(join(ROOT, 'static/fonts', dir, 'OFL.txt'))) {
					throw new Error(`static/fonts/${dir} has no OFL.txt`);
				}
				return {
					kind: 'font',
					name: font.name,
					version: font.version,
					license: font.license,
					source: `static/fonts/${dir}/OFL.txt`
				};
			})
	};
}

function chromiumVersion(): string {
	const fromTest = createRequire(join(ROOT, 'package.json'));
	const fromPlaywright = createRequire(fromTest.resolve('@playwright/test/package.json'));
	const playwright = createRequire(fromPlaywright.resolve('playwright/package.json'));
	const browsers = readJson(join(dirname(playwright.resolve('playwright-core/package.json')), 'browsers.json'));
	const chromium = (browsers.browsers as { name: string; browserVersion?: string }[]).find((b) => b.name === 'chromium');
	if (chromium?.browserVersion === undefined) throw new Error('playwright-core/browsers.json has no chromium version');
	return chromium.browserVersion;
}

function toolGroup(): ComponentGroup {
	return {
		title: 'Сборка этой документации',
		description: '`pnpm docs:build`: в продукт не входят.',
		components: [
			imageComponent(PANDOC_IMAGE, ['scripts/docs/images.ts'], 'tool'),
			imageComponent(MERMAID_IMAGE, ['scripts/docs/images.ts'], 'tool'),
			{
				kind: 'tool',
				name: 'Chromium (Playwright)',
				version: chromiumVersion(),
				license: CHROMIUM_LICENSE,
				source: 'LICENSE проекта Chromium',
				note: 'печать PDF из HTML'
			}
		]
	};
}

// --- Table -------------------------------------------------------------------------------------------------------

export function collectGroups(): ComponentGroup[] {
	return [
		...npmGroups(),
		pythonGroup(
			'services/docparse',
			'Сервис разбора документов (Python)',
			'`services/docparse`: зависимости времени выполнения из `uv.lock`, без группы `dev`.'
		),
		pythonGroup(
			'tools/eval',
			'Стенд оценки качества (Python)',
			'`tools/eval`: зависимости времени выполнения из `uv.lock`, без группы `dev`. В образы продукта не входит.'
		),
		imageGroup(),
		systemGroup(),
		modelGroup(),
		fontGroup(),
		toolGroup()
	];
}

function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderTechnologies(groups: readonly ComponentGroup[], excepted: readonly ExceptedComponent[]): string {
	const lines: string[] = [
		'<!-- Generated by scripts/docs/licenses.ts (pnpm docs:licenses); edit the sources, not this file. -->',
		'',
		'## Политика лицензий',
		'',
		'Разрешены лицензии ниже; компонент с другой лицензией допускается только явным исключением с причиной. Выражение ' +
			'`A OR B` проходит, если разрешена хотя бы одна альтернатива, `A AND B` — если разрешены обе. Проверка выполняется ' +
			'при каждой сборке документации и останавливает её при нарушении.',
		'',
		'| Лицензия | Почему разрешена |',
		'|----------|------------------------------------------------------------|',
		...Object.entries(ALLOWED_LICENSES).map(([id, reason]) => `| ${id} | ${cell(reason)} |`),
		'',
		'## Исключения',
		'',
		'| Компонент | Лицензия | Причина |',
		'|------------|------------|----------------------------------------------------|',
		...excepted.map(
			({ component, exception }) => `| ${cell(component.name)} | ${cell(exception.license)} | ${cell(exception.reason)} |`
		),
		''
	];
	for (const group of groups) {
		lines.push(
			`## ${group.title}`,
			'',
			group.description,
			'',
			'| Компонент | Версия | Лицензия | Назначение и примечание |',
			'|--------------------|----------------|--------------------|----------------------------------|',
			...group.components.map(
				(component) =>
					`| ${cell(component.name)} | ${cell(component.version)} | ${cell(component.license)} | ${cell(component.note ?? '')} |`
			),
			'',
			`Источник лицензий: ${[...new Set(group.components.map((component) => component.source))].join('; ')}.`,
			''
		);
	}
	return lines.join('\n');
}

/** Collects, checks and writes the table; returns what was written for the caller's report. */
export function generateTechnologies(): { groups: ComponentGroup[]; excepted: ExceptedComponent[] } {
	const groups = collectGroups();
	const excepted = checkLicenses(
		groups.flatMap((group) => group.components),
		LICENSE_EXCEPTIONS
	);
	mkdirSync(dirname(TECHNOLOGIES_FILE), { recursive: true });
	writeFileSync(TECHNOLOGIES_FILE, renderTechnologies(groups, excepted));
	return { groups, excepted };
}

if (import.meta.main) {
	const { groups, excepted } = generateTechnologies();
	for (const group of groups) console.log(`${String(group.components.length).padStart(4)}  ${group.title}`);
	console.log(`${String(groups.reduce((sum, group) => sum + group.components.length, 0)).padStart(4)}  rows in total`);
	console.log(`Exceptions (${excepted.length}):`);
	for (const { component, exception } of excepted) {
		console.log(`  ${component.kind} ${component.name}@${component.version}: ${exception.license}`);
	}
	console.log(`Written ${TECHNOLOGIES_FILE.slice(ROOT.length)}`);
}
