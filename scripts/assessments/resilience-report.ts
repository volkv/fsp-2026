// The report of the resilience of the released Backend bank (`resilience.ts`): four attacks of the spread of answers and
// the matrix «профиль × грейд × форма». Every attempt goes along the engine's path on the released content (its hash is
// the key of `assessments/trajectories/backend.json`), every seed is fixed, so the same content gives the same report;
// the assistant's replies are kept in `b3-assistant.json`, and a run without `--assistant` checks the kept replies again
// instead of asking.
//
//   node scripts/assessments/resilience-report.ts [--runs <n>] [--practice-runs <n>] [--local-python]
//                                                 [--assistant] [--assistant-attempts <n>] [--call-budget <n>]
//
// `--assistant` asks the model for the clusters the kept replies lack (OpenAI-compatible API: `LLM_BASE_URL`,
// `LLM_API_KEY`, `LLM_MODEL`), at most `--call-budget` requests over the kept ones. Programs run in the Python of the
// sandbox image (`--local-python` — of this machine). Writes `assessments/trajectories/b3-report.json` and `.md`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import type { ItemInstance } from '../../src/lib/server/assessments/contract/bank.ts';
import {
	blockDefinition,
	CATALOG,
	gradeDefinition,
	type GradeKey,
	type SpecializationKey
} from '../../src/lib/server/assessments/contract/catalog.ts';
import { PROCEDURE, maxLength, type DecisionOutcome } from '../../src/lib/server/assessments/contract/procedure.ts';
import {
	sha256Hex,
	loadSpecializationFamilies,
	sharedCodeSha256,
	type LoadedFamily
} from '../../src/lib/server/assessments/families.ts';
import { releaseContentSha256 } from '../../src/lib/server/assessments/release.ts';
import { answerMatches } from '../../src/lib/server/assessments/score.ts';
import { labelRandom } from '../../src/lib/server/assessments/simulate.ts';
import type { AttemptForm } from '../../src/lib/server/assessments/select.ts';
import type { ReferenceProbe } from '../../assessments/families/_lib/family.ts';
import {
	honestScorer,
	otherInstance,
	pastedScore,
	playAttempt,
	practiceRun,
	profileShift,
	PythonRunner,
	replyAnswer,
	replyProgram,
	solverPrompt,
	stepPrompt,
	tally,
	wilson,
	type AsyncScorer,
	type PlayedAttempt,
	type Profile,
	type ServedCluster,
	type Tally
} from './resilience.ts';
import { loadTree } from './tree.ts';

const SPECIALIZATION: SpecializationKey = 'backend';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BANK_TREE = join(ROOT, 'assessments/families');
const OUT_DIR = join(ROOT, 'assessments/trajectories');
const REPORT_JSON = join(OUT_DIR, 'b3-report.json');
const REPORT_MD = join(OUT_DIR, 'b3-report.md');
const ASSISTANT_FILE = join(OUT_DIR, 'b3-assistant.json');
const GRADES = ['junior', 'middle', 'senior'] as const satisfies readonly GradeKey[];
const ATTACKER_SHIFTS = [-0.15, -0.3] as const;
const DONOR_SHIFT = 0.15;
const STRATEGY_GAINS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3] as const;
const ASSISTANT_GRADES = ['junior', 'middle'] as const satisfies readonly GradeKey[];

/**
 * Profiles of the matrix: the shift of the true chance from the cut of an item by the grade of the item, and by block.
 * A typical Junior is above the cut of Junior items by 0.15 and below the cut of Middle items by 0.15; and so on.
 */
const PROFILES: readonly Profile[] = [
	{
		key: 'junior',
		title: 'типичный Junior',
		byGrade: { intern: 0.25, junior: 0.15, middle: -0.15, senior: -0.35 },
		byBlock: { 'be.concurrency': -0.1, 'be.design': -0.1 }
	},
	{
		key: 'middle',
		title: 'типичный Middle',
		byGrade: { intern: 0.3, junior: 0.25, middle: 0.15, senior: -0.15 },
		byBlock: { 'be.design': -0.05 }
	},
	{
		key: 'senior',
		title: 'типичный Senior',
		byGrade: { intern: 0.3, junior: 0.3, middle: 0.25, senior: 0.15 },
		byBlock: {}
	}
];

