// What a GitLab CI job finds in its working directory before its script: artifacts of the jobs it depends on (by
// `needs`, `dependencies` or earlier stages, unless expired) and the cache of its key (lock-file hash or a fixed
// key, policies pull / push / pull-push, uploaded only when a job ends). Everything else starts from a clean clone.
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

type Policy = 'pull' | 'push' | 'pull-push';

interface Cache {
	key: { kind: 'lock' } | { kind: 'fixed'; name: string };
	paths: string[];
	policy: Policy;
}

interface Job {
	id: string;
	stage: string;
	script: string;
	creates: string[];
	needs: { job: string; artifacts: boolean }[] | null;
	dependencies: string[] | null;
	artifacts: { paths: string[]; expireMin: number | null } | null;
	cache: Cache | null;
	manual: boolean;
}

interface Pipeline {
	/** What the commit of the pipeline changed. */
	changed: string;
	lock: number;
}

interface Params {
	stages: string[];
	jobs: Job[];
	pipelines: Pipeline[];
	target: string;
	/** Minutes between the end of the earlier stages and the manual start of the target. */
	delayMin: number | null;
}

interface Rules {
	workspacePersists: boolean;
	needsPlusStages: boolean;
	sameStageArtifacts: boolean;
	artifactsFalseIgnored: boolean;
	cacheKeyStatic: boolean;
	pushDownloads: boolean;
	expiryIgnored: boolean;
	cacheInstant: boolean;
}

const RIGHT: Rules = {
	workspacePersists: false,
	needsPlusStages: false,
	sameStageArtifacts: false,
	artifactsFalseIgnored: false,
	cacheKeyStatic: false,
	pushDownloads: false,
	expiryIgnored: false,
	cacheInstant: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'workspace-persists': { workspacePersists: true },
	'needs-plus-stages': { needsPlusStages: true },
	'same-stage-artifacts': { sameStageArtifacts: true },
	'artifacts-false-ignored': { artifactsFalseIgnored: true },
	'cache-key-static': { cacheKeyStatic: true },
	'push-downloads': { pushDownloads: true },
	'expiry-ignored': { expiryIgnored: true },
	'cache-instant': { cacheInstant: true }
};

const pulls = (policy: Policy, rules: Rules): boolean => policy !== 'push' || rules.pushDownloads;
const pushes = (policy: Policy): boolean => policy !== 'pull';

