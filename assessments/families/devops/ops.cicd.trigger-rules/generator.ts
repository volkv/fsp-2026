// Which jobs a GitLab CI pipeline gets for an event: `rules` decide by the first matching rule, predefined variables
// differ between a branch push, a merge request and a tag, `changes` match globs, `workflow: rules` decide whether
// there is a pipeline at all and may set variables, and `needs` to a job that is not created breaks the pipeline.
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

type When = 'never' | 'manual' | 'on_success' | 'always';

interface Rule {
	if: string | null;
	changes: string[] | null;
	when: When | null;
	variables: Record<string, string> | null;
}

interface Need {
	job: string;
	optional: boolean;
}

interface Job {
	id: string;
	stage: string;
	script: string;
	rules: Rule[] | null;
	needs: Need[] | null;
}

type Event =
	{ kind: 'push'; branch: string } | { kind: 'mr'; source: string; target: string } | { kind: 'tag'; tag: string };

interface Params {
	event: Event;
	changed: string[];
	workflow: Rule[] | null;
	jobs: Job[];
}

interface Rules {
	lastMatch: boolean;
	noMatchCreates: boolean;
	branchInMr: boolean;
	tagHasBranch: boolean;
	manualOmitted: boolean;
	changesOnTagFalse: boolean;
	starCrossesSlash: boolean;
	needsIgnored: boolean;
	optionalErrors: boolean;
	workflowIgnored: boolean;
}

const RIGHT: Rules = {
	lastMatch: false,
	noMatchCreates: false,
	branchInMr: false,
	tagHasBranch: false,
	manualOmitted: false,
	changesOnTagFalse: false,
	starCrossesSlash: false,
	needsIgnored: false,
	optionalErrors: false,
	workflowIgnored: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'last-match': { lastMatch: true },
	'no-match-creates': { noMatchCreates: true },
	'branch-in-mr': { branchInMr: true },
	'tag-has-branch': { tagHasBranch: true },
	'manual-omitted': { manualOmitted: true },
	'changes-on-tag-false': { changesOnTagFalse: true },
	'star-crosses-slash': { starCrossesSlash: true },
	'needs-ignored': { needsIgnored: true },
	'optional-errors': { optionalErrors: true },
	'workflow-ignored': { workflowIgnored: true }
};

function variables(event: Event, rules: Rules): Map<string, string> {
	const v = new Map<string, string>([['CI_DEFAULT_BRANCH', 'main']]);
	if (event.kind === 'push') {
		v.set('CI_PIPELINE_SOURCE', 'push');
		v.set('CI_COMMIT_BRANCH', event.branch);
	} else if (event.kind === 'mr') {
		v.set('CI_PIPELINE_SOURCE', 'merge_request_event');
		v.set('CI_MERGE_REQUEST_SOURCE_BRANCH_NAME', event.source);
		v.set('CI_MERGE_REQUEST_TARGET_BRANCH_NAME', event.target);
		if (rules.branchInMr) v.set('CI_COMMIT_BRANCH', event.source);
	} else {
		v.set('CI_PIPELINE_SOURCE', 'push');
		v.set('CI_COMMIT_TAG', event.tag);
		if (rules.tagHasBranch) v.set('CI_COMMIT_BRANCH', 'main');
	}
	return v;
}

/** `$A`, `$A == "x"`, `$A != "x"`, `$A == $B`, `$A =~ /re/`, joined by `&&` and `||` (`&&` binds tighter). */
function evalIf(expr: string, vars: Map<string, string>): boolean {
	const value = (operand: string): string | undefined =>
		operand.startsWith('$') ? vars.get(operand.slice(1)) : operand.replace(/^"(.*)"$/, '$1');
	const atom = (text: string): boolean => {
		const m = /^(\S+)\s*(==|!=|=~)\s*(.+)$/.exec(text.trim());
		if (!m) {
			const v = value(text.trim());
			return v !== undefined && v !== '';
		}
		const left = value(m[1] ?? '');
		const right = m[3] ?? '';
		if (m[2] === '=~') return left !== undefined && new RegExp(right.slice(1, -1)).test(left);
		const equal = left === value(right.trim());
		return m[2] === '==' ? equal : !equal;
	};
	return expr.split('||').some((part) => part.split('&&').every(atom));
}