const { values: args } = parseArgs({
	options: {
		runs: { type: 'string', default: '4000' },
		'practice-runs': { type: 'string', default: '1000' },
		'local-python': { type: 'boolean', default: false },
		assistant: { type: 'boolean', default: false },
		'assistant-attempts': { type: 'string', default: '8' },
		'call-budget': { type: 'string', default: '290' }
	}
});
const positive = (name: string, value: string | undefined): number => {
	const n = Number.parseInt(value ?? '', 10);
	if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got ${String(value)}`);
	return n;
};
const RUNS = positive('runs', args.runs);
const PRACTICE_RUNS = positive('practice-runs', args['practice-runs']);
const ASSISTANT_ATTEMPTS = positive('assistant-attempts', args['assistant-attempts']);
const CALL_BUDGET = positive('call-budget', args['call-budget']);

const round = (x: number, digits = 4): number => Math.round(x * 10 ** digits) / 10 ** digits;
const roundTally = (t: Tally) => ({
	runs: t.runs,
	confirmed: round(t.confirmed),
	confirmedCi95: wilson(t.confirmed, t.runs).map((x) => round(x)),
	undetermined: round(t.undetermined),
	notConfirmed: round(t.notConfirmed)
});
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

// ---------------------------------------------------------------------------------------------------------------
// The released bank.

const families = await loadSpecializationFamilies(BANK_TREE, SPECIALIZATION);
const sharedSha256 = await sharedCodeSha256(BANK_TREE, SPECIALIZATION);
const contentSha256 = releaseContentSha256(
	families.map((f) => ({ descriptor: f.descriptor, generatorSha256: f.generatorSha256 })),
	sharedSha256
);
const released = JSON.parse(readFileSync(join(OUT_DIR, `${SPECIALIZATION}.json`), 'utf8')) as {
	key: { contentSha256: string };
	report: { releaseId: string; grades: { grade: GradeKey; points: { shift: number; confirmed: number }[] }[] };
};
if (released.key.contentSha256 !== contentSha256)
	throw new Error(`the tree is not the content of ${released.report.releaseId}: run \`pnpm bank:check\` first`);
const releaseId = released.report.releaseId;
const SEED = `b3:${contentSha256}`;
const byKey = new Map(families.map((f) => [f.descriptor.key, f]));
const familyOf = (key: string): LoadedFamily => {
	const family = byKey.get(key);
	if (!family) throw new Error(`no family ${key}`);
	return family;
};

const tree = new Map(
	loadTree()
		.families.filter((f) => f.specialization === SPECIALIZATION && !f.probe)
		.map((f) => [f.key, f])
);
/** The reference program of a practice instance (the gate material of its generator). */
async function practiceReference(instance: ItemInstance): Promise<Extract<ReferenceProbe, { kind: 'practice' }>> {
	const family = tree.get(instance.family);
	if (!family) throw new Error(`no generator of ${instance.family}`);
	const factory = await family.module();
	const probe = factory.build({ seed: instance.seed, grade: instance.grade, classId: instance.classId }).reference();
	if (probe.kind !== 'practice') throw new Error(`${instance.family}: the reference is not a program`);
	return probe;
}

const runner = new PythonRunner(args['local-python']);
const practiceCache = new Map<string, Promise<number>>();
/** The score of a practice instance with the reference program of another instance, run once per pair. */
function transferredPractice(own: ItemInstance, donor: ItemInstance): Promise<number> {
	const key = `${own.family}|${own.grade}|${own.seed}|${donor.classId}|${donor.seed}`;
	let result = practiceCache.get(key);
	if (!result) {
		result = practiceReference(donor).then(
			async (reference) => (await practiceRun(runner, own, reference.source, reference.changeSource)).score
		);
		practiceCache.set(key, result);
	}
	return result;
}

const attempt = (grade: GradeKey, form: AttemptForm, attemptSeed: string, seen: ReadonlySet<string> = new Set()) => ({
	families,
	specialization: SPECIALIZATION,
	grade,
	form,
	seen,
	attemptSeed
});

const gateOf = (grade: GradeKey): number => gradeDefinition(SPECIALIZATION, grade).practice.gateMinScore;

// ---------------------------------------------------------------------------------------------------------------
// Attacks 1 and 2: the answers and the program of another instance pasted as one's own.

type Leak = 'answers' | 'practice' | 'both';
type Source = 'donor' | 'class';

interface TransferStats {
	outcomes: DecisionOutcome[];
	computed: number;
	leaked: number;
	pastedRight: number;
	practice: number;
	practiceLeaked: number;
	practiceGate: number;
	practiceScores: number[];
}

const emptyStats = (): TransferStats => ({
	outcomes: [],
	computed: 0,
	leaked: 0,
	pastedRight: 0,
	practice: 0,
	practiceLeaked: 0,
	practiceGate: 0,
	practiceScores: []
});

/**
 * The scorer of an attacker who pastes what leaked: the answers of computed clusters, the program of the practice, or
 * both; everything else is answered honestly with the attacker's own shift. `donor` — another candidate's attempt of the
 * same grade and form: only the families it served leaked, with the donor's own answers (a wrong one stays wrong), its
 * practice as the reference program. `class` — a collection of solved instances: every family the attacker meets
 * leaked in the same class with another seed, answered by its key.
 */