function simulate(p: Params, rules: Rules): string[] {
	const store = new Map<string, string[]>();
	const keyOf = (cache: Cache, pipeline: Pipeline): string =>
		cache.key.kind === 'fixed' ? `fixed:${cache.key.name}` : `lock:${rules.cacheKeyStatic ? 0 : pipeline.lock}`;
	const target = p.jobs.find((j) => j.id === p.target) as Job;
	const stageOf = (j: Job): number => p.stages.indexOf(j.stage);
	let view: string[] = [];
	p.pipelines.forEach((pipeline, n) => {
		const last = n === p.pipelines.length - 1;
		for (const stage of p.stages) {
			const snapshot = new Map(store);
			const uploads: [string, string[]][] = [];
			for (const job of p.jobs.filter((j) => j.stage === stage)) {
				const restored =
					job.cache && pulls(job.cache.policy, rules) ? (snapshot.get(keyOf(job.cache, pipeline)) ?? []) : [];
				if (last && job === target) {
					view = restored;
					continue;
				}
				if (job.cache && pushes(job.cache.policy)) {
					const have = new Set([...job.creates, ...restored]);
					uploads.push([keyOf(job.cache, pipeline), job.cache.paths.filter((x) => have.has(x))]);
				}
			}
			for (const [key, paths] of uploads) store.set(key, paths);
		}
	});
	if (rules.cacheInstant && target.cache && pulls(target.cache.policy, rules)) {
		view = store.get(keyOf(target.cache, p.pipelines[p.pipelines.length - 1] as Pipeline)) ?? [];
	}
	const earlier = p.jobs.filter((j) => stageOf(j) < stageOf(target));
	let sources: Job[];
	if (target.needs !== null) {
		const ids = target.needs.filter((n) => n.artifacts || rules.artifactsFalseIgnored).map((n) => n.job);
		sources = p.jobs.filter((j) => ids.includes(j.id) || (rules.needsPlusStages && earlier.includes(j)));
	} else if (target.dependencies !== null) {
		const ids = target.dependencies;
		sources = p.jobs.filter((j) => ids.includes(j.id));
	} else {
		sources = p.jobs.filter(
			(j) => earlier.includes(j) || (rules.sameStageArtifacts && j !== target && j.stage === target.stage)
		);
	}
	const expired = sources.filter(
		(s) =>
			!rules.expiryIgnored &&
			s.artifacts?.expireMin != null &&
			p.delayMin !== null &&
			p.delayMin > s.artifacts.expireMin
	);
	if (expired.length) return expired.map((s) => `error ${s.id}`).sort();
	const paths = new Set<string>(view);
	for (const s of sources) for (const x of s.artifacts?.paths ?? []) paths.add(x);
	if (rules.workspacePersists) for (const j of earlier) for (const x of j.creates) paths.add(x);
	return paths.size ? [...paths].sort() : ['-'];
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

interface Role {
	names: string[];
	stage: string;
	script: string;
	/** Slots of created paths: one alternative of the first slot always, of the others sometimes. */
	creates: string[][];
}

const ROLES: Record<string, Role> = {
	deps: { names: ['install', 'deps', 'npm-ci'], stage: 'prepare', script: 'npm ci', creates: [['node_modules/']] },
	tools: {
		names: ['tools', 'setup-tools', 'toolchain'],
		stage: 'prepare',
		script: './scripts/fetch-tools.sh',
		creates: [
			['.tools/', 'bin/'],
			['tools.lock', 'versions.txt']
		]
	},
	build: {
		names: ['build', 'compile', 'bundle'],
		stage: 'build',
		script: 'npm run build',
		creates: [
			['dist/', 'build/', 'out/'],
			['build-info.json', 'manifest.json', 'stats.html']
		]
	},
	docs: {
		names: ['docs', 'typedoc', 'docs-site'],
		stage: 'build',
		script: 'npm run docs',
		creates: [['site/', 'docs-dist/'], ['search-index.json']]
	},
	lint: {
		names: ['lint', 'eslint', 'check-style'],
		stage: 'test',
		script: 'npm run lint',
		creates: [['reports/lint.json', 'reports/eslint.xml'], ['.eslintcache']]
	},
	unit: {
		names: ['unit', 'unit-tests', 'jest'],
		stage: 'test',
		script: 'npm test',
		creates: [
			['coverage/', 'coverage-report/'],
			['reports/junit.xml', 'reports/unit.xml']
		]
	},
	e2e: {
		names: ['e2e', 'playwright', 'browser-tests'],
		stage: 'test',
		script: 'npx playwright test',
		creates: [
			['playwright-report/', 'test-results/'],
			['screenshots/', 'reports/e2e.xml']
		]
	},
	sbom: {
		names: ['sbom', 'license-scan'],
		stage: 'test',
		script: 'npm run sbom',
		creates: [['sbom.json', 'sbom.cdx.json'], ['licenses.csv']]
	},
	image: {
		names: ['image', 'docker-build', 'package'],
		stage: 'package',
		script: './scripts/image.sh',
		creates: [['image.tar', 'image.oci/'], ['image-digest.txt']]
	}
};
const TARGETS = [
	{ names: ['deploy', 'release', 'publish', 'pages'], stage: 'deploy', script: './scripts/deploy.sh' },
	{ names: ['report', 'quality-gate', 'summary'], stage: 'test', script: './scripts/summary.sh' }
];
const STAGES = ['prepare', 'build', 'test', 'package', 'deploy'];
const EXPIRE = [
	{ text: '30 minutes', min: 30 },
	{ text: '1 hour', min: 60 },
	{ text: '2 hours', min: 120 },
	{ text: '3 hours', min: 180 }
];
const OTHER_CHANGES = ['src/app.ts', 'src/api/users.ts', 'README.md', 'tests/cart.spec.ts'];

type Mode = 'needs' | 'stages' | 'dependencies' | 'needs-false';

interface ClassSpec {
	mode: Mode | 'any';
	pipelines: 1 | 2;
	cache: number;
	lockChanged: number;
	expiry: boolean;
	targetPolicy: Policy | null;
}

const SPECS: Record<string, ClassSpec> = {
	'junior/needs-only': { mode: 'needs', pipelines: 1, cache: 0.3, lockChanged: 0, expiry: false, targetPolicy: null },
	'junior/stage-default': {
		mode: 'stages',
		pipelines: 1,
		cache: 0.3,
		lockChanged: 0,
		expiry: false,
		targetPolicy: null
	},
	'junior/dependencies': {
		mode: 'dependencies',
		pipelines: 1,
		cache: 0.3,
		lockChanged: 0,
		expiry: false,
		targetPolicy: null
	},
	'junior/needs-artifacts-false': {
		mode: 'needs-false',
		pipelines: 1,
		cache: 0.3,
		lockChanged: 0,
		expiry: false,
		targetPolicy: null
	},
	'middle/cache-key-change': {
		mode: 'any',
		pipelines: 2,
		cache: 1,
		lockChanged: 1,
		expiry: false,
		targetPolicy: 'pull'
	},
	'middle/pull-before-push': {
		mode: 'any',
		pipelines: 1,
		cache: 1,
		lockChanged: 0,
		expiry: false,
		targetPolicy: 'pull'
	},
	'middle/expired': { mode: 'any', pipelines: 2, cache: 0.6, lockChanged: 0.5, expiry: true, targetPolicy: null },
	'middle/push-no-download': {
		mode: 'any',
		pipelines: 2,
		cache: 1,
		lockChanged: 0.3,
		expiry: false,
		targetPolicy: 'push'
	}
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/needs-only': ['needs-plus-stages'],
	'junior/stage-default': ['same-stage-artifacts'],
	'junior/dependencies': ['workspace-persists'],
	'junior/needs-artifacts-false': ['artifacts-false-ignored'],
	'middle/cache-key-change': ['cache-key-static'],
	'middle/pull-before-push': ['cache-instant'],
	'middle/expired': ['expiry-ignored'],
	'middle/push-no-download': ['push-downloads']
};

function scenario(rng: Rng, spec: ClassSpec): Params {
	const roleKeys = rng.sample(Object.keys(ROLES), rng.int(5, 7));
	if (spec.cache === 1 && !roleKeys.includes('deps')) roleKeys.push('deps');
	const t = rng.pick(TARGETS);
	const fixedKey = rng.pick(['tools-v2', '$CI_COMMIT_REF_SLUG', 'build-cache']);
	const jobs: Job[] = roleKeys.map((k) => {
		const role = ROLES[k] as Role;
		const creates = role.creates.filter((_, i) => i === 0 || rng.bool(0.6)).map((slot) => rng.pick(slot));
		const withArtifacts = rng.bool(k === 'deps' ? 0.3 : 0.8);
		const cached = k === 'deps' || k === 'tools' ? rng.bool(spec.cache) : false;
		return {
			id: rng.pick(role.names),
			stage: role.stage,
			script: role.script,
			creates,
			needs: null,
			dependencies: null,
			artifacts: withArtifacts
				? {
						paths: creates.length > 1 && rng.bool(0.5) ? rng.sample(creates, 1) : creates,
						expireMin: spec.expiry && rng.bool(0.7) ? rng.pick(EXPIRE).min : null
					}
				: null,
			cache: cached
				? {
						key: k === 'deps' ? { kind: 'lock' as const } : { kind: 'fixed' as const, name: fixedKey },
						paths: creates,
						policy: rng.pick(['push', 'pull-push'] as const)
					}
				: null,
			manual: false
		};
	});
	const target: Job = {
		id: rng.pick(t.names),
		stage: t.stage,
		script: t.script,
		creates: [],
		needs: null,
		dependencies: null,
		artifacts: null,
		cache: null,
		manual: spec.expiry
	};
	// The target shares the cache of one of the cached jobs: it pulls it, or (with policy push) only refreshes it.
	const cached = jobs.filter((j) => j.cache !== null);
	if (cached.length > 0 && (spec.targetPolicy !== null || rng.bool(0.4))) {
		const source = rng.pick(cached);
		target.cache = { ...(source.cache as Cache), policy: spec.targetPolicy ?? 'pull' };
	}
	// Middle: a cached job sometimes runs in a stage after the target, so its upload comes too late.
	if (spec.pipelines === 2 || spec.targetPolicy !== null) {
		for (const j of cached) if (rng.bool(0.4)) j.stage = rng.pick(['test', 'package', 'deploy']);
	}
	jobs.push(target);
	jobs.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
	const stages = STAGES.filter((s) => jobs.some((j) => j.stage === s));
	const earlier = jobs.filter((j) => stages.indexOf(j.stage) < stages.indexOf(target.stage));
	const mode = spec.mode === 'any' ? rng.pick(['needs', 'stages', 'dependencies'] as const) : spec.mode;
	if ((mode === 'needs' || mode === 'needs-false') && earlier.length > 0) {
		target.needs = rng
			.sample(earlier, rng.int(Math.min(2, earlier.length), Math.min(4, earlier.length)))
			.map((j) => ({ job: j.id, artifacts: mode === 'needs-false' ? rng.bool(0.5) : true }));
	} else if (mode === 'dependencies' && earlier.length > 0) {
		target.dependencies = rng.bool(0.25)
			? []
			: rng.sample(earlier, rng.int(1, Math.min(3, earlier.length))).map((j) => j.id);
	}
	const pipelines: Pipeline[] = [{ changed: rng.pick(OTHER_CHANGES), lock: 1 }];
	if (spec.pipelines === 2) {
		const lockChanged = rng.bool(spec.lockChanged);
		pipelines.push({ changed: lockChanged ? 'package-lock.json' : rng.pick(OTHER_CHANGES), lock: lockChanged ? 2 : 1 });
	}
	return {
		stages,
		jobs,
		pipelines,
		target: target.id,
		delayMin: spec.expiry ? rng.int(1, 7) * 25 + 5 : null
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Text.

function pipelineYaml(p: Params): string {
	const lines = [`stages: [${p.stages.join(', ')}]`, ''];
	for (const job of p.jobs) {
		lines.push(`${job.id}:`, `  stage: ${job.stage}`);
		if (job.manual) lines.push('  when: manual');
		if (job.needs !== null) {
			if (job.needs.every((n) => n.artifacts)) lines.push(`  needs: [${job.needs.map((n) => n.job).join(', ')}]`);
			else {
				lines.push('  needs:');
				for (const n of job.needs) {
					lines.push(`    - job: ${n.job}`);
					if (!n.artifacts) lines.push('      artifacts: false');
				}
			}
		}
		if (job.dependencies !== null) lines.push(`  dependencies: [${job.dependencies.join(', ')}]`);
		lines.push(`  script: ['${job.script}']`);
		if (job.cache) {
			lines.push('  cache:');
			if (job.cache.key.kind === 'lock') lines.push('    key:', '      files: [package-lock.json]');
			else lines.push(`    key: ${job.cache.key.name}`);
			lines.push(`    paths: [${job.cache.paths.join(', ')}]`, `    policy: ${job.cache.policy}`);
		}
		if (job.artifacts) {
			lines.push('  artifacts:', `    paths: [${job.artifacts.paths.join(', ')}]`);
			if (job.artifacts.expireMin !== null)
				lines.push(`    expire_in: ${EXPIRE.find((e) => e.min === job.artifacts?.expireMin)?.text ?? ''}`);
		}
		lines.push('');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	return lines.join('\n');
}

function describe(p: Params, middle: boolean): string {
	const creates = p.jobs
		.filter((j) => j.creates.length > 0)
		.map((j) => `\`${j.id}\` — ${j.creates.map((c) => `\`${c}\``).join(', ')}`)
		.join('; ');
	const runs =
		p.pipelines.length === 1
			? `Конвейер запускается один раз (коммит изменил \`${p.pipelines[0]?.changed}\`); до него кэш пуст.`
			: `Конвейеры запускаются по очереди на одной ветке, второй — после завершения первого; до первого кэш пуст. Коммит первого конвейера изменил \`${p.pipelines[0]?.changed}\`, второго — \`${p.pipelines[1]?.changed}\`.`;
	const delay =
		p.delayMin === null
			? ''
			: ` Задание \`${p.target}\` запустили вручную через ${Math.floor(p.delayMin / 60)} ч ${p.delayMin % 60} мин после того, как завершились все задания предыдущих стадий.`;
	return [
		`Файл \`.gitlab-ci.yml\` ниже. ${runs}${delay} Скрипты заданий создают в рабочем каталоге: ${creates}.`,
		'',
		'Правила GitLab CI:',
		'',
		'- каждое задание начинает с чистой копии репозитория: файлы, созданные другими заданиями, появляются у него, только если пришли артефактами или кэшем;',
		'- артефакты (`artifacts: paths`) задание скачивает: при `needs` — только у перечисленных в нём заданий (у элемента с `artifacts: false` — не скачивает); иначе при `dependencies` — только у перечисленных (`[]` — ни у кого); иначе — у всех заданий предыдущих стадий (не своей);',
		'- кэш с `key: files: [package-lock.json]` имеет ключ из хеша этого файла: изменился файл — новый ключ, кэш под ним сначала пуст; кэш с ключом-строкой у всех конвейеров ветки один;',
		'- `policy: pull` — скачать кэш своего ключа перед скриптом; `push` — не скачивать, а после скрипта загрузить; `pull-push` — и то и другое; загружаются пути `cache: paths`, которые есть в рабочем каталоге после скрипта, и загрузка заменяет прежнее содержимое ключа;',
		'- задания одной стадии стартуют одновременно, следующая стадия — после окончания предыдущей; кэш, загруженный после старта задания, ему не виден' +
			(middle
				? ';\n- `expire_in` — срок хранения артефактов от окончания задания; если хотя бы одни артефакты, которые задание должно скачать, к его старту истекли, задание сразу завершается ошибкой, не выполняя скрипт.'
				: '.'),
		'',
		`Какие из путей, созданных скриптами, будут в рабочем каталоге задания \`${p.target}\`${p.pipelines.length === 2 ? ' во втором конвейере' : ''} перед выполнением его скрипта? Введите их по одному в строке, в любом порядке, как они записаны выше; если таких нет — одна строка \`-\`.` +
			(middle
				? ' Если задание завершится ошибкой из-за истёкших артефактов — по строке `error <задание>` для каждого задания, чьи нужные артефакты истекли.'
				: '') +
			' Например:',
		'',
		'```',
		'dist/',
		'reports/junit.xml',
		'```'
	].join('\n');
}

const PYTHON_REFERENCE = String.raw`${PY_PIPELINE_YAML}
data = json.loads(input())
doc = parse_yaml(data["yaml"])
stages = doc["stages"]
jobs = {k: v for k, v in doc.items() if k != "stages"}
target = data["target"]
creates = data["creates"]
store = {}


def as_list(v):
    if v is None:
        return []
    return [v] if isinstance(v, str) else v


def cache_key(job, pipeline):
    key = job["cache"]["key"]
    if isinstance(key, dict):
        return "files:" + str(pipeline["lock"])
    return "key:" + key


view = []
for n, pipeline in enumerate(data["pipelines"]):
    last = n == len(data["pipelines"]) - 1
    for stage in stages:
        before = dict(store)
        uploads = []
        for name, job in jobs.items():
            if job["stage"] != stage:
                continue
            cache = job.get("cache")
            restored = []
            if cache and cache["policy"] in ("pull", "pull-push"):
                restored = before.get(cache_key(job, pipeline), [])
            if last and name == target:
                view = restored
                continue
            if cache and cache["policy"] in ("push", "pull-push"):
                present = set(creates.get(name, [])) | set(restored)
                uploads.append((cache_key(job, pipeline), [p for p in as_list(cache["paths"]) if p in present]))
        for key, paths in uploads:
            store[key] = paths

job = jobs[target]
earlier = [k for k, v in jobs.items() if stages.index(v["stage"]) < stages.index(job["stage"])]
if "needs" in job:
    sources = []
    for need in as_list(job["needs"]):
        if isinstance(need, str):
            sources.append(need)
        elif need.get("artifacts") != "false":
            sources.append(need["job"])
elif "dependencies" in job:
    sources = as_list(job["dependencies"])
else:
    sources = earlier

UNITS = {"minutes": 1, "hour": 60, "hours": 60}
expired = []
for s in sources:
    art = jobs[s].get("artifacts")
    if art and "expire_in" in art and data["delay"] is not None:
        amount, unit = art["expire_in"].split()
        if data["delay"] > int(amount) * UNITS[unit]:
            expired.append(s)
if expired:
    for s in expired:
        print("error", s)
else:
    seen = set(view)
    for s in sources:
        art = jobs[s].get("artifacts")
        if art:
            seen |= set(as_list(art["paths"]))
    for p in sorted(seen) or ["-"]:
        print(p)
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const key = `${input.grade}/${input.classId}`;
	const spec = SPECS[key];
	if (!spec) throw new Error(`${descriptor.key}: no class ${key}`);
	// Scenarios are drawn until every misconception that the class must expose changes the answer.
	for (let tries = 0; tries < 800; tries += 1) {
		const p = scenario(rng, spec);
		// Job names are unique.
		if (new Set(p.jobs.map((j) => j.id)).size !== p.jobs.length) continue;
		const answer = simulate(p, RIGHT);
		// An empty answer is kept rarely: it would repeat across instances.
		if (answer.length === 1 && answer[0] === '-' && rng.bool(0.85)) continue;
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
				stdin: JSON.stringify({
					yaml,
					target: p.target,
					creates: Object.fromEntries(p.jobs.map((j) => [j.id, j.creates])),
					pipelines: p.pipelines,
					delay: p.delayMin
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
	throw new Error(`${descriptor.key}: no scenario for ${key} after 800 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
