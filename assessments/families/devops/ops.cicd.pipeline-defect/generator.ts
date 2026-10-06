// A GitHub Actions workflow and its specification (deploy only from main by push and only after the tests, tests on
// every pull request into main, the dependency cache keyed by the lock file, no secret in the log or in a command,
// deploys never in parallel). Exactly one line breaks the specification; the candidate names it.
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

/** A line of the workflow; `tag` names the lines a defect or a wrong answer may point at. */
interface Line {
	text: string;
	tag?: string;
}

interface Stack {
	setup: string[];
	cachePath: string;
	lock: string;
	manifest: string;
	install: string;
	test: string;
	build: string;
	lint: string;
}

const STACKS: Stack[] = [
	{
		setup: ['      - uses: actions/setup-node@v4', '        with:', '          node-version: 22'],
		cachePath: '~/.npm',
		lock: 'package-lock.json',
		manifest: 'package.json',
		install: 'npm ci',
		test: 'npm test',
		build: 'npm run build',
		lint: 'npm run lint'
	},
	{
		setup: ['      - uses: actions/setup-python@v5', '        with:', "          python-version: '3.12'"],
		cachePath: '~/.cache/pypoetry',
		lock: 'poetry.lock',
		manifest: 'pyproject.toml',
		install: 'poetry install --no-root',
		test: 'poetry run pytest',
		build: 'poetry build',
		lint: 'poetry run ruff check .'
	},
	{
		setup: ['      - uses: actions/setup-go@v5', '        with:', "          go-version: '1.23'"],
		cachePath: '~/go/pkg/mod',
		lock: 'go.sum',
		manifest: 'go.mod',
		install: 'go mod download',
		test: 'go test ./...',
		build: 'go build ./cmd/server',
		lint: 'go vet ./...'
	}
];

const COMMENTS = [
	'Tests on every change, deploys from main.',
	'Owner: platform team.',
	'Deploy secrets live in the repository settings.',
	'Keep the job names: branch protection refers to them.',
	'See docs/ci.md for the release process.',
	'Runners: GitHub-hosted only.',
	'Do not add jobs without an owner.'
];

const ENV_VARS = [
	'LOG_LEVEL: info',
	'TZ: UTC',
	'FORCE_COLOR: 1',
	'CI_RETRIES: 2',
	'REGISTRY: ghcr.io',
	'IMAGE_NAME: shop-api',
	'HELM_VERSION: 3.15.4',
	'DOCKER_BUILDKIT: 1',
	'APP_REGION: eu-central'
];

interface Defect {
	tag: string;
	text: string;
}

interface Workflow {
	lines: Line[];
	test: string;
	deploy: string;
}