function attackScorer(
	leak: Leak,
	source: Source,
	donor: ReadonlyMap<string, ServedCluster>,
	honest: AsyncScorer,
	stats: TransferStats,
	grade: GradeKey
): AsyncScorer {
	return (cluster) => {
		const { instance, family } = cluster;
		const practice = instance.practice !== null;
		const pastes = leak === 'both' || (leak === 'answers' ? !practice : practice);
		const leaked = !pastes
			? undefined
			: source === 'class'
				? otherInstance(familyOf(family.key), instance, 'class')
				: donor.get(family.key)?.instance;
		const donorScore = source === 'donor' ? donor.get(family.key)?.score : undefined;
		if (!practice) {
			stats.computed += 1;
			if (!leaked) return honest(cluster);
			stats.leaked += 1;
			const score = source === 'donor' && donorScore !== 1 ? 0 : pastedScore(instance, leaked);
			stats.pastedRight += score;
			return score;
		}
		stats.practice += 1;
		const record = (score: number): number => {
			stats.practiceScores.push(score);
			if (score >= gateOf(grade)) stats.practiceGate += 1;
			return score;
		};
		if (!leaked) {
			const score = honest(cluster);
			return typeof score === 'number' ? record(score) : score.then(record);
		}
		stats.practiceLeaked += 1;
		return transferredPractice(instance, leaked).then(record);
	};
}

interface TransferRow {
	grade: GradeKey;
	attackerShift: number;
	leak: Leak | 'none';
	source: Source | null;
	outcome: ReturnType<typeof roundTally>;
	computedLeakedShare: number | null;
	pastedRightShare: number | null;
	practiceLeakedShare: number | null;
	practiceGatePassed: number | null;
	practiceMeanScore: number | null;
}

