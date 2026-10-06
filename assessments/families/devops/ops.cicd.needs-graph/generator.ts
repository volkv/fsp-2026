// Statuses of the jobs of a GitHub Actions workflow: jobs wait for their `needs`, a job's `if` with the status
// functions decides whether it runs, a failed command fails its job unless the step may fail. The candidate gives the
// status of every job.
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

type Cond =
	| { kind: 'none' }
	| { kind: 'always' }
	| { kind: 'failure' }
	| { kind: 'ref'; op: '==' | '!='; branch: string }
	| { kind: 'always-result'; need: string; result: 'success' | 'failure' };

type CondKind = Cond['kind'];

interface Step {
	run: string;
	mayFail: boolean;
}

interface Job {
	id: string;
	needs: string[];
	cond: Cond;
	checkout: boolean;
	steps: Step[];
}

interface Params {
	branch: string;
	jobs: Job[];
	failing: string[];
	wrapExpressions: boolean;
}

type Status = 'success' | 'failure' | 'skipped';

interface Rules {
	failureDirectOnly: boolean;
	alwaysIgnored: boolean;
	continueFailsJob: boolean;
	failureRunsAlways: boolean;
	directNeedsSuccess: boolean;
	explicitIfNoImplicit: boolean;
	skipDirectOnly: boolean;
}

const RIGHT: Rules = {
	failureDirectOnly: false,
	alwaysIgnored: false,
	continueFailsJob: false,
	failureRunsAlways: false,
	directNeedsSuccess: false,
	explicitIfNoImplicit: false,
	skipDirectOnly: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'failure-direct-only': { failureDirectOnly: true },
	'always-ignored': { alwaysIgnored: true },
	'continue-fails-job': { continueFailsJob: true },
	'failure-runs-always': { failureRunsAlways: true },
	'direct-needs-success': { directNeedsSuccess: true },
	'explicit-if-no-implicit': { explicitIfNoImplicit: true },
	'skip-not-transitive': { skipDirectOnly: true }
};

/** Statuses of the jobs in the order of the file. */
function simulate(p: Params, rules: Rules): string[] {
	const status = new Map<string, Status>();
	const byId = new Map(p.jobs.map((j) => [j.id, j]));
	const ancestors = (job: Job): string[] => {
		const seen = new Set<string>();
		const stack = [...job.needs];
		while (stack.length) {
			const id = stack.pop() as string;
			if (seen.has(id)) continue;
			seen.add(id);
			stack.push(...(byId.get(id)?.needs ?? []));
		}
		return [...seen];
	};
	const failing = new Set(p.failing);
	for (const job of p.jobs) {
		const of = (id: string): Status => status.get(id) ?? 'skipped';
		const success = rules.directNeedsSuccess
			? job.needs.every((n) => of(n) === 'success')
			: rules.skipDirectOnly
				? job.needs.every((n) => of(n) !== 'failure')
				: ancestors(job).every((a) => of(a) === 'success');
		const failure = rules.failureDirectOnly
			? job.needs.some((n) => of(n) === 'failure')
			: ancestors(job).some((a) => of(a) === 'failure');
		const always = rules.alwaysIgnored ? success : true;
		let runs: boolean;
		switch (job.cond.kind) {
			case 'none':
				runs = success;
				break;
			case 'always':
				runs = always;
				break;
			case 'failure':
				runs = rules.failureRunsAlways ? true : failure;
				break;
			case 'ref': {
				const equal = job.cond.branch === p.branch;
				const holds = job.cond.op === '==' ? equal : !equal;
				runs = (rules.explicitIfNoImplicit || success) && holds;
				break;
			}
			case 'always-result':
				runs = always && of(job.cond.need) === job.cond.result;
				break;
		}
		if (!runs) {
			status.set(job.id, 'skipped');
			continue;
		}
		const failed = job.steps.some((s) => failing.has(s.run) && (!s.mayFail || rules.continueFailsJob));
		status.set(job.id, failed ? 'failure' : 'success');
	}
	return p.jobs.map((j) => `${j.id} ${status.get(j.id) ?? 'skipped'}`);
}

const COMMANDS: Record<string, string[]> = {
	lint: ['npm run lint', 'npx prettier --check .'],
	typecheck: ['npm run typecheck'],
	unit: ['npm run test:unit', 'npx vitest run --coverage'],
	integration: ['npm run test:integration'],
	build: ['npm run build', 'npm run build:client'],
	e2e: ['npx playwright test', 'npm run test:e2e'],
	package: ['npm pack', 'tar -czf dist.tgz dist'],
	docker: ['docker build -t app:ci .', 'docker push registry.local/app:ci'],
	'deploy-staging': ['./scripts/deploy.sh staging', 'helm upgrade app ./chart -n staging'],
	'deploy-prod': ['./scripts/deploy.sh production', 'helm upgrade app ./chart -n prod'],
	notify: ['./scripts/notify.sh', 'curl -fsS -X POST "$CHAT_HOOK" -d @message.json'],
	report: ['./scripts/report.sh', 'npx junit-merge reports/*.xml'],
	cleanup: ['./scripts/cleanup.sh', 'docker image prune -f'],
	audit: ['npm audit --audit-level=high'],
	docs: ['npm run docs', 'npx typedoc'],
	smoke: ['./scripts/smoke.sh', 'curl -fsS https://staging.example.test/health'],
	publish: ['npm publish --dry-run'],
	migrate: ['npm run db:migrate'],
	coverage: ['npx nyc check-coverage --lines 80'],
	sbom: ['npx cyclonedx-npm --output-file sbom.json']
};
const NAMES = Object.keys(COMMANDS);
const BRANCHES = ['main', 'develop', 'release/2.4', 'feature/search', 'fix/login-timeout', 'feature/billing'];
const REF_BRANCHES = ['main', 'develop', 'release/2.4'];