function workflow(rng: Rng, senior: boolean): Workflow & { stack: Stack; secretEnv: string } {
	const stack = rng.pick(STACKS);
	const test = rng.pick(['test', 'tests', 'unit']);
	const deploy = rng.pick(['deploy', 'deploy-prod', 'release']);
	const secretEnv = rng.pick(['DEPLOY_TOKEN', 'KUBE_TOKEN', 'REGISTRY_PASSWORD']);
	const secretName = rng.pick(['PROD_DEPLOY_TOKEN', 'DEPLOY_KEY', 'CD_TOKEN']);
	const withBuild = senior || rng.bool(0.6);
	const lines: Line[] = rng.sample(COMMENTS, rng.int(0, COMMENTS.length)).map((c) => ({ text: `# ${c}` }));
	lines.push({ text: `name: ${rng.pick(['ci', 'Build and deploy', 'pipeline', 'main'])}` });
	if (rng.bool(0.3)) lines.push({ text: 'run-name: ${{ github.event_name }} on ${{ github.ref_name }}' });
	const sections: Line[][] = [];
	const on: Line[] = [{ text: 'on:' }];
	const prFilters: Line[] = [{ text: '    branches: [main]', tag: 'pr-branches' }];
	if (rng.bool(0.5)) prFilters.push({ text: '    types: [opened, synchronize, reopened]', tag: 'pr-types' });
	const pr: Line[] = [{ text: '  pull_request:' }, ...rng.shuffle(prFilters)];
	const events: Line[][] = [pr, [{ text: '  push:' }, { text: "    branches: ['**']", tag: 'push-branches' }]];
	if (rng.bool(0.4)) events.push([{ text: '  workflow_dispatch:' }]);
	if (rng.bool(0.3))
		events.push([{ text: '  schedule:' }, { text: `    - cron: '${rng.int(0, 59)} ${rng.int(0, 6)} * * *'` }]);
	for (const e of rng.shuffle(events)) on.push(...e);
	sections.push(on);
	const permissions = rng.sample(['contents: read', 'packages: write', 'id-token: write'], rng.int(0, 3));
	if (permissions.length) sections.push([{ text: 'permissions:' }, ...permissions.map((x) => ({ text: `  ${x}` }))]);
	const env = rng.sample(ENV_VARS, rng.int(0, ENV_VARS.length));
	if (env.length) sections.push([{ text: 'env:' }, ...env.map((x) => ({ text: `  ${x}` }))]);
	if (rng.bool(0.4)) sections.push([{ text: 'defaults:' }, { text: '  run:' }, { text: '    shell: bash' }]);
	for (const section of rng.shuffle(sections)) {
		if (rng.bool(0.3)) lines.push({ text: '' });
		lines.push(...section);
	}
	lines.push({ text: 'jobs:' });

	const jobs: Line[][] = [];
	if (rng.bool(0.5))
		jobs.push([
			{ text: '  lint:' },
			{ text: '    runs-on: ubuntu-latest' },
			{ text: '    steps:' },
			{ text: '      - uses: actions/checkout@v4' },
			{ text: `      - run: ${stack.lint}` }
		]);
	if (rng.bool(0.3))
		jobs.push([
			{ text: '  audit:' },
			{ text: '    runs-on: ubuntu-latest' },
			{ text: '    continue-on-error: true' },
			{ text: '    steps:' },
			{ text: '      - uses: actions/checkout@v4' },
			{ text: '      - run: ./scripts/audit.sh' }
		]);
	if (rng.bool(0.3))
		jobs.push([
			{ text: '  docs:' },
			{ text: '    runs-on: ubuntu-latest' },
			{ text: '    steps:' },
			{ text: '      - uses: actions/checkout@v4' },
			{ text: '      - run: ./scripts/build-docs.sh' },
			{ text: '      - run: ./scripts/check-links.sh' }
		]);
	const testJob: Line[] = [{ text: `  ${test}:` }, { text: '    runs-on: ubuntu-latest' }];
	if (rng.bool(0.6)) testJob.push({ text: "    if: github.event_name != 'schedule'", tag: 'test-if' });
	if (rng.bool(0.4)) testJob.push({ text: `    timeout-minutes: ${rng.pick([10, 15, 20, 30])}` });
	testJob.push(
		{ text: '    steps:' },
		{ text: '      - uses: actions/checkout@v4' },
		...stack.setup.map((text) => ({ text })),
		{ text: '      - uses: actions/cache@v4' },
		{ text: '        with:' },
		{ text: `          path: ${stack.cachePath}`, tag: 'cache-path' },
		{
			text: `          key: \${{ runner.os }}-deps-\${{ hashFiles('${stack.lock}') }}`,
			tag: 'cache-key'
		},
		{ text: `      - run: ${stack.install}` }
	);
	if (rng.bool(0.4)) testJob.push({ text: `      - run: ${stack.lint}` });
	testJob.push({ text: `      - run: ${stack.test}` });
	if (rng.bool(0.4))
		testJob.push(
			{ text: '      - uses: actions/upload-artifact@v4' },
			{ text: '        with:' },
			{ text: '          name: test-report' },
			{ text: '          path: reports/' }
		);
	jobs.push(testJob);
	if (withBuild)
		jobs.push([
			{ text: '  build:' },
			{ text: '    runs-on: ubuntu-latest' },
			{ text: '    steps:' },
			{ text: '      - uses: actions/checkout@v4' },
			{ text: `      - run: ${stack.build}` }
		]);
	const needs = withBuild && rng.bool(0.5) ? `[${test}, build]` : `[${test}]`;
	const ifText = rng.bool()
		? "github.ref == 'refs/heads/main' && github.event_name == 'push'"
		: "github.event_name == 'push' && github.ref == 'refs/heads/main'";
	const head: Line[] = [
		{ text: `    needs: ${needs}`, tag: 'needs' },
		{ text: `    if: ${ifText}`, tag: 'if' },
		{ text: '    runs-on: ubuntu-latest' }
	];
	const deployJob: Line[] = [{ text: `  ${deploy}:` }, ...(rng.bool(0.7) ? head : rng.shuffle(head))];
	if (rng.bool(0.5)) deployJob.push({ text: '    environment: production' });
	if (rng.bool(0.3)) deployJob.push({ text: `    timeout-minutes: ${rng.pick([20, 30, 45])}` });
	deployJob.push(
		{ text: '    concurrency:' },
		{ text: `      group: ${rng.pick(['production', 'deploy-prod', 'prod-release'])}`, tag: 'group' }
	);
	if (senior || rng.bool(0.6)) deployJob.push({ text: '      cancel-in-progress: false', tag: 'cancel' });
	deployJob.push(
		{ text: '    env:' },
		{ text: `      ${secretEnv}: \${{ secrets.${secretName} }}`, tag: 'secret-env' }
	);
	if (rng.bool(0.4)) deployJob.push({ text: `      APP_ENV: ${rng.pick(['production', 'prod'])}` });
	deployJob.push({ text: '    steps:' }, { text: '      - uses: actions/checkout@v4', tag: 'deploy-checkout' });
	if (rng.bool(0.4))
		deployJob.push(
			{ text: '      - uses: actions/download-artifact@v4' },
			{ text: '        with:' },
			{ text: '          name: dist' }
		);
	deployJob.push(
		{ text: `      - run: echo "Deploying $GITHUB_SHA"`, tag: 'deploy-echo' },
		{ text: `      - run: ./scripts/deploy.sh ${rng.pick(['production', 'prod'])}`, tag: 'deploy-run' }
	);
	const others = rng.shuffle(jobs);
	const at = rng.bool(0.25) && others.length > 1 ? others.length - 1 : others.length;
	others.splice(at, 0, deployJob);
	for (const job of others) {
		if (rng.bool(0.5)) lines.push({ text: '' });
		lines.push(...job);
	}
	return { lines, test, deploy, stack, secretEnv };
}