const transferRows: TransferRow[] = [];
const CONDITIONS: { leak: Leak | 'none'; source: Source | null }[] = [
	{ leak: 'none', source: null },
	{ leak: 'answers', source: 'donor' },
	{ leak: 'answers', source: 'class' },
	{ leak: 'practice', source: 'donor' },
	{ leak: 'practice', source: 'class' },
	{ leak: 'both', source: 'donor' },
	{ leak: 'both', source: 'class' }
];
for (const grade of GRADES) {
	for (const shift of ATTACKER_SHIFTS) {
		for (const condition of CONDITIONS) {
			const runs = condition.leak === 'none' || condition.leak === 'answers' ? RUNS : PRACTICE_RUNS;
			const stats = emptyStats();
			for (let run = 0; run < runs; run += 1) {
				const label = `${SEED}:transfer:${grade}:${run}`;
				const honest = honestScorer(`${label}:attacker:${shift}`, () => shift);
				const own = attempt(grade, 'A', `${label}:attacker`);
				let played: PlayedAttempt;
				if (condition.leak === 'none' || condition.source === null) {
					played = await playAttempt(own, honest);
				} else {
					const donorAttempt = await playAttempt(
						attempt(grade, 'A', `${label}:donor`),
						honestScorer(`${label}:donor`, () => DONOR_SHIFT)
					);
					const donor = new Map(donorAttempt.clusters.map((c) => [c.family.key, c]));
					played = await playAttempt(own, attackScorer(condition.leak, condition.source, donor, honest, stats, grade));
				}
				stats.outcomes.push(played.decision.outcome);
			}
			const leaks = condition.leak !== 'none';
			transferRows.push({
				grade,
				attackerShift: shift,
				leak: condition.leak,
				source: condition.source,
				outcome: roundTally(tally(stats.outcomes)),
				computedLeakedShare:
					leaks && condition.leak !== 'practice' && stats.computed > 0 ? round(stats.leaked / stats.computed) : null,
				pastedRightShare:
					leaks && condition.leak !== 'practice' && stats.leaked > 0 ? round(stats.pastedRight / stats.leaked) : null,
				practiceLeakedShare:
					leaks && condition.leak !== 'answers' && stats.practice > 0
						? round(stats.practiceLeaked / stats.practice)
						: null,
				practiceGatePassed: leaks && stats.practice > 0 ? round(stats.practiceGate / stats.practice) : null,
				practiceMeanScore: leaks && stats.practice > 0 ? round(mean(stats.practiceScores)) : null
			});
			console.log(
				`transfer ${grade} ${shift} ${condition.leak}/${condition.source ?? '-'}: confirmed ${round(tally(stats.outcomes).confirmed, 3)}`
			);
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Attack 3: the strategy of every family known — a gain of the chance on every cluster, a parameter of the model.

const strategyRows: { grade: GradeKey; attackerShift: number; gain: number; outcome: ReturnType<typeof roundTally> }[] =
	[];
for (const grade of GRADES) {
	for (const shift of ATTACKER_SHIFTS) {
		for (const gain of STRATEGY_GAINS) {
			const outcomes: DecisionOutcome[] = [];
			for (let run = 0; run < RUNS; run += 1) {
				const label = `${SEED}:strategy:${grade}:${run}`;
				const played = await playAttempt(
					attempt(grade, 'A', `${label}:attacker`),
					honestScorer(`${label}:attacker:${shift}`, () => shift + gain)
				);
				outcomes.push(played.decision.outcome);
			}
			strategyRows.push({ grade, attackerShift: shift, gain, outcome: roundTally(tally(outcomes)) });
		}
	}
}
console.log('strategy done');

// ---------------------------------------------------------------------------------------------------------------
// Matrix «профиль × грейд × форма» and the retake.

interface MatrixCell {
	profile: string;
	grade: GradeKey;
	formA: ReturnType<typeof roundTally>;
	formB: ReturnType<typeof roundTally>;
	/** The share of runs whose retake on B (after A, its classes seen) has the outcome of A. */
	retakeAgreement: number;
}
const matrix: MatrixCell[] = [];
const ladder: {
	profile: string;
	assignedA: Record<string, number>;
	assignedRetakeB: Record<string, number>;
	agreement: number;
}[] = [];
const assigned = (outcomes: Partial<Record<GradeKey, DecisionOutcome>>): string =>
	[...GRADES].reverse().find((g) => outcomes[g] === 'confirmed') ?? 'none';
for (const profile of PROFILES) {
	const shift = profileShift(profile);
	const perRun: { a: Partial<Record<GradeKey, DecisionOutcome>>; b: Partial<Record<GradeKey, DecisionOutcome>> }[] =
		Array.from({ length: RUNS }, () => ({ a: {}, b: {} }));
	for (const grade of GRADES) {
		const fresh: Record<AttemptForm, DecisionOutcome[]> = { A: [], B: [] };
		let agree = 0;
		for (let run = 0; run < RUNS; run += 1) {
			const label = `${SEED}:matrix:${profile.key}:${grade}:${run}`;
			const a = await playAttempt(attempt(grade, 'A', `${label}:A`), honestScorer(`${label}:A`, shift));
			const b = await playAttempt(attempt(grade, 'B', `${label}:B`), honestScorer(`${label}:B`, shift));
			const retake = await playAttempt(
				attempt(grade, 'B', `${label}:retake`, new Set(a.served)),
				honestScorer(`${label}:retake`, shift)
			);
			fresh.A.push(a.decision.outcome);
			fresh.B.push(b.decision.outcome);
			if (retake.decision.outcome === a.decision.outcome) agree += 1;
			const row = perRun[run];
			if (!row) throw new Error(`no run ${run}`);
			row.a[grade] = a.decision.outcome;
			row.b[grade] = retake.decision.outcome;
		}
		matrix.push({
			profile: profile.key,
			grade,
			formA: roundTally(tally(fresh.A)),
			formB: roundTally(tally(fresh.B)),
			retakeAgreement: round(agree / RUNS)
		});
	}
	const count = (pick: (r: (typeof perRun)[number]) => string) => {
		const shares: Record<string, number> = {};
		for (const key of ['none', ...GRADES]) shares[key] = round(perRun.filter((r) => pick(r) === key).length / RUNS);
		return shares;
	};
	ladder.push({
		profile: profile.key,
		assignedA: count((r) => assigned(r.a)),
		assignedRetakeB: count((r) => assigned(r.b)),
		agreement: round(perRun.filter((r) => assigned(r.a) === assigned(r.b)).length / RUNS)
	});
}
console.log('matrix done');

// ---------------------------------------------------------------------------------------------------------------
// Attack 4: an assistant solves the instances as the candidate sees them; the engine checks its replies.

interface KeptReply {
	key: string;
	family: string;
	grade: GradeKey;
	classId: string;
	seed: string;
	stage: 'answer' | 'program' | 'step';
	model: string;
	reply: string;
}
interface KeptReplies {
	model: string;
	calls: number;
	replies: KeptReply[];
}
/** The model `--assistant` asks: `LLM_MODEL`, Claude Opus through the gateway by default. */
const assistantModel = process.env.LLM_MODEL ?? 'claude-opus:latest';
const kept: KeptReplies = existsSync(ASSISTANT_FILE)
	? (JSON.parse(readFileSync(ASSISTANT_FILE, 'utf8')) as KeptReplies)
	: { model: assistantModel, calls: 0, replies: [] };
const keptByKey = new Map(kept.replies.map((r) => [r.key, r]));
let newCalls = 0;

let keeping: Promise<void> = Promise.resolve();
/** The kept replies on disk after every new one, sorted by key; writes go one after another. */
function keepReplies(): Promise<void> {
	keeping = keeping.then(() =>
		writeFormatted(
			ASSISTANT_FILE,
			JSON.stringify({ ...kept, replies: [...kept.replies].sort((a, b) => (a.key < b.key ? -1 : 1)) })
		)
	);
	return keeping;
}

async function ask(instance: ItemInstance, stage: KeptReply['stage'], prompt: string): Promise<string> {
	const key = `${instance.family}|${instance.grade}|${instance.classId}|${instance.seed}|${stage}`;
	const known = keptByKey.get(key);
	if (known) return known.reply;
	if (!args.assistant) throw new Error(`no kept reply for ${key}: run with --assistant`);
	if (newCalls >= CALL_BUDGET) throw new Error(`the call budget of ${CALL_BUDGET} is spent`);
	// The report measures one model: replies of another one are not added to the kept ones.
	if (kept.model !== assistantModel) {
		throw new Error(
			`the kept replies are of ${kept.model}, LLM_MODEL asks ${assistantModel}: remove ${ASSISTANT_FILE} to measure ${assistantModel} anew`
		);
	}
	const baseUrl = process.env.LLM_BASE_URL;
	if (!baseUrl) throw new Error('LLM_BASE_URL is not set');
	newCalls += 1;
	kept.calls += 1;
	const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {})
		},
		body: JSON.stringify({ model: kept.model, messages: [{ role: 'user', content: prompt }] }),
		signal: AbortSignal.timeout(300_000)
	});
	if (!response.ok)
		throw new Error(`the assistant answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
	const body = (await response.json()) as { model?: string; choices?: { message?: { content?: string } }[] };
	const reply = body.choices?.[0]?.message?.content;
	if (typeof reply !== 'string')
		throw new Error(`the assistant's reply has no content: ${JSON.stringify(body).slice(0, 300)}`);
	const entry: KeptReply = {
		key,
		family: instance.family,
		grade: instance.grade,
		classId: instance.classId,
		seed: instance.seed,
		stage,
		model: body.model ?? kept.model,
		reply
	};
	kept.replies.push(entry);
	keptByKey.set(key, entry);
	await keepReplies();
	return reply;
}