interface ClassSpec {
	conds: CondKind[];
	jobs: [number, number];
	failures: [number, number];
	mayFail: number;
}

const SPECS: Record<string, ClassSpec> = {
	'intern/skip-chain': { conds: [], jobs: [4, 6], failures: [1, 1], mayFail: 0 },
	'intern/always': { conds: ['always'], jobs: [4, 6], failures: [1, 1], mayFail: 0 },
	'intern/continue-step': { conds: [], jobs: [4, 6], failures: [1, 1], mayFail: 1 },
	'intern/failure-notify': { conds: ['failure'], jobs: [4, 6], failures: [0, 1], mayFail: 0 },
	'junior/failure-transitive': { conds: ['failure', 'always'], jobs: [6, 8], failures: [1, 2], mayFail: 0.3 },
	'junior/implicit-success': { conds: ['ref', 'failure'], jobs: [6, 8], failures: [1, 2], mayFail: 0.3 },
	'junior/always-middle': { conds: ['always', 'ref'], jobs: [6, 8], failures: [1, 2], mayFail: 0.3 },
	'junior/explicit-result': { conds: ['always-result', 'failure', 'ref'], jobs: [6, 8], failures: [1, 2], mayFail: 0.3 }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/skip-chain': ['skip-not-transitive'],
	'intern/always': ['always-ignored'],
	'intern/continue-step': ['continue-fails-job'],
	'intern/failure-notify': ['failure-runs-always'],
	'junior/failure-transitive': ['failure-direct-only'],
	'junior/implicit-success': ['explicit-if-no-implicit'],
	'junior/always-middle': ['direct-needs-success'],
	'junior/explicit-result': ['always-ignored']
};

function scenario(rng: Rng, spec: ClassSpec): Params {
	const n = rng.int(spec.jobs[0], spec.jobs[1]);
	const ids = rng.sample(NAMES, n);
	const jobs: Job[] = [];
	for (const [i, id] of ids.entries()) {
		const needs = i === 0 || rng.bool(0.15) ? [] : rng.sample(ids.slice(0, i), Math.min(i, rng.int(1, 2)));
		let cond: Cond = { kind: 'none' };
		if (i > 0 && spec.conds.length > 0 && rng.bool(0.4)) {
			const kind = rng.pick(spec.conds);
			if (kind === 'ref') cond = { kind, op: rng.bool(0.7) ? '==' : '!=', branch: rng.pick(REF_BRANCHES) };
			else if (kind === 'always-result') {
				if (needs.length > 0) {
					cond = { kind, need: rng.pick(needs), result: rng.bool(0.6) ? 'success' : 'failure' };
				}
			} else cond = { kind };
		}
		const all = COMMANDS[id] ?? [];
		const commands = all.slice(0, rng.int(1, all.length));
		jobs.push({
			id,
			needs,
			cond,
			checkout: rng.bool(0.6),
			steps: commands.map((run) => ({ run, mayFail: false }))
		});
	}
	const failingJobs = rng.sample(
		jobs.filter((j) => j.cond.kind === 'none'),
		Math.min(rng.int(spec.failures[0], spec.failures[1]), jobs.filter((j) => j.cond.kind === 'none').length)
	);
	const failing: string[] = [];
	for (const job of failingJobs) {
		const step = rng.pick(job.steps);
		failing.push(step.run);
		if (rng.bool(spec.mayFail)) step.mayFail = true;
	}
	return { branch: rng.pick(BRANCHES), jobs, failing, wrapExpressions: rng.bool(0.4) };
}

function condText(cond: Cond): string | null {
	switch (cond.kind) {
		case 'none':
			return null;
		case 'always':
			return 'always()';
		case 'failure':
			return 'failure()';
		case 'ref':
			return `github.ref ${cond.op} 'refs/heads/${cond.branch}'`;
		case 'always-result':
			return `always() && needs.${cond.need}.result == '${cond.result}'`;
	}
}