/** The defects of a class that the workflow can take; each replaces one tagged line. */
function defects(w: Workflow & { stack: Stack; secretEnv: string }, classId: string): Defect[] {
	const has = (tag: string): boolean => w.lines.some((l) => l.tag === tag);
	const ifRest = "github.event_name == 'push'";
	const secretName = /secrets\.(\w+)/.exec(w.lines.find((l) => l.tag === 'secret-env')?.text ?? '')?.[1] ?? '';
	const list: Record<string, Defect[]> = {
		'branch-condition': [
			{ tag: 'if', text: `    if: github.ref != 'refs/heads/main' && ${ifRest}` },
			{ tag: 'if', text: `    if: github.ref == 'refs/heads/develop' && ${ifRest}` },
			{ tag: 'if', text: `    if: github.ref == 'refs/heads/main' || ${ifRest}` },
			{ tag: 'if', text: "    if: github.ref == 'refs/heads/main' && github.event_name != 'push'" }
		],
		'cache-key': [
			{ tag: 'cache-key', text: `          key: \${{ runner.os }}-deps-\${{ hashFiles('${w.stack.manifest}') }}` },
			{ tag: 'cache-key', text: '          key: ${{ runner.os }}-deps-${{ github.sha }}' },
			{ tag: 'cache-key', text: '          key: ${{ runner.os }}-deps' }
		],
		'pr-trigger': [
			{ tag: 'pr-branches', text: '    branches: [develop]' },
			{ tag: 'pr-branches', text: "    branches: ['release/**']" },
			...(has('pr-types') ? [{ tag: 'pr-types', text: '    types: [closed]' }] : []),
			{ tag: 'test-if', text: "    if: github.event_name == 'push'" },
			{ tag: 'test-if', text: "    if: github.event_name != 'pull_request'" }
		],
		'secret-echo': [
			{ tag: 'deploy-echo', text: `      - run: echo "Deploying $GITHUB_SHA with $${w.secretEnv}"` },
			{ tag: 'deploy-echo', text: `      - run: echo "token=\${${w.secretEnv}}"` }
		],
		'deploy-after-tests': [
			{ tag: 'needs', text: '    needs: [build]' },
			{
				tag: 'if',
				text: `    if: always() && github.ref == 'refs/heads/main' && ${ifRest}`
			}
		],
		'concurrency-group': [
			{ tag: 'group', text: '      group: production-${{ github.sha }}' },
			{ tag: 'group', text: '      group: deploy-${{ github.run_id }}' },
			{ tag: 'group', text: '      group: release-${{ github.run_number }}' },
			{ tag: 'cancel', text: '      cancel-in-progress: true' }
		],
		'secret-expression': [
			{
				tag: 'deploy-run',
				text: `      - run: ./scripts/deploy.sh production --token "\${{ secrets.${secretName} }}"`
			},
			{ tag: 'deploy-echo', text: `      - run: printf '%s' "$${w.secretEnv}" | base64` }
		],
		'subtle-branch': [
			{ tag: 'if', text: `    if: contains(github.ref, 'main') && ${ifRest}` },
			{ tag: 'if', text: `    if: startsWith(github.ref, 'refs/heads/main') && ${ifRest}` },
			{ tag: 'if', text: `    if: github.base_ref == 'main' && ${ifRest}` }
		]
	};
	return (list[classId] ?? []).filter((d) => has(d.tag));
}