interface AssistantCluster {
	attempt: number;
	seq: number;
	block: string;
	family: string;
	practice: boolean;
	score: number;
	unparsed: boolean;
	groups?: { task: string; step: string | null };
}
const assistantScorer =
	(attemptIndex: number, log: AssistantCluster[]): AsyncScorer =>
	async ({ instance, family, seq }) => {
		const base = { attempt: attemptIndex, seq, block: family.block, family: family.key };
		if (!instance.practice) {
			if (!instance.answer) throw new Error(`${instance.family}: no computed answer`);
			const typed = replyAnswer(await ask(instance, 'answer', solverPrompt(instance)));
			const score = typed !== null && answerMatches(instance.answer, typed) ? 1 : 0;
			log.push({ ...base, practice: false, score, unparsed: typed === null });
			return score;
		}
		const program = replyProgram(await ask(instance, 'program', solverPrompt(instance)));
		const changed = instance.changeStep
			? replyProgram(await ask(instance, 'step', stepPrompt(instance, program)))
			: null;
		const run = program === null ? null : await practiceRun(runner, instance, program, changed);
		const score = run?.score ?? 0;
		log.push({
			...base,
			practice: true,
			score,
			unparsed: program === null || (instance.changeStep !== null && changed === null),
			groups: run
				? {
						task: `${run.taskGroups.passed}/${run.taskGroups.total}`,
						step: run.stepGroups ? `${run.stepGroups.passed}/${run.stepGroups.total}` : null
					}
				: undefined
		});
		return score;
	};

/** Attempts asked at once: each is a chain of requests, the attempts are independent. */
const ASSISTANT_CONCURRENCY = 4;

