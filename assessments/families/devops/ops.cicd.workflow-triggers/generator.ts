// Which GitHub Actions workflows an event starts: `push` and `pull_request` in `on:` with the filters `branches`,
// `branches-ignore`, `tags`, `paths` and `paths-ignore`; globs where `*` stays inside one path segment and `**` crosses
// `/`; a ref filter of one kind shuts out the other kind of ref; `branches` of a pull request is the target branch;
// a ref filter and a path filter must both pass; `!` excludes and the last matching pattern decides.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PY_PIPELINE_YAML } from '../../_lib/yaml.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type RefKind = 'none' | 'branches' | 'branches-ignore' | 'tags';
type PathKind = 'none' | 'paths' | 'paths-ignore';

interface Section {
	ref: RefKind;
	refPatterns: string[];
	path: PathKind;
	pathPatterns: string[];
}

interface Workflow {
	file: string;
	push: Section | null;
	pr: Section | null;
}

type Event =
	{ kind: 'branch'; branch: string } | { kind: 'tag'; tag: string } | { kind: 'pr'; source: string; target: string };

interface Params {
	event: Event;
	changed: string[];
	workflows: Workflow[];
}

interface Rules {
	starCrossesSlash: boolean;
	prSourceBranch: boolean;
	missingFilterAllows: boolean;
	tagMatchesBranches: boolean;
	pathsIgnoreAny: boolean;
	pathsAll: boolean;
	pathsOrBranches: boolean;
	firstMatch: boolean;
	negatedFileBlocks: boolean;
}

const RIGHT: Rules = {
	starCrossesSlash: false,
	prSourceBranch: false,
	missingFilterAllows: false,
	tagMatchesBranches: false,
	pathsIgnoreAny: false,
	pathsAll: false,
	pathsOrBranches: false,
	firstMatch: false,
	negatedFileBlocks: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'star-crosses-slash': { starCrossesSlash: true },
	'pr-source-branch': { prSourceBranch: true },
	'missing-filter-allows': { missingFilterAllows: true },
	'tag-matches-branches': { tagMatchesBranches: true },
	'paths-ignore-any': { pathsIgnoreAny: true },
	'paths-all': { pathsAll: true },
	'paths-or-branches': { pathsOrBranches: true },
	'first-match': { firstMatch: true },
	'negated-file-blocks': { negatedFileBlocks: true }
};