function globMatches(glob: string, path: string, rules: Rules): boolean {
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
	return new RegExp(`^${re}$`).test(path);
}

function decide(p: Params, list: Rule[], vars: Map<string, string>, rules: Rules): Rule | null {
	const matches = list.filter((r) => {
		if (r.if !== null && !evalIf(r.if, vars)) return false;
		if (r.changes !== null) {
			if (p.event.kind === 'tag' && !rules.changesOnTagFalse) return true;
			return p.changed.some((f) => r.changes?.some((g) => globMatches(g, f, rules)));
		}
		return true;
	});
	const hit = rules.lastMatch ? matches[matches.length - 1] : matches[0];
	if (!hit) return rules.noMatchCreates ? { if: null, changes: null, when: null, variables: null } : null;
	return hit.when === 'never' ? null : hit;
}

function simulate(p: Params, rules: Rules): string[] {
	const vars = variables(p.event, rules);
	if (p.workflow !== null && !rules.workflowIgnored) {
		const rule = decide(p, p.workflow, vars, { ...rules, noMatchCreates: false });
		if (rule === null) return ['-'];
		for (const [k, v] of Object.entries(rule.variables ?? {})) vars.set(k, v);
	}
	const created = new Map<string, When>();
	for (const job of p.jobs) {
		if (job.rules === null) {
			created.set(job.id, 'on_success');
			continue;
		}
		const rule = decide(p, job.rules, vars, rules);
		if (rule === null) continue;
		const when = rule.when ?? 'on_success';
		if (when === 'manual' && rules.manualOmitted) continue;
		created.set(job.id, when);
	}
	if (!rules.needsIgnored) {
		const broken = [...created.keys()].flatMap((id) =>
			(p.jobs.find((j) => j.id === id)?.needs ?? [])
				.filter((n) => !created.has(n.job) && (!n.optional || rules.optionalErrors))
				.map((n) => `error ${id} ${n.job}`)
		);
		if (broken.length) return broken.sort();
	}
	if (created.size === 0) return ['-'];
	return [...created.entries()].map(([id, when]) => (when === 'manual' ? `${id} manual` : id)).sort();
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const STAGES = ['build', 'test', 'deploy', 'release'];
const JOBS: { id: string; stage: string; script: string }[] = [
	{ id: 'compile', stage: 'build', script: 'npm run build' },
	{ id: 'docker-image', stage: 'build', script: 'docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA" .' },
	{ id: 'docs-site', stage: 'build', script: 'npm run docs' },
	{ id: 'lint', stage: 'test', script: 'npm run lint' },
	{ id: 'unit-tests', stage: 'test', script: 'npm run test:unit' },
	{ id: 'e2e', stage: 'test', script: 'npx playwright test' },
	{ id: 'sast', stage: 'test', script: 'semgrep scan --error' },
	{ id: 'tf-plan', stage: 'test', script: 'terraform -chdir=infra plan' },
	{ id: 'review-app', stage: 'deploy', script: './deploy.sh review' },
	{ id: 'staging', stage: 'deploy', script: './deploy.sh staging' },
	{ id: 'production', stage: 'deploy', script: './deploy.sh production' },
	{ id: 'pages', stage: 'deploy', script: 'cp -r site public' },
	{ id: 'publish', stage: 'release', script: 'npm publish' },
	{ id: 'release-notes', stage: 'release', script: './scripts/release-notes.sh' }
];

const IFS = {
	mr: '$CI_PIPELINE_SOURCE == "merge_request_event"',
	mrMain: '$CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"',
	defaultBranch: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH',
	main: '$CI_COMMIT_BRANCH == "main"',
	anyBranch: '$CI_COMMIT_BRANCH',
	notMain: '$CI_COMMIT_BRANCH != "main"',
	release: '$CI_COMMIT_BRANCH =~ /^release\\//',
	feature: '$CI_COMMIT_BRANCH =~ /^feature\\//',
	tag: '$CI_COMMIT_TAG',
	semver: '$CI_COMMIT_TAG =~ /^v\\d+\\.\\d+\\.\\d+$/',
	push: '$CI_PIPELINE_SOURCE == "push"',
	branchNotMain: '$CI_COMMIT_BRANCH && $CI_COMMIT_BRANCH != "main"',
	mrOrMain: '$CI_PIPELINE_SOURCE == "merge_request_event" || $CI_COMMIT_BRANCH == "main"'
};
type IfKey = keyof typeof IFS;
const IF_KEYS = Object.keys(IFS) as IfKey[];

const FILES = [
	'src/app.ts',
	'src/api/users.ts',
	'src/api/orders/list.ts',
	'docs/guide.md',
	'README.md',
	'CHANGELOG.md',
	'package.json',
	'package-lock.json',
	'charts/app/values.yaml',
	'infra/main.tf',
	'infra/modules/vpc/main.tf',
	'tests/e2e/login.spec.ts'
];
const GLOBS = [
	'src/**/*',
	'src/*',
	'src/api/*',
	'docs/**/*',
	'*.md',
	'**/*.md',
	'package*.json',
	'charts/**/*',
	'infra/*.tf',
	'infra/**/*.tf',
	'tests/**/*'
];
const BRANCHES = ['main', 'develop', 'feature/cart', 'feature/sso-login', 'release/3.1', 'fix/timeouts'];
const TAGS = ['v2.4.0', 'v3.0.1', 'v2.5.0-rc.1', 'nightly-1005', 'v1.12.3'];

interface ClassSpec {
	events: Event['kind'][];
	jobs: [number, number];
	changes: number;
	manual: number;
	never: number;
	needs: number;
	optional: number;
	workflow: boolean;
	ifs: IfKey[];
}

const JUNIOR_IFS: IfKey[] = [
	'mr',
	'mrMain',
	'defaultBranch',
	'main',
	'anyBranch',
	'notMain',
	'release',
	'feature',
	'tag',
	'push'
];
const MIDDLE_IFS: IfKey[] = [...IF_KEYS];

const SPECS: Record<string, ClassSpec> = {
	'junior/rule-order': {
		events: ['push', 'mr', 'tag'],
		jobs: [5, 6],
		changes: 0,
		manual: 0.3,
		never: 0.5,
		needs: 0,
		optional: 0,
		workflow: false,
		ifs: JUNIOR_IFS
	},
	'junior/mr-vs-branch': {
		events: ['mr'],
		jobs: [5, 6],
		changes: 0,
		manual: 0.2,
		never: 0.2,
		needs: 0,
		optional: 0,
		workflow: false,
		ifs: JUNIOR_IFS
	},
	'junior/changes': {
		events: ['push'],
		jobs: [5, 6],
		changes: 0.6,
		manual: 0.2,
		never: 0.2,
		needs: 0,
		optional: 0,
		workflow: false,
		ifs: JUNIOR_IFS
	},
	'junior/tag': {
		events: ['tag'],
		jobs: [5, 6],
		changes: 0,
		manual: 0.2,
		never: 0.2,
		needs: 0,
		optional: 0,
		workflow: false,
		ifs: JUNIOR_IFS
	},
	'middle/workflow-vars': {
		events: ['push', 'mr', 'tag'],
		jobs: [6, 7],
		changes: 0.2,
		manual: 0.2,
		never: 0.3,
		needs: 0.3,
		optional: 0.5,
		workflow: true,
		ifs: MIDDLE_IFS
	},
	'middle/needs-missing': {
		events: ['push', 'mr', 'tag'],
		jobs: [6, 7],
		changes: 0.3,
		manual: 0.2,
		never: 0.3,
		needs: 0.6,
		optional: 0,
		workflow: false,
		ifs: MIDDLE_IFS
	},
	'middle/optional-needs': {
		events: ['push', 'mr', 'tag'],
		jobs: [6, 7],
		changes: 0.3,
		manual: 0.2,
		never: 0.3,
		needs: 0.6,
		optional: 0.7,
		workflow: false,
		ifs: MIDDLE_IFS
	},
	'middle/tag-changes': {
		events: ['tag'],
		jobs: [6, 7],
		changes: 0.6,
		manual: 0.4,
		never: 0.3,
		needs: 0.3,
		optional: 0.5,
		workflow: false,
		ifs: MIDDLE_IFS
	}
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/rule-order': ['last-match'],
	'junior/mr-vs-branch': ['branch-in-mr'],
	'junior/changes': ['star-crosses-slash'],
	'junior/tag': ['tag-has-branch'],
	'middle/workflow-vars': ['workflow-ignored'],
	'middle/needs-missing': ['needs-ignored'],
	'middle/optional-needs': ['optional-errors'],
	'middle/tag-changes': ['changes-on-tag-false', 'manual-omitted']
};

/** Classes whose pipeline is created: the class shows the path by which it is, not a failure to create it. */
const CREATED = new Set(['middle/optional-needs']);

const ENVS = ['production', 'staging', 'review'];

function randomRule(rng: Rng, spec: ClassSpec, workflowVar: boolean): Rule {
	const useIf = rng.bool(0.85);
	let ifText: string | null = useIf ? IFS[rng.pick(spec.ifs)] : null;
	if (workflowVar && rng.bool(0.6)) ifText = `$DEPLOY_ENV == "${rng.pick(ENVS)}"`;
	const changes = rng.bool(spec.changes) ? rng.sample(GLOBS, rng.int(1, 2)) : null;
	const r = rng.next();
	const when: When | null = r < spec.never * 0.5 ? 'never' : r < spec.never * 0.5 + spec.manual * 0.5 ? 'manual' : null;
	return { if: ifText ?? (changes ? null : IFS[rng.pick(spec.ifs)]), changes, when, variables: null };
}

function scenario(rng: Rng, spec: ClassSpec): Params {
	const kind = rng.pick(spec.events);
	const event: Event =
		kind === 'push'
			? { kind, branch: rng.pick(BRANCHES) }
			: kind === 'mr'
				? {
						kind,
						source: rng.pick(BRANCHES.filter((b) => b !== 'main')),
						target: rng.pick(['main', 'main', 'develop'])
					}
				: { kind, tag: rng.pick(TAGS) };
	const changed = rng.sample(FILES, rng.int(1, 3));
	const workflow: Rule[] | null = spec.workflow
		? rng
				.shuffle([
					{ if: IFS.tag, changes: null, when: null, variables: { DEPLOY_ENV: 'production' } },
					{ if: IFS.defaultBranch, changes: null, when: null, variables: { DEPLOY_ENV: 'staging' } },
					{ if: IFS.mr, changes: null, when: null, variables: { DEPLOY_ENV: 'review' } },
					...(rng.bool(0.5) ? [{ if: IFS.release, changes: null, when: null, variables: null }] : [])
				])
				.slice(0, rng.int(2, 4))
		: null;
	if (workflow && rng.bool(0.3)) workflow.push({ if: null, changes: null, when: 'always', variables: null });
	const picked = rng
		.sample(JOBS, rng.int(spec.jobs[0], spec.jobs[1]))
		.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || JOBS.indexOf(a) - JOBS.indexOf(b));
	const jobs: Job[] = picked.map((j, i) => {
		const rules = rng.bool(0.15)
			? null
			: Array.from({ length: rng.int(1, 3) }, () => randomRule(rng, spec, spec.workflow));
		if (rules && rng.bool(0.3))
			rules.push({
				if: null,
				changes: null,
				when: rng.pick(['manual', 'never', 'on_success'] as const),
				variables: null
			});
		const earlier = picked.slice(0, i).filter((e) => STAGES.indexOf(e.stage) < STAGES.indexOf(j.stage));
		const needs =
			earlier.length > 0 && rng.bool(spec.needs)
				? rng
						.sample(earlier, Math.min(earlier.length, rng.int(1, 2)))
						.map((e) => ({ job: e.id, optional: rng.bool(spec.optional) }))
				: null;
		return { ...j, rules, needs };
	});
	return { event, changed, workflow, jobs };
}