const assistantRows: {
	grade: GradeKey;
	attempts: number;
	outcome: ReturnType<typeof roundTally>;
	byBlock: { block: string; title: string; clusters: number; right: number; share: number }[];
	clusters: { inAttempts: number; rightInAttempts: number; inSample: number };
	practice: { clusters: number; meanScore: number; gatePassed: number | null; groups: AssistantCluster['groups'][] };
	unparsed: number;
	extrapolated: ReturnType<typeof roundTally>;
	attemptsDetail: { outcome: DecisionOutcome; reason: string; items: number; scoreSum: number; cutSum: number }[];
}[] = [];
for (const grade of ASSISTANT_GRADES) {
	const log: AssistantCluster[] = [];
	const played: PlayedAttempt[] = [];
	const perAttempt = maxLength(PROCEDURE, grade) + 1;
	for (let start = 0; start < ASSISTANT_ATTEMPTS;) {
		let size = Math.min(ASSISTANT_CONCURRENCY, ASSISTANT_ATTEMPTS - start);
		if (args.assistant) size = Math.min(size, Math.floor((CALL_BUDGET - newCalls) / perAttempt));
		if (size === 0) {
			console.log(`assistant ${grade}: the budget left covers no further attempt; ${played.length} made`);
			break;
		}
		const batch = await Promise.all(
			Array.from({ length: size }, (_, k) =>
				playAttempt(attempt(grade, 'A', `${SEED}:assistant:${grade}:${start + k}`), assistantScorer(start + k, log))
			)
		);
		played.push(...batch);
		for (const [k, p] of batch.entries())
			console.log(`assistant ${grade} attempt ${start + k + 1}: ${p.decision.outcome} (${p.decision.reason})`);
		start += size;
	}
	if (played.length === 0) throw new Error(`no assistant attempt at ${grade}`);
	// The sample: attempts that confirm early never reach some blocks, so every computed family-level of the grade
	// is asked once more in its classes A and B, on seeds of the sample.
	const sample = families.flatMap((family) => {
		const level = family.descriptor.levels.find((l) => l.grade === grade);
		if (!level || family.descriptor.practice) return [];
		return level.classes
			.filter((c) => c.form === 'A' || c.form === 'B')
			.map((c) =>
				family.module.generate({
					seed: sha256Hex(`${SEED}:assistant-sample:${family.descriptor.key}:${grade}:${c.id}`),
					grade,
					classId: c.id
				})
			);
	});
	if (args.assistant && sample.length > CALL_BUDGET - newCalls)
		throw new Error(`the sample of ${grade} needs ${sample.length} requests, the budget has ${CALL_BUDGET - newCalls}`);
	for (let start = 0; start < sample.length; start += ASSISTANT_CONCURRENCY)
		await Promise.all(
			sample
				.slice(start, start + ASSISTANT_CONCURRENCY)
				.map(
					async (instance, k) =>
						await assistantScorer(
							-1,
							log
						)({ seq: start + k + 1, instance, family: familyOf(instance.family).descriptor, angoff: 0 })
				)
		);
	log.sort((a, b) => a.attempt - b.attempt || a.seq - b.seq);
	const computed = log.filter((c) => !c.practice);
	const blocks = [...new Set(computed.map((c) => c.block))].sort();
	const byBlock = blocks.map((block) => {
		const of = computed.filter((c) => c.block === block);
		const right = of.filter((c) => c.score === 1).length;
		return { block, title: blockDefinition(block).title, clusters: of.length, right, share: round(right / of.length) };
	});
	const practice = log.filter((c) => c.practice);
	const fromAttempts = computed.filter((c) => c.attempt >= 0);
	// The extrapolation: attempts of the same engine with the measured share of every block as the chance of a
	// computed cluster, and a practice score drawn from the measured ones.
	const shareOf = new Map(byBlock.map((b) => [b.block, b.right / b.clusters]));
	const extrapolated: DecisionOutcome[] = [];
	for (let run = 0; run < RUNS; run += 1) {
		const label = `${SEED}:assistant-model:${grade}:${run}`;
		const p = await playAttempt(attempt(grade, 'A', `${label}:attempt`), ({ instance, family, seq }) => {
			const random = labelRandom(`${label}:${seq}`);
			if (instance.practice) {
				const pick = practice[Math.floor(random() * practice.length)];
				if (!pick) throw new Error(`no measured practice at ${grade}`);
				return pick.score;
			}
			const share = shareOf.get(family.block);
			if (share === undefined) throw new Error(`no measured cluster of ${family.block} at ${grade}`);
			return random() < share ? 1 : 0;
		});
		extrapolated.push(p.decision.outcome);
	}
	assistantRows.push({
		grade,
		attempts: played.length,
		outcome: roundTally(tally(played.map((p) => p.decision.outcome))),
		byBlock,
		clusters: {
			inAttempts: fromAttempts.length,
			rightInAttempts: fromAttempts.filter((c) => c.score === 1).length,
			inSample: computed.length - fromAttempts.length
		},
		practice: {
			clusters: practice.length,
			meanScore: round(mean(practice.map((c) => c.score))),
			gatePassed:
				practice.length === 0 ? null : round(practice.filter((c) => c.score >= gateOf(grade)).length / practice.length),
			groups: practice.map((c) => c.groups)
		},
		unparsed: log.filter((c) => c.unparsed).length,
		extrapolated: roundTally(tally(extrapolated)),
		attemptsDetail: played.map((p) => ({
			outcome: p.decision.outcome,
			reason: p.decision.reason,
			items: p.decision.items,
			scoreSum: p.decision.scoreSum / 20,
			cutSum: p.decision.cutSum / 20
		}))
	});
}
runner.close();

// ---------------------------------------------------------------------------------------------------------------
// The report.