function globMatches(glob: string, name: string, rules: Rules): boolean {
	let re = '';
	for (let i = 0; i < glob.length; i += 1) {
		const ch = glob[i] as string;
		if (glob.startsWith('**/', i)) {
			re += '(?:.*/)?';
			i += 2;
		} else if (glob.startsWith('**', i)) {
			re += '.*';
			i += 1;
		} else if (ch === '*') re += rules.starCrossesSlash ? '.*' : '[^/]*';
		else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${re}$`).test(name);
}

/** Whether a name passes a pattern list where `!` excludes: the last (or, wrongly, the first) matching pattern decides. */
function listPasses(patterns: string[], name: string, rules: Rules): boolean {
	const ordered = rules.firstMatch ? [...patterns].reverse() : patterns;
	let passes = false;
	for (const p of ordered) {
		const negated = p.startsWith('!');
		if (globMatches(negated ? p.slice(1) : p, name, rules)) passes = !negated;
	}
	return passes;
}

function refPasses(s: Section, event: Event, rules: Rules): boolean {
	if (s.ref === 'none') return true;
	if (event.kind === 'pr') {
		const name = rules.prSourceBranch ? event.source : event.target;
		const hit = listPasses(s.refPatterns, name, rules);
		return s.ref === 'branches' ? hit : !hit;
	}
	const isTag = event.kind === 'tag';
	const name = event.kind === 'tag' ? event.tag : event.branch;
	const ownKind = isTag ? s.ref === 'tags' : s.ref !== 'tags';
	if (!ownKind && !rules.tagMatchesBranches) return rules.missingFilterAllows;
	const hit = listPasses(s.refPatterns, name, rules);
	return s.ref === 'branches-ignore' ? !hit : hit;
}

function pathsPass(s: Section, changed: string[], rules: Rules): boolean {
	if (s.path === 'none') return true;
	if (s.path === 'paths-ignore') {
		const ignored = (f: string): boolean => s.pathPatterns.some((p) => globMatches(p, f, rules));
		return rules.pathsIgnoreAny ? !changed.some(ignored) : changed.some((f) => !ignored(f));
	}
	if (rules.negatedFileBlocks) {
		const negated = s.pathPatterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
		const positive = s.pathPatterns.filter((p) => !p.startsWith('!'));
		if (changed.some((f) => negated.some((p) => globMatches(p, f, rules)))) return false;
		return changed.some((f) => positive.some((p) => globMatches(p, f, rules)));
	}
	const included = (f: string): boolean => listPasses(s.pathPatterns, f, rules);
	return rules.pathsAll ? changed.every(included) : changed.some(included);
}

function sectionRuns(s: Section, p: Params, rules: Rules): boolean {
	const ref = refPasses(s, p.event, rules);
	const paths = pathsPass(s, p.changed, rules);
	if (rules.pathsOrBranches && s.ref !== 'none' && s.path !== 'none') return ref || paths;
	return ref && paths;
}

function simulate(p: Params, rules: Rules): string[] {
	const started = p.workflows
		.filter((w) => {
			const s = p.event.kind === 'pr' ? w.pr : w.push;
			return s !== null && sectionRuns(s, p, rules);
		})
		.map((w) => w.file)
		.sort();
	return started.length ? started : ['-'];
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const FILES_NAMES = [
	'ci.yml',
	'lint.yml',
	'deploy.yml',
	'docs.yml',
	'release.yml',
	'e2e.yml',
	'security.yml',
	'terraform.yml',
	'frontend.yml',
	'backend.yml',
	'publish.yml',
	'preview.yml',
	'docker.yml',
	'helm.yml',
	'changelog.yml',
	'api-tests.yml'
];

const BRANCHES = [
	'main',
	'develop',
	'release/1.4',
	'release/2.0/hotfix',
	'release/3.0-rc',
	'feature/cart',
	'feature/auth/sso',
	'feature/wip/search',
	'fix/login-timeout',
	'fix/api/retry',
	'hotfix/2.0.1',
	'dependabot/npm/axios',
	'docs/readme'
];
const BRANCH_POS = [
	'main',
	'develop',
	'release/*',
	'release/**',
	'feature/*',
	'feature/**',
	'fix/*',
	'fix/**',
	'hotfix/*',
	'dependabot/**',
	'docs/*',
	'*',
	'**'
];
const BRANCH_NEG = [
	'!feature/wip/*',
	'!feature/wip/**',
	'!release/*-rc',
	'!release/**/hotfix',
	'!dependabot/**',
	'!feature/*',
	'!release/*',
	'!fix/*',
	'!docs/*',
	'!main'
];
const TAGS = ['v1.4.0', 'v2.0.0-rc.1', 'v10.2.3', 'release-3.1', 'deploy/prod', 'deploy/eu/staging', 'nightly'];
const TAG_PATTERNS = ['v*', 'v*.*.*', 'v1.*', 'v2.*', 'release-*', 'deploy/*', 'deploy/**', '*', '**'];

const FILES = [
	'src/app.ts',
	'src/api/users.ts',
	'src/api/v2/orders.ts',
	'src/api/users.test.ts',
	'docs/index.md',
	'docs/api/auth.md',
	'README.md',
	'CHANGELOG.md',
	'package.json',
	'web/package.json',
	'web/src/App.vue',
	'infra/main.tf',
	'infra/modules/vpc/main.tf',
	'charts/api/values.yaml',
	'tests/e2e/login.spec.ts',
	'.github/workflows/ci.yml'
];
const PATH_POS = [
	'src/**',
	'src/*',
	'src/api/*',
	'docs/**',
	'docs/*',
	'**.md',
	'*.md',
	'**/*.md',
	'infra/**',
	'infra/*.tf',
	'**/*.tf',
	'web/**',
	'charts/**',
	'package.json',
	'**/package.json',
	'tests/**',
	'.github/**'
];
const PATH_NEG = [
	'!**.md',
	'!*.md',
	'!docs/**',
	'!**/*.test.ts',
	'!src/api/v2/**',
	'!src/api/*',
	'!infra/modules/**',
	'!web/**',
	'!**/package.json'
];

interface ClassSpec {
	event: Event['kind'][];
	workflows: [number, number];
	changed: [number, number];
	/** Probability that a workflow has a section for the event of the instance and for the other one. */
	ownSection: number;
	otherSection: number;
	refKinds: RefKind[];
	pathKinds: PathKind[];
	/** Junior: a section may have a ref filter and a path filter at once, lists may have `!`. */
	combined: boolean;
	negation: number;
}

const SPECS: Record<string, ClassSpec> = {
	'intern/branch-glob': {
		event: ['branch'],
		workflows: [4, 5],
		changed: [1, 3],
		ownSection: 0.9,
		otherSection: 0.4,
		refKinds: ['branches', 'branches', 'branches', 'branches-ignore', 'tags', 'none'],
		pathKinds: ['none'],
		combined: false,
		negation: 0
	},
	'intern/pr-target': {
		event: ['pr'],
		workflows: [4, 5],
		changed: [1, 3],
		ownSection: 0.85,
		otherSection: 0.5,
		refKinds: ['branches', 'branches', 'branches', 'branches-ignore', 'none'],
		pathKinds: ['none'],
		combined: false,
		negation: 0
	},
	'intern/paths-ignore': {
		event: ['branch'],
		workflows: [4, 5],
		changed: [2, 4],
		ownSection: 0.9,
		otherSection: 0.4,
		refKinds: ['branches', 'none'],
		pathKinds: ['paths', 'paths', 'paths-ignore', 'paths-ignore', 'paths-ignore'],
		combined: false,
		negation: 0
	},
	'intern/tag-push': {
		event: ['tag'],
		workflows: [4, 5],
		changed: [0, 0],
		ownSection: 0.9,
		otherSection: 0.4,
		refKinds: ['branches', 'branches', 'branches-ignore', 'tags', 'tags', 'none'],
		pathKinds: ['none'],
		combined: false,
		negation: 0
	},
	'junior/negation-order': {
		event: ['branch'],
		workflows: [5, 6],
		changed: [2, 4],
		ownSection: 0.9,
		otherSection: 0.4,
		refKinds: ['branches', 'branches', 'branches', 'branches-ignore', 'none'],
		pathKinds: ['none', 'none', 'paths', 'paths-ignore'],
		combined: true,
		negation: 0.8
	},
	'junior/branches-and-paths': {
		event: ['branch', 'branch', 'pr'],
		workflows: [5, 6],
		changed: [2, 4],
		ownSection: 0.9,
		otherSection: 0.5,
		refKinds: ['branches', 'branches', 'branches-ignore', 'none'],
		pathKinds: ['paths', 'paths', 'paths-ignore', 'none'],
		combined: true,
		negation: 0.3
	},
	'junior/paths-negation': {
		event: ['branch'],
		workflows: [5, 6],
		changed: [2, 4],
		ownSection: 0.9,
		otherSection: 0.4,
		refKinds: ['branches', 'branches-ignore', 'none', 'none'],
		pathKinds: ['paths', 'paths', 'paths', 'paths-ignore'],
		combined: true,
		negation: 0.8
	},
	'junior/pr-combined': {
		event: ['pr'],
		workflows: [5, 6],
		changed: [2, 4],
		ownSection: 0.9,
		otherSection: 0.5,
		refKinds: ['branches', 'branches', 'branches-ignore', 'none'],
		pathKinds: ['paths', 'paths-ignore', 'none'],
		combined: true,
		negation: 0.4
	}
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/branch-glob': ['star-crosses-slash'],
	'intern/pr-target': ['pr-source-branch'],
	'intern/paths-ignore': ['paths-ignore-any'],
	'intern/tag-push': ['missing-filter-allows'],
	'junior/negation-order': ['first-match'],
	'junior/branches-and-paths': ['paths-or-branches'],
	'junior/paths-negation': ['negated-file-blocks'],
	'junior/pr-combined': ['pr-source-branch']
};

function patternList(rng: Rng, positive: string[], negative: string[], negation: number): string[] {
	const list = [rng.pick(positive)];
	if (rng.bool(negation)) {
		list.push(rng.pick(negative));
		if (rng.bool(0.4)) list.push(rng.pick(positive.filter((p) => p !== list[0])));
	} else if (rng.bool(0.4)) list.push(rng.pick(positive.filter((p) => p !== list[0])));
	return list;
}

function plainList(rng: Rng, pool: string[]): string[] {
	return rng.sample(pool, rng.int(1, 2));
}

function section(rng: Rng, spec: ClassSpec, push: boolean): Section {
	const refKinds = push ? spec.refKinds : spec.refKinds.filter((k) => k !== 'tags');
	let ref: RefKind = rng.pick(refKinds.length ? refKinds : ['none']);
	let path: PathKind = rng.pick(spec.pathKinds);
	// Intern: one filter of one kind per event.
	if (!spec.combined && ref !== 'none' && path !== 'none') {
		if (rng.bool(0.5)) ref = 'none';
		else path = 'none';
	}
	const refPatterns =
		ref === 'none'
			? []
			: ref === 'tags'
				? plainList(rng, TAG_PATTERNS)
				: ref === 'branches'
					? patternList(rng, BRANCH_POS, BRANCH_NEG, spec.negation)
					: plainList(
							rng,
							BRANCH_POS.filter((b) => b !== '*' && b !== '**')
						);
	const pathPatterns =
		path === 'none'
			? []
			: path === 'paths'
				? patternList(rng, PATH_POS, PATH_NEG, spec.negation)
				: plainList(rng, PATH_POS);
	return { ref, refPatterns, path, pathPatterns };
}

function scenario(rng: Rng, spec: ClassSpec): Params {
	const kind = rng.pick(spec.event);
	const event: Event =
		kind === 'branch'
			? { kind, branch: rng.pick(BRANCHES) }
			: kind === 'tag'
				? { kind, tag: rng.pick(TAGS) }
				: {
						kind,
						source: rng.pick(BRANCHES.filter((b) => b !== 'main' && b !== 'develop')),
						target: rng.pick(['main', 'main', 'develop', 'release/1.4', 'release/2.0/hotfix'])
					};
	const changed = kind === 'tag' ? [] : rng.sample(FILES, rng.int(spec.changed[0], spec.changed[1]));
	const files = rng.sample(FILES_NAMES, rng.int(spec.workflows[0], spec.workflows[1]));
	const workflows = files.map((file): Workflow => {
		const own = rng.bool(spec.ownSection);
		const other = !own || rng.bool(spec.otherSection);
		const prOn = kind === 'pr' ? own : other;
		const pushOn = kind === 'pr' ? other : own;
		return {
			file,
			push: pushOn ? section(rng, spec, true) : null,
			pr: prOn ? section(rng, spec, false) : null
		};
	});
	return { event, changed, workflows };
}

// ---------------------------------------------------------------------------------------------------------------
// Text.

const isBare = (s: Section | null): boolean => s !== null && s.ref === 'none' && s.path === 'none';

function sectionLines(name: string, s: Section): string[] {
	const lines = [`  ${name}:`];
	const list = (key: string, patterns: string[]): void => {
		lines.push(`    ${key}:`, ...patterns.map((p) => `      - '${p}'`));
	};
	if (s.ref !== 'none') list(s.ref, s.refPatterns);
	if (s.path !== 'none') list(s.path, s.pathPatterns);
	return lines;
}

function workflowYaml(w: Workflow): string {
	const job = w.file.replace(/\.yml$/, '');
	const lines = [`# .github/workflows/${w.file}`];
	if (isBare(w.push) && w.pr === null) lines.push('on: push');
	else if (isBare(w.pr) && w.push === null) lines.push('on: pull_request');
	else if (isBare(w.push) && isBare(w.pr)) lines.push('on: [push, pull_request]');
	else {
		lines.push('on:');
		if (w.push) lines.push(...sectionLines('push', w.push));
		if (w.pr) lines.push(...sectionLines('pull_request', w.pr));
	}
	lines.push('jobs:', `  ${job}:`, '    runs-on: ubuntu-latest', '    steps:', `      - run: make ${job}`);
	return lines.join('\n');
}

function eventText(p: Params): string {
	const files = p.changed.map((f) => `\`${f}\``).join(', ');
	if (p.event.kind === 'branch') return `push в ветку \`${p.event.branch}\`; коммит изменил файлы ${files}`;
	if (p.event.kind === 'tag') return `push тега \`${p.event.tag}\``;
	return `открыт pull request из ветки \`${p.event.source}\` в ветку \`${p.event.target}\`; в нём изменены файлы ${files}`;
}

function describe(p: Params, junior: boolean): string {
	return [
		`В репозитории несколько файлов workflow GitHub Actions — они ниже, каждый начинается с комментария со своим путём. Событие: ${eventText(p)}.`,
		'',
		'Правила запуска:',
		'',
		'- workflow запускается событием, только если оно есть в `on`: `push` — push ветки или тега, `pull_request` — открытие pull request; события без фильтров (`on: push`, `on: [push, pull_request]`, пустое `pull_request:`) подходят всегда;',
		'- фильтры `push`: `branches` — имя ветки подходит под шаблон, `branches-ignore` — не подходит ни под один, `tags` — имя тега подходит под шаблон; если у события заданы только фильтры веток, push тега workflow не запускает, если только `tags` — не запускает push ветки; без фильтров веток и тегов подходит любая ветка и любой тег;',
		'- у `pull_request` фильтры `branches` и `branches-ignore` проверяют **целевую** ветку pull request (в которую сливают);',
		'- `paths` — хотя бы один изменённый файл подходит под шаблон; `paths-ignore` — хотя бы один изменённый файл не подходит ни под один шаблон (все изменённые файлы под `paths-ignore` — не запускается);',
		...(junior
			? [
					'- если у события заданы и фильтр веток, и фильтр путей, должны выполниться оба;',
					'- шаблон с `!` в `branches` и `paths` исключает: шаблоны списка проверяются по порядку, и решает **последний** совпавший — имя подходит, если этот шаблон без `!`, и не подходит, если с `!` или не совпал ни один; для `paths` так проверяется каждый изменённый файл, и достаточно одного подходящего;'
				]
			: []),
		'- шаблон сравнивается с именем целиком: `*` — любые символы, кроме `/` (в том числе ни одного); `**/` — любое число каталогов, в том числе ни одного; `**` в остальных местах — любые символы, включая `/`; прочие символы — буквально.',
		'',
		'Введите имена файлов workflow, которые запустятся, по одному в строке, в любом порядке; если не запустится ни один — одна строка `-`. Например:',
		'',
		'```',
		'build.yml',
		'checks.yml',
		'```'
	].join('\n');
}

const PYTHON_REFERENCE = String.raw`${PY_PIPELINE_YAML}
data = json.loads(input())
event = data["event"]
changed = data["changed"]

files = []
for line in data["text"].split("\n"):
    if line.startswith("# .github/workflows/"):
        files.append([line[len("# .github/workflows/"):], []])
    else:
        files[-1][1].append(line)


def pattern_re(glob):
    out, i = "", 0
    while i < len(glob):
        if glob[i:i + 3] == "**/":
            out, i = out + "(?:.*/)?", i + 3
        elif glob[i:i + 2] == "**":
            out, i = out + ".*", i + 2
        elif glob[i] == "*":
            out, i = out + "[^/]*", i + 1
        else:
            out, i = out + re.escape(glob[i]), i + 1
    return out


def fits(glob, name):
    return re.fullmatch(pattern_re(glob), name) is not None


def passes(patterns, name):
    verdict = False
    for p in patterns:
        if p.startswith("!"):
            if fits(p[1:], name):
                verdict = False
        elif fits(p, name):
            verdict = True
    return verdict


def triggered(filters):
    if filters is None:
        return True
    if event["kind"] == "pr":
        ref_ok = True
        if "branches" in filters:
            ref_ok = passes(filters["branches"], event["target"])
        if "branches-ignore" in filters:
            ref_ok = not passes(filters["branches-ignore"], event["target"])
    else:
        branch_filter = "branches" in filters or "branches-ignore" in filters
        tag_filter = "tags" in filters
        if event["kind"] == "tag":
            ref_ok = passes(filters["tags"], event["tag"]) if tag_filter else not branch_filter
        else:
            name = event["branch"]
            if "branches" in filters:
                ref_ok = passes(filters["branches"], name)
            elif "branches-ignore" in filters:
                ref_ok = not passes(filters["branches-ignore"], name)
            else:
                ref_ok = not tag_filter
    path_ok = True
    if "paths" in filters:
        path_ok = any(passes(filters["paths"], f) for f in changed)
    if "paths-ignore" in filters:
        path_ok = any(not any(fits(p, f) for p in filters["paths-ignore"]) for f in changed)
    return ref_ok and path_ok


wanted = "pull_request" if event["kind"] == "pr" else "push"
started = []
for name, lines in files:
    on = parse_yaml("\n".join(lines))["on"]
    if isinstance(on, str):
        on = {on: None}
    elif isinstance(on, list):
        on = {e: None for e in on}
    if wanted in on and triggered(on[wanted]):
        started.append(name)
for name in started or ["-"]:
    print(name)
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const key = `${input.grade}/${input.classId}`;
	const spec = SPECS[key];
	if (!spec) throw new Error(`${descriptor.key}: no class ${key}`);
	// Scenarios are drawn until every misconception that the class must expose changes the answer.
	for (let tries = 0; tries < 600; tries += 1) {
		const p = scenario(rng, spec);
		const answer = simulate(p, RIGHT);
		if (answer.length === 1 && answer[0] === '-' && rng.bool(0.8)) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value.join('\n') === answer.join('\n') ? null : value];
			})
		);
		if ((REQUIRED[key] ?? []).some((id) => wrong[id] === null)) continue;
		const text = p.workflows.map(workflowYaml).join('\n\n');
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, input.grade === 'junior'), code: { language: 'yaml', source: text } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ text, event: p.event, changed: p.changed })
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
	throw new Error(`${descriptor.key}: no scenario for ${key} after 600 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