/** A correct line tied to the same property as the defect: it looks guilty, but the specification holds there. */
const SAME_PROPERTY: Record<string, string> = {
	if: 'needs',
	needs: 'if',
	'cache-key': 'cache-path',
	'pr-branches': 'push-branches',
	'pr-types': 'push-branches',
	'test-if': 'pr-branches',
	'deploy-echo': 'secret-env',
	'deploy-run': 'secret-env',
	group: 'cancel',
	cancel: 'group'
};

const SPEC = [
	'Спецификация workflow:',
	'',
	'1. **Деплой только с `main` и только после тестов.** Задание деплоя выполняется при push в ветку `main`, если задание тестов завершилось успешно, и не выполняется ни при каком другом событии или ветке (pull request в `main`, push в другие ветки, в том числе `develop`, `maintenance`, `main-hotfix`, ручной запуск) и при упавших тестах. Задание без `if` или с `if` без функции статуса выполняется, только если все задания-предки по `needs` завершились успешно; `always()` снимает это требование.',
	'2. **Тесты на каждом pull request в `main`.** Workflow запускается на открытие и обновление pull request в `main`, и задание тестов на нём выполняется.',
	'3. **Кэш зависимостей — по lock-файлу.** Ключ `actions/cache` одинаков у двух запусков с одинаковым lock-файлом (даже на разных коммитах) и меняется, когда меняется lock-файл (даже если файл манифеста не менялся).',
	'4. **Секрет не попадает в журнал.** Значение `secrets.*` передаётся командам только через `env:`; выражение `${{ secrets.… }}` не подставляется в текст `run`, и ни одна команда `echo`/`printf` не выводит переменную окружения с секретом (в том числе в преобразованном виде).',
	'5. **Деплои не идут параллельно и не прерываются.** У задания деплоя `concurrency` с группой, одинаковой у всех запусков, и без `cancel-in-progress: true`.'
].join('\n');