const baselineOfReport = Object.fromEntries(
	released.report.grades
		.filter((g) => (GRADES as readonly string[]).includes(g.grade))
		.map((g) => [g.grade, g.points.find((p) => p.shift === -0.15)?.confirmed ?? null])
);
const assistantModels = [...new Set(kept.replies.map((r) => r.model))];
const report = {
	releaseId,
	contentSha256,
	catalogVersion: CATALOG.version,
	procedureVersion: PROCEDURE.version,
	seed: SEED,
	runtime: runner.runtime,
	model: {
		honest: `доля верного на вычисляемом задании — оценка Angoff + сдвиг (обрезка 0,02–0,98); практика — общая латентная доля Beta, ρ = ${PROCEDURE.trajectoryAcceptance.model.rho}`,
		attackerShifts: ATTACKER_SHIFTS,
		donorShift: DONOR_SHIFT,
		strategyGains: STRATEGY_GAINS,
		profiles: PROFILES
	},
	baselineOfTrajectoryReport: baselineOfReport,
	transfer: transferRows,
	strategy: strategyRows,
	matrix,
	ladder,
	assistant: {
		models: assistantModels,
		requestedModel: kept.model,
		callsKept: kept.replies.length,
		callsMade: kept.calls,
		grades: assistantRows
	}
};
await writeFormatted(REPORT_JSON, JSON.stringify(report));
await writeFormatted(REPORT_MD, markdown());
console.log(`wrote ${REPORT_JSON} and ${REPORT_MD}; assistant calls kept ${kept.replies.length}, made now ${newCalls}`);

async function writeFormatted(path: string, text: string): Promise<void> {
	const config = (await resolveConfig(path)) ?? {};
	writeFileSync(path, await format(text, { ...config, filepath: path }));
}