// ---------------------------------------------------------------------------------------------------------------
// Text.

function ruleLines(rule: Rule, indent: string): string[] {
	const lines: string[] = [];
	const items: string[] = [];
	if (rule.if !== null) items.push(`if: ${rule.if}`);
	if (rule.changes !== null) items.push(`changes: [${rule.changes.map((g) => `"${g}"`).join(', ')}]`);
	if (rule.when !== null) items.push(`when: ${rule.when}`);
	if (rule.variables !== null) items.push('variables:');
	items.forEach((item, i) => lines.push(`${indent}${i === 0 ? '- ' : '  '}${item}`));
	for (const [k, v] of Object.entries(rule.variables ?? {})) lines.push(`${indent}    ${k}: ${v}`);
	return lines;
}

function pipelineYaml(p: Params): string {
	const lines = [`stages: [${STAGES.join(', ')}]`, ''];
	if (p.workflow !== null) {
		lines.push('workflow:', '  rules:');
		for (const r of p.workflow) lines.push(...ruleLines(r, '    '));
		lines.push('');
	}
	for (const job of p.jobs) {
		lines.push(`${job.id}:`, `  stage: ${job.stage}`);
		if (job.needs !== null) {
			if (job.needs.every((n) => !n.optional)) lines.push(`  needs: [${job.needs.map((n) => n.job).join(', ')}]`);
			else {
				lines.push('  needs:');
				for (const n of job.needs) {
					lines.push(`    - job: ${n.job}`);
					if (n.optional) lines.push('      optional: true');
				}
			}
		}
		lines.push(`  script: ['${job.script}']`);
		if (job.rules !== null) {
			lines.push('  rules:');
			for (const r of job.rules) lines.push(...ruleLines(r, '    '));
		}
		lines.push('');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	return lines.join('\n');
}

function eventText(e: Event): string {
	if (e.kind === 'push') return `push в ветку \`${e.branch}\``;
	if (e.kind === 'mr') return `конвейер merge request из ветки \`${e.source}\` в ветку \`${e.target}\``;
	return `создан тег \`${e.tag}\``;
}

function describe(p: Params, middle: boolean): string {
	return [
		`Файл \`.gitlab-ci.yml\` ниже. Событие: ${eventText(p.event)}; коммит изменил файлы ${p.changed.map((f) => `\`${f}\``).join(', ')}.`,
		'',
		'Предопределённые переменные (переменная, которой нет в строке события, не задана):',
		'',
		'| Переменная | push в ветку | merge request | тег |',
		'| --- | --- | --- | --- |',
		'| `CI_PIPELINE_SOURCE` | `push` | `merge_request_event` | `push` |',
		'| `CI_COMMIT_BRANCH` | имя ветки | не задана | не задана |',
		'| `CI_COMMIT_TAG` | не задана | не задана | имя тега |',
		'| `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` | не задана | исходная ветка | не задана |',
		'| `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` | не задана | целевая ветка | не задана |',
		'| `CI_DEFAULT_BRANCH` | `main` | `main` | `main` |',
		'',
		'Правила GitLab CI:',
		'',
		'- правила `rules` задания проверяются сверху вниз; правило совпадает, если истинны все его условия (`if`, `changes`; правило без условий совпадает всегда); решает **первое** совпавшее правило: `when: never` — задание не создаётся, `when: manual` — создаётся как ручное, иначе — создаётся; если не совпало ни одно правило — задание не создаётся; задание без `rules` создаётся всегда;',
		'- в `if`: `$X` истинно, если переменная задана и не пуста; `$X == "s"` и `$X == $Y` сравнивают строки (незаданная переменная не равна никакой строке, поэтому `$X != "s"` для неё истинно); `$X =~ /re/` — поиск регулярного выражения в заданной переменной; `&&` связывает сильнее `||`;',
		'- `changes` истинно, если хотя бы один изменённый файл подходит хотя бы под один шаблон: `**/` — любое число каталогов, в том числе ни одного, `*` — любые символы, кроме `/`; на конвейере тега `changes` истинно всегда;',
		...(middle
			? [
					'- `workflow: rules` проверяются так же до заданий: не совпало ни одно правило или совпало `when: never` — конвейер не создаётся; `variables` совпавшего правила становятся переменными конвейера;',
					'- если созданное задание перечисляет в `needs` задание, которое не создано, конвейер не создаётся с ошибкой; зависимость с `optional: true` в этом случае просто не учитывается;'
				]
			: []),
		'- конвейер без единого задания не создаётся.',
		'',
		'Введите созданные задания по одному в строке, в любом порядке: имя задания, а для ручного — имя и через пробел слово `manual`. Если конвейер не создаётся — одна строка `-`' +
			(middle
				? '; если он не создаётся из-за `needs` — по строке `error <задание> <зависимость>` для каждой такой зависимости каждого созданного задания.'
				: '.') +
			' Например:',
		'',
		'```',
		'lint',
		'production manual',
		'```'
	].join('\n');
}