const PYTHON_REFERENCE = String.raw`${PY_PIPELINE_YAML}
data = json.loads(input())
TEST = data["test"]
DEPLOY = data["deploy"]
LOCK = data["lock"]
MANIFEST = data["manifest"]


def tokenize(expr):
    out, i = [], 0
    while i < len(expr):
        ch = expr[i]
        if ch.isspace():
            i += 1
        elif expr.startswith(("==", "!=", "&&", "||"), i):
            out.append(expr[i : i + 2])
            i += 2
        elif ch in "()!,":
            out.append(ch)
            i += 1
        elif ch == "'":
            j = expr.index("'", i + 1)
            out.append(("str", expr[i + 1 : j]))
            i = j + 1
        else:
            j = i
            while j < len(expr) and (expr[j].isalnum() or expr[j] in "._-"):
                j += 1
            out.append(("id", expr[i:j]))
            i = j
    return out


class Expr:
    def __init__(self, text, ctx):
        self.t = tokenize(text)
        self.p = 0
        self.ctx = ctx
        self.status_used = False

    def peek(self):
        return self.t[self.p] if self.p < len(self.t) else None

    def take(self):
        tok = self.t[self.p]
        self.p += 1
        return tok

    def parse_or(self):
        v = self.parse_and()
        while self.peek() == "||":
            self.take()
            v = self.parse_and() or v
        return v

    def parse_and(self):
        v = self.parse_unary()
        while self.peek() == "&&":
            self.take()
            w = self.parse_unary()
            v = v and w
        return v

    def parse_unary(self):
        if self.peek() == "!":
            self.take()
            return not self.parse_unary()
        left = self.primary()
        if self.peek() in ("==", "!="):
            op = self.take()
            right = self.primary()
            return (left == right) == (op == "==")
        return left

    def primary(self):
        tok = self.take()
        if isinstance(tok, tuple) and tok[0] == "str":
            return tok[1]
        name = tok[1]
        if self.peek() == "(":
            self.take()
            args = []
            while self.peek() != ")":
                if self.peek() == ",":
                    self.take()
                    continue
                args.append(self.parse_or())
            self.take()
            if name in ("success", "failure", "always"):
                self.status_used = True
                return self.ctx[name]
            if name == "contains":
                return args[1] in args[0]
            if name == "startsWith":
                return args[0].startswith(args[1])
            raise ValueError("function " + name)
        return self.ctx["vars"].get(name, "")


def glob(pattern, text):
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out += ".*"
            i += 2
        elif pattern[i] == "*":
            out += "[^/]*"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.fullmatch(out, text) is not None


def triggers(doc, event, branch):
    on = doc["on"]
    if event not in on:
        return False
    spec = on[event] or {}
    if "branches" in spec and not any(glob(b, branch) for b in spec["branches"]):
        return False
    if event == "pull_request" and "types" in spec:
        if not ("opened" in spec["types"] and "synchronize" in spec["types"]):
            return False
    return True


def ancestors(jobs, name):
    seen, stack = set(), []
    needs = jobs[name].get("needs") or []
    stack.extend([needs] if isinstance(needs, str) else needs)
    while stack:
        n = stack.pop()
        if n not in seen:
            seen.add(n)
            more = jobs[n].get("needs") or []
            stack.extend([more] if isinstance(more, str) else more)
    return seen


def runs(doc, job, event, ref, base_ref, failing):
    jobs = doc["jobs"]
    statuses = {n: ("failure" if n in failing else "success") for n in jobs}
    anc = ancestors(jobs, job)
    ctx = {
        "success": all(statuses[a] == "success" for a in anc),
        "failure": any(statuses[a] == "failure" for a in anc),
        "always": True,
        "vars": {"github.event_name": event, "github.ref": ref, "github.base_ref": base_ref},
    }
    cond = jobs[job].get("if")
    if cond is None:
        return ctx["success"]
    e = Expr(cond, ctx)
    value = e.parse_or()
    if not e.status_used:
        value = value and ctx["success"]
    return bool(value)


def template(text, state):
    def sub(m):
        expr = m.group(1).strip()
        h = re.fullmatch(r"hashFiles\('([^']+)'\)", expr)
        if h:
            return "h(" + state["files"].get(h.group(1), "") + ")"
        return state[expr]

    return re.sub(r"\$\{\{(.*?)\}\}", sub, text)


def violations(source):
    doc = parse_yaml(source)
    jobs = doc["jobs"]
    found = []
    # 1. Deploy only from main by push, after the tests.
    deploy_runs = lambda ev, ref, base, failing: triggers(doc, ev, ref.split("/", 2)[2] if ref.startswith("refs/heads/") else base) and runs(doc, DEPLOY, ev, ref, base, failing)
    if not deploy_runs("push", "refs/heads/main", "", set()):
        found.append("deploy does not run on push to main")
    if deploy_runs("push", "refs/heads/main", "", {TEST}):
        found.append("deploy runs after failed tests")
    for branch in ("develop", "maintenance", "main-hotfix", "feature/main-menu"):
        if deploy_runs("push", "refs/heads/" + branch, "", set()):
            found.append("deploy runs on push to " + branch)
    if deploy_runs("pull_request", "refs/pull/7/merge", "main", set()):
        found.append("deploy runs on a pull request")
    if "workflow_dispatch" in doc["on"] and runs(doc, DEPLOY, "workflow_dispatch", "refs/heads/main", "", set()):
        found.append("deploy runs on a manual start")
    # 2. Tests on every pull request into main.
    if not (triggers(doc, "pull_request", "main") and runs(doc, TEST, "pull_request", "refs/pull/7/merge", "main", set())):
        found.append("tests do not run on a pull request into main")
    # 3. Cache keyed by the lock file.
    keys = [s["with"]["key"] for j in jobs.values() for s in j["steps"] if str(s.get("uses", "")).startswith("actions/cache@")]
    if not keys:
        found.append("no cache")
    base = {"files": {LOCK: "L1", MANIFEST: "M1"}, "github.sha": "a1", "github.run_id": "101", "github.run_number": "7", "runner.os": "Linux"}
    other_commit = dict(base, **{"github.sha": "b2", "github.run_id": "102", "github.run_number": "8"})
    new_lock = dict(base, files={LOCK: "L2", MANIFEST: "M1"})
    for key in keys:
        if template(key, base) != template(key, other_commit):
            found.append("cache key changes without a lock change")
        if template(key, base) == template(key, new_lock):
            found.append("cache key ignores the lock file")
    # 4. Secrets only through env and never printed.
    for job in jobs.values():
        secret_vars = {k for k, v in (job.get("env") or {}).items() if "secrets." in v}
        for step in job["steps"]:
            run = step.get("run")
            if run is None:
                continue
            names = secret_vars | {k for k, v in (step.get("env") or {}).items() if "secrets." in v}
            if "secrets." in run:
                found.append("secret expression in run")
            for segment in re.split(r"\||&&|;|\n", run):
                words = segment.split()
                if words and words[0] in ("echo", "printf"):
                    for n in names:
                        if "$" + n in segment or "$" + "{" + n + "}" in segment:
                            found.append("secret printed")
    # 5. Deploys never in parallel and never interrupted.
    conc = jobs[DEPLOY].get("concurrency")
    if conc is None:
        found.append("no concurrency")
    else:
        group = conc if isinstance(conc, str) else conc["group"]
        if template(group, base) != template(group, other_commit):
            found.append("concurrency group differs between runs")
        if not isinstance(conc, str) and conc.get("cancel-in-progress") == "true":
            found.append("a running deploy is cancelled")
    return found


lines = data["source"].split("\n")
fixed = lines[: data["line"] - 1] + [data["fix"]] + lines[data["line"] :]
broken = violations(data["source"])
repaired = violations("\n".join(fixed))
if broken and not repaired:
    print(data["line"])
else:
    print("defect", broken, "fixed", repaired)
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 200; tries += 1) {
		const w = workflow(rng, input.grade === 'senior');
		const options = defects(w, input.classId);
		if (options.length === 0) continue;
		const defect = rng.pick(options);
		const index = w.lines.findIndex((l) => l.tag === defect.tag);
		const original = w.lines[index]?.text ?? '';
		const shown = w.lines.map((l, i) => (i === index ? defect.text : l.text));
		const answer = index + 1;
		const sameTag = SAME_PROPERTY[defect.tag] ?? 'deploy-checkout';
		const same = w.lines.findIndex((l) => l.tag === sameTag) + 1;
		const symptomTag = defect.tag === 'deploy-run' ? 'deploy-checkout' : 'deploy-run';
		const symptom = w.lines.findIndex((l) => l.tag === symptomTag) + 1;
		if (same <= 0 || symptom <= 0 || same === answer || symptom === answer) continue;
		const source = shown.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					'Workflow GitHub Actions ниже должен выполнять спецификацию. Ровно одна строка её нарушает: если заменить только эту строку, все пункты спецификации будут выполнены. Введите номер этой строки (нумерация с 1).',
					'',
					`Задание тестов — \`${w.test}\`, задание деплоя — \`${w.deploy}\`. Фильтр \`branches\` — шаблоны имён веток (\`*\` — любые символы, кроме \`/\`, \`**\` — любые); у события \`pull_request\` это целевая ветка, без \`types\` — запуск на открытие, обновление и переоткрытие.`,
					'',
					SPEC
				].join('\n'),
				code: { language: 'yaml', source }
			},
			answer: { kind: 'line_no', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({
					source,
					line: answer,
					fix: original,
					test: w.test,
					deploy: w.deploy,
					lock: w.stack.lock,
					manifest: w.stack.manifest
				})
			}),
			wrong: () => ({
				'same-property-line': { kind: 'answer', answer: { kind: 'line_no', value: same } },
				'symptom-line': { kind: 'answer', answer: { kind: 'line_no', value: symptom } }
			})
		};
	}
	throw new Error(`${descriptor.key}: no workflow for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