function markdown(): string {
	const n = (x: number | null, digits = 3): string =>
		x === null ? '—' : round(x, digits).toFixed(digits).replace('.', ',');
	const ci = (t: ReturnType<typeof roundTally>) =>
		`${n(t.confirmed)} [${n(t.confirmedCi95[0] ?? 0)}–${n(t.confirmedCi95[1] ?? 0)}]`;
	const leakTitle: Record<string, string> = {
		none: 'без утечки',
		'answers/donor': 'ответы чужой попытки',
		'answers/class': 'ответы того же класса',
		'practice/donor': 'программа практики чужой попытки',
		'practice/class': 'программа практики того же класса',
		'both/donor': 'всё из чужой попытки',
		'both/class': 'всё того же класса'
	};
	const lines: string[] = [];
	lines.push(
		`# Устойчивость выпуска ${releaseId} к распространению ответов`,
		'',
		`Отчёт \`scripts/assessments/resilience-report.ts\`: содержимое \`${contentSha256.slice(0, 12)}…\` (ключ \`backend.json\`), процедура \`${PROCEDURE.version}\`, справочник \`${CATALOG.version}\`, зерно \`b3:<хэш содержимого>\`. Попытки идут через движок теста: выбор семейств и классов, генераторы, проверка ответов, ворота практики и процедура; программы практики исполняются на скрытых тестах экземпляра (${runner.runtime}). Числа — доля подтверждённых грейдов с 95 % интервалом Уилсона; прогонов — ${RUNS} на точку, с исполнением практики — ${PRACTICE_RUNS}.`,
		'',
		'**Это симуляция с названными предположениями, а не данные людей**: честная часть ответов — модель отчёта траекторий (доля верного = оценка Angoff + сдвиг), атакующий — кандидат на 0,15 или 0,30 ниже порога.',
		'',
		'## 1–2. Перенос ответов и программы практики',
		'',
		`Атакующий вставляет как свои ответы и программу другого экземпляра. «Чужая попытка» — попытка другого кандидата того же грейда и формы (кандидат на ${n(DONOR_SHIFT, 2)} выше порога; его неверные ответы остаются неверными, практика — эталонная программа). «Тот же класс» — собранная база: на каждое семейство атакующего есть решённый экземпляр того же класса с другим сидом и верным ответом. Остальное атакующий решает сам.`,
		'',
		'| Грейд | Сдвиг | Что перенесено | Подтверждено [95 %] | Покрыто утечкой: задания / практика | Вставленный ответ верен | Практика: ворота пройдены |',
		'|---|---|---|---|---|---|---|'
	);
	for (const r of transferRows)
		lines.push(
			`| ${r.grade} | ${n(r.attackerShift, 2)} | ${leakTitle[r.source ? `${r.leak}/${r.source}` : r.leak] ?? r.leak} | ${ci(r.outcome)} | ${n(r.computedLeakedShare)} / ${n(r.practiceLeakedShare)} | ${n(r.pastedRightShare)} | ${n(r.practiceGatePassed)} |`
		);
	lines.push(
		'',
		`Базовая доля ложных подтверждений в отчёте траекторий на −0,15: ${GRADES.map((g) => `${g} ${n(baselineOfReport[g] ?? null)}`).join(', ')}.`,
		'',
		'## 3. Перенос стратегии',
		'',
		'Атакующий знает классы и «как решать» каждое семейство. **Модель**: знание добавляет к доле верного на каждом задании и в практике прибавку δ (параметр); людей мы не измеряли.',
		'',
		`| Грейд | Сдвиг | ${STRATEGY_GAINS.map((g) => `δ = ${n(g, 2)}`).join(' | ')} |`,
		`|---|---|${STRATEGY_GAINS.map(() => '---').join('|')}|`
	);
	for (const grade of GRADES)
		for (const shift of ATTACKER_SHIFTS)
			lines.push(
				`| ${grade} | ${n(shift, 2)} | ${STRATEGY_GAINS.map((gain) => n(strategyRows.find((r) => r.grade === grade && r.attackerShift === shift && r.gain === gain)?.outcome.confirmed ?? null)).join(' | ')} |`
			);
	lines.push(
		'',
		'## 4. Ассистент',
		'',
		`Модель \`${kept.model}\` (ответила как ${assistantModels.map((m) => `\`${m}\``).join(', ')}) получает условие, как его видит кандидат (текст, код, подпись поля ответа; практика — на Python 3, шаг «измени своё решение» — вторым запросом), ответ проверяет движок, программа исполняется на скрытых тестах. Запросов — ${kept.replies.length}; ответы сохранены в \`b3-assistant.json\`, повторный прогон перепроверяет их без запросов. Попытки, подтвердившиеся рано, не доходят до части блоков, поэтому сверх попыток каждое вычисляемое семейство-уровень грейда спрошено ещё раз в классах A и B (выборка); доли по блокам — по попыткам и выборке вместе. Это измерение одной модели на ${assistantRows.map((r) => `${r.attempts} попытках ${r.grade}`).join(' и ')}, а не защита от ассистентов.`,
		''
	);
	for (const r of assistantRows) {
		lines.push(
			`**${r.grade}**: подтверждено ${Math.round(r.outcome.confirmed * r.outcome.runs)} из ${r.outcome.runs} попыток; в попытках верно ${r.clusters.rightInAttempts} из ${r.clusters.inAttempts} вычисляемых заданий, в выборке — ${r.clusters.inSample} заданий; экстраполяция по долям блоков (${RUNS} попыток той же процедуры) — ${ci(r.extrapolated)}. Практика: средний балл ${n(r.practice.meanScore)}, ворота пройдены в ${n(r.practice.gatePassed)} (${r.practice.clusters} кластеров). Без разбираемого ответа — ${r.unparsed}.`,
			'',
			'| Блок | Заданий | Верно | Доля |',
			'|---|---|---|---|',
			...r.byBlock.map((b) => `| ${b.title} | ${b.clusters} | ${b.right} | ${n(b.share)} |`),
			''
		);
	}
	lines.push(
		'## 5. Матрица «профиль × грейд × форма»',
		'',
		'Профили — **явная модель**: сдвиг доли верного от порога задания по грейду задания и по блоку.',
		'',
		'| Профиль | Сдвиг: Junior / Middle / Senior | Поправка блоков |',
		'|---|---|---|',
		...PROFILES.map(
			(p) =>
				`| ${p.title} | ${n(p.byGrade.junior, 2)} / ${n(p.byGrade.middle, 2)} / ${n(p.byGrade.senior, 2)} | ${
					Object.entries(p.byBlock)
						.map(([b, v]) => `${blockDefinition(b).title} ${n(v, 2)}`)
						.join(', ') || '—'
				} |`
		),
		'',
		'| Профиль | Грейд | Подтверждено, форма A | Подтверждено, форма B | Не определено, A / B | Повтор на B совпал с A |',
		'|---|---|---|---|---|---|',
		...matrix.map(
			(c) =>
				`| ${PROFILES.find((p) => p.key === c.profile)?.title ?? c.profile} | ${c.grade} | ${ci(c.formA)} | ${ci(c.formB)} | ${n(c.formA.undetermined)} / ${n(c.formB.undetermined)} | ${n(c.retakeAgreement)} |`
		),
		'',
		'Назначенный грейд — высший подтверждённый из Junior, Middle, Senior (попытка на каждый); повтор — те же три попытки на форме B после A.',
		'',
		'| Профиль | Назначено на A: нет / J / M / S | Назначено на повторе B | Совпадение |',
		'|---|---|---|---|',
		...ladder.map((l) => {
			const shares = (s: Record<string, number>) => ['none', ...GRADES].map((k) => n(s[k] ?? 0)).join(' / ');
			return `| ${PROFILES.find((p) => p.key === l.profile)?.title ?? l.profile} | ${shares(l.assignedA)} | ${shares(l.assignedRetakeB)} | ${n(l.agreement)} |`;
		}),
		'',
		'## Граница',
		'',
		'Банк открыт в рамках хакатона: у кого есть репозиторий, тот вычисляет ответ любого экземпляра генератором — такая атака даёт ~100 % верных ответов и здесь не измеряется. Числа выше — для кандидата, у которого есть чужие ответы или программы, но нет генераторов.',
		''
	);
	return lines.join('\n');
}