const PYTHON_REFERENCE = String.raw`${PY_PIPELINE_YAML}
data = json.loads(input())
doc = parse_yaml(data["yaml"])
event = data["event"]
changed = data["changed"]

env = {"CI_DEFAULT_BRANCH": "main"}
if event["kind"] == "push":
    env.update(CI_PIPELINE_SOURCE="push", CI_COMMIT_BRANCH=event["branch"])
elif event["kind"] == "mr":
    env.update(
        CI_PIPELINE_SOURCE="merge_request_event",
        CI_MERGE_REQUEST_SOURCE_BRANCH_NAME=event["source"],
        CI_MERGE_REQUEST_TARGET_BRANCH_NAME=event["target"],
    )
else:
    env.update(CI_PIPELINE_SOURCE="push", CI_COMMIT_TAG=event["tag"])


def operand(text):
    text = text.strip()
    if text.startswith("$"):
        return env.get(text[1:])
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        return text[1:-1]
    return text


def atom(text):
    text = text.strip()
    for op in ("==", "!=", "=~"):
        if " " + op + " " in text:
            left, right = text.split(" " + op + " ", 1)
            lv = operand(left)
            if op == "=~":
                return lv is not None and re.search(right.strip()[1:-1], lv) is not None
            same = lv == operand(right)
            return same if op == "==" else not same
    v = operand(text)
    return v is not None and v != ""


def condition(text):
    return any(all(atom(a) for a in part.split("&&")) for part in text.split("||"))


def glob_re(glob):
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif glob.startswith("**", i):
            out += ".*"
            i += 2
        elif glob[i] == "*":
            out += "[^/]*"
            i += 1
        else:
            out += re.escape(glob[i])
            i += 1
    return out


def matches(rule):
    if "if" in rule and not condition(rule["if"]):
        return False
    if "changes" in rule:
        if event["kind"] == "tag":
            return True
        return any(re.fullmatch(glob_re(g), f) for g in rule["changes"] for f in changed)
    return True


def first(rules):
    for rule in rules:
        if matches(rule):
            return None if rule.get("when") == "never" else rule
    return None


def main():
    if "workflow" in doc:
        rule = first(doc["workflow"]["rules"])
        if rule is None:
            return ["-"]
        env.update(rule.get("variables") or {})
    created = {}
    for name, job in doc.items():
        if name in ("stages", "workflow"):
            continue
        if "rules" not in job:
            created[name] = "on_success"
            continue
        rule = first(job["rules"])
        if rule is not None:
            created[name] = rule.get("when", "on_success")
    broken = []
    for name in created:
        for need in doc[name].get("needs") or []:
            target = need if isinstance(need, str) else need["job"]
            optional = not isinstance(need, str) and need.get("optional") == "true"
            if target not in created and not optional:
                broken.append("error " + name + " " + target)
    if broken:
        return broken
    if not created:
        return ["-"]
    return [n + " manual" if w == "manual" else n for n, w in created.items()]


for line in main():
    print(line)
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
		if (CREATED.has(key) && (answer[0] === '-' || answer.some((a) => a.startsWith('error ')))) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value.join('\n') === answer.join('\n') ? null : value];
			})
		);
		if ((REQUIRED[key] ?? []).some((id) => wrong[id] === null)) continue;
		const yaml = pipelineYaml(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, input.grade === 'middle'), code: { language: 'yaml', source: yaml } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ yaml, event: p.event, changed: p.changed })
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