function workflowYaml(p: Params): string {
	const lines = ['name: ci', 'on:', '  push:', "    branches: ['**']", 'jobs:'];
	for (const job of p.jobs) {
		lines.push(`  ${job.id}:`);
		if (job.needs.length === 1 && job.needs[0] !== undefined && job.id.length % 2 === 0)
			lines.push(`    needs: ${job.needs[0]}`);
		else if (job.needs.length > 0) lines.push(`    needs: [${job.needs.join(', ')}]`);
		const cond = condText(job.cond);
		if (cond !== null) lines.push(`    if: ${p.wrapExpressions ? `\${{ ${cond} }}` : cond}`);
		lines.push('    runs-on: ubuntu-latest', '    steps:');
		if (job.checkout) lines.push('      - uses: actions/checkout@v4');
		for (const step of job.steps) {
			lines.push(`      - run: ${step.run}`);
			if (step.mayFail) lines.push('        continue-on-error: true');
		}
	}
	return lines.join('\n');
}

function describe(p: Params): string {
	const failing =
		p.failing.length === 0
			? 'В этом запуске все команды завершатся успешно.'
			: `В этом запуске ненулевым кодом завершатся команды ${p.failing.map((c) => `\`${c}\``).join(', ')}; все остальные команды завершатся успешно.`;
	return [
		`Workflow GitHub Actions ниже запущен push-событием в ветку \`${p.branch}\` (\`github.ref\` = \`refs/heads/${p.branch}\`). ${failing}`,
		'',
		'Правила, по которым GitHub Actions решает судьбу заданий:',
		'',
		'- задание ждёт, пока завершатся все задания из его `needs`, затем вычисляет своё условие `if`; ложное условие — задание не выполняется и получает статус `skipped`;',
		'- задание без `if` выполняется при условии `success()`; если в `if` нет ни одной функции статуса (`success()`, `failure()`, `always()`), условие неявно становится `success() && (<условие>)`;',
		'- `success()` истинно, если все задания-предки — из `needs` напрямую и через цепочку `needs` — завершились со статусом `success`; `failure()` истинно, если хотя бы один предок завершился со статусом `failure`; `always()` истинно всегда; `needs.<id>.result` — статус задания `<id>`;',
		'- выполненное задание получает статус `failure`, если какая-то его команда завершилась ненулевым кодом, а у шага нет `continue-on-error: true`; ошибка шага с `continue-on-error: true` на статус задания не влияет; иначе — `success`.',
		'',
		'Введите статус каждого задания (`success`, `failure` или `skipped`) — по строке `<задание> <статус>`, в порядке заданий в файле. Например:',
		'',
		'```',
		'lint success',
		'build failure',
		'deploy skipped',
		'```'
	].join('\n');
}

const PYTHON_REFERENCE = String.raw`${PY_PIPELINE_YAML}

data = json.loads(input())
doc = parse_yaml(data["yaml"])
ref = "refs/heads/" + data["branch"]
failing = set(data["failing"])
jobs = doc["jobs"]
needs_of = {}
for name, job in jobs.items():
    needs = job.get("needs") or []
    needs_of[name] = [needs] if isinstance(needs, str) else needs


def ancestors(name):
    seen = set()
    stack = list(needs_of[name])
    while stack:
        n = stack.pop()
        if n not in seen:
            seen.add(n)
            stack.extend(needs_of[n])
    return seen


OPEN = chr(36) + "{{"
status = {}
for name, job in jobs.items():
    anc = ancestors(name)
    cond = job.get("if") or "success()"
    cond = cond.strip()
    if cond.startswith(OPEN) and cond.endswith("}}"):
        cond = cond[3:-2].strip()
    atoms = [a.strip() for a in cond.split("&&")]
    if not any(a in ("success()", "failure()", "always()") for a in atoms):
        atoms.insert(0, "success()")
    ok = True
    for atom in atoms:
        if atom == "success()":
            value = all(status[a] == "success" for a in anc)
        elif atom == "failure()":
            value = any(status[a] == "failure" for a in anc)
        elif atom == "always()":
            value = True
        else:
            m = re.fullmatch(r"(\S+) (==|!=) '([^']*)'", atom)
            left = m.group(1)
            if left == "github.ref":
                actual = ref
            else:
                actual = status[left.split(".")[1]]
            value = (actual == m.group(3)) == (m.group(2) == "==")
        ok = ok and value
    if not ok:
        status[name] = "skipped"
        continue
    result = "success"
    for step in job["steps"]:
        if step.get("run") in failing and step.get("continue-on-error") != "true":
            result = "failure"
    status[name] = result
for name in jobs:
    print(name, status[name])
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const key = `${input.grade}/${input.classId}`;
	const spec = SPECS[key];
	if (!spec) throw new Error(`${descriptor.key}: no class ${key}`);
	// Scenarios are drawn until every misconception that the class must expose changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, spec);
		// A failure that only the step may absorb must matter to some dependent job.
		const failingJobs = p.jobs.filter((j) => j.steps.some((s) => p.failing.includes(s.run)));
		if (key === 'intern/continue-step' && !p.jobs.some((j) => failingJobs.some((f) => j.needs.includes(f.id))))
			continue;
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value.join('\n') === answer.join('\n') ? null : value];
			})
		);
		if ((REQUIRED[key] ?? []).some((id) => wrong[id] === null)) continue;
		const yaml = workflowYaml(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'yaml', source: yaml } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ yaml, branch: p.branch, failing: p.failing })
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
	throw new Error(`${descriptor.key}: no scenario for ${key} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
