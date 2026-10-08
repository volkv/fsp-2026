// The numbers the submission documentation gives about the banks of the test, computed from the files they come from:
// the descriptors of the families (`gates`, reviews, Angoff ratings), the trajectory reports of the releases
// (`assessments/trajectories/<specialization>.json`) and the resilience report of Backend (`b3-report.json`).
//
// A section marks every such number or table as a fragment — `<!-- bank-facts:<name> -->…<!-- /bank-facts:<name> -->`,
// inline or on lines of its own — and this script renders each fragment from the files. Without arguments it checks
// that every fragment says what the files say and every fragment it knows is used; it fails on the first difference.
// `--write` puts the rendered fragments into the sections. Runs with plain Node: `pnpm docs:bank-facts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CATALOG, GRADE_KEYS, type GradeKey } from '../../src/lib/server/assessments/contract/catalog.ts';
import {
	acceptanceCheckPasses,
	PROCEDURE,
	trajectoryChecks
} from '../../src/lib/server/assessments/contract/procedure.ts';
import { familyProblems } from '../../src/lib/server/assessments/contract/validate.ts';
import { isAuthor } from '../../src/lib/server/assessments/contract/bank.ts';
import { currentSourceSha256, loadTree } from '../assessments/tree.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SECTIONS = ['docs/submission/04-testing.md', 'docs/submission/06-validation.md'];
const TRAJECTORIES = join(ROOT, 'assessments/trajectories');

// ---------------------------------------------------------------------------------------------------------------
// Formatting: the Russian decimal comma, a half rounded away from zero on the decimal digits (as the reports do).

const round = (x: number, digits: number): number => Math.round(x * 10 ** digits) / 10 ** digits;
const dec = (x: number, digits = 3): string => round(x, digits).toFixed(digits).replace('.', ',');
/** A share that may be exactly zero: «0» rather than «0,0000». */
const share = (x: number, digits: number): string => (x === 0 ? '0' : dec(x, digits));
/** An integer with its thousands apart: «2 803». */
const int = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
/** Russian plural by the last digits: 1 семейство, 3 семейства, 5 семейств. */
function plural(n: number, one: string, few: string, many: string): string {
	const tens = n % 100;
	const units = n % 10;
	if (tens >= 11 && tens <= 14) return many;
	return units === 1 ? one : units >= 2 && units <= 4 ? few : many;
}
const pct = (x: number): string => String(Math.round(x * 100));
const range = (values: readonly number[], f: (x: number) => string): string => {
	const lo = f(Math.min(...values));
	const hi = f(Math.max(...values));
	return lo === hi ? lo : `${lo}–${hi}`;
};
const slash = (values: readonly number[], f: (x: number) => string = (x) => dec(x)): string => values.map(f).join(' / ');
const table = (head: readonly string[], rows: readonly (readonly string[])[]): string =>
	[`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join(
		'\n'
	);

// ---------------------------------------------------------------------------------------------------------------
// The banks from the descriptors.

interface BankFacts {
	key: string;
	title: string;
	families: number;
	levels: number;
	levelsByGrade: Record<GradeKey, number>;
	referenceFailures: number;
	wrongCaught: number;
	wrongMustBeCaught: number;
	collisionMax: number;
	mutationScoreMin: number | null;
	transferMax: number | null;
	/** Families whose rubric is approved as a release needs it on the current sources. */
	reviewed: number;
	/** Family-levels whose cut rests on enough independent ratings of the current sources. */
	rated: number;
	/** The largest gap between two current independent ratings of one level. */
	ratingGapMax: number;
	secondRounds: number;
}

function bankFacts(): BankFacts[] {
	const { families, problems } = loadTree();
	if (problems.length > 0) throw new Error(`the bank tree cannot be read:\n${problems.join('\n')}`);
	return CATALOG.specializations.map((spec) => {
		const own = families.filter((f) => f.specialization === spec.key && !f.probe);
		if (own.length === 0) throw new Error(`no families of ${spec.key}`);
		const levelsByGrade = Object.fromEntries(GRADE_KEYS.map((g) => [g, 0])) as Record<GradeKey, number>;
		let reviewed = 0;
		let rated = 0;
		let ratingGapMax = 0;
		for (const family of own) {
			const d = family.descriptor;
			const source = currentSourceSha256(family);
			const judged = familyProblems(d, source);
			if (!judged.some((p) => p.code === 'awaiting_reviews')) reviewed += 1;
			const awaitingRaters = judged.filter((p) => p.code === 'awaiting_raters').length;
			rated += d.levels.length - awaitingRaters;
			for (const level of d.levels) {
				levelsByGrade[level.grade] += 1;
				const current = level.angoff.ratings.filter(
					(r) => r.sourceSha256 === source && !isAuthor(r.rater, d)
				);
				if (current.length > 1) {
					const ps = current.map((r) => r.p);
					ratingGapMax = Math.max(ratingGapMax, Math.max(...ps) - Math.min(...ps));
				}
			}
		}
		const gates = own.map((f) => f.descriptor.gates);
		const scores = gates.flatMap((g) => (g.hiddenTestsMutationScore === null ? [] : [g.hiddenTestsMutationScore]));
		const transfers = gates.flatMap((g) => (g.transfer === null ? [] : [g.transfer]));
		return {
			key: spec.key,
			title: spec.title,
			families: own.length,
			levels: own.reduce((sum, f) => sum + f.descriptor.levels.length, 0),
			levelsByGrade,
			referenceFailures: gates.reduce((sum, g) => sum + g.reference.failures, 0),
			wrongCaught: gates.reduce((sum, g) => sum + g.wrongSolutions.caught, 0),
			wrongMustBeCaught: gates.reduce((sum, g) => sum + g.wrongSolutions.mustBeCaught, 0),
			collisionMax: Math.max(...gates.map((g) => g.answerCollision)),
			mutationScoreMin: scores.length > 0 ? Math.min(...scores) : null,
			transferMax: transfers.length > 0 ? Math.max(...transfers) : null,
			reviewed,
			rated,
			ratingGapMax: round(ratingGapMax, 2),
			secondRounds: own.reduce((sum, f) => sum + f.descriptor.levels.filter((l) => l.angoff.round === 2).length, 0)
		};
	});
}

// ---------------------------------------------------------------------------------------------------------------
// The trajectory reports and the resilience report.

const pointSchema = z.object({
	shift: z.number(),
	runs: z.number(),
	confirmed: z.number(),
	undetermined: z.number(),
	notConfirmed: z.number()
});
const trajectorySchema = z.object({
	report: z.object({
		releaseId: z.string(),
		procedureVersion: z.string(),
		grades: z.array(
			z.object({
				grade: z.enum(GRADE_KEYS),
				points: z.array(pointSchema),
				consistency: z.array(z.object({ shift: z.number(), value: z.number() }))
			})
		)
	})
});

interface GradeTrajectory {
	low: number;
	cut: number;
	high: number;
	undeterminedMax: number;
	consistencyLow: number;
	consistencyHigh: number;
	accepted: boolean;
}

interface Trajectories {
	key: string;
	title: string;
	releaseId: string;
	procedureVersion: string;
	grades: Record<GradeKey, GradeTrajectory>;
}

function at<T extends { shift: number }>(entries: readonly T[], shift: number, where: string): T {
	const found = entries.find((e) => Math.abs(e.shift - shift) < 1e-9);
	if (!found) throw new Error(`${where}: no point at ${shift}`);
	return found;
}

function trajectories(): Trajectories[] {
	return CATALOG.specializations.map((spec) => {
		const file = join(TRAJECTORIES, `${spec.key}.json`);
		const { report } = trajectorySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
		const grades = Object.fromEntries(
			GRADE_KEYS.map((g) => {
				const entry = report.grades.find((e) => e.grade === g);
				if (!entry) throw new Error(`${file}: no ${g}`);
				const where = `${file} ${g}`;
				const checks = trajectoryChecks(PROCEDURE, g, entry.points, entry.consistency);
				const value: GradeTrajectory = {
					low: at(entry.points, -0.15, where).confirmed,
					cut: at(entry.points, 0, where).confirmed,
					high: at(entry.points, 0.15, where).confirmed,
					undeterminedMax: Math.max(...entry.points.map((p) => p.undetermined)),
					consistencyLow: at(entry.consistency, -0.15, where).value,
					consistencyHigh: at(entry.consistency, 0.15, where).value,
					accepted: checks.every(acceptanceCheckPasses)
				};
				return [g, value];
			})
		) as Record<GradeKey, GradeTrajectory>;
		return {
			key: spec.key,
			title: spec.title,
			releaseId: report.releaseId,
			procedureVersion: report.procedureVersion,
			grades
		};
	});
}

const outcomeSchema = z.object({ runs: z.number(), confirmed: z.number(), undetermined: z.number() });
const b3Schema = z.object({
	releaseId: z.string(),
	model: z.object({ strategyGains: z.array(z.number()) }),
	transfer: z.array(
		z.object({
			grade: z.enum(GRADE_KEYS),
			attackerShift: z.number(),
			leak: z.enum(['none', 'answers', 'practice', 'both']),
			source: z.enum(['donor', 'class']).nullable(),
			outcome: outcomeSchema,
			computedLeakedShare: z.number().nullable(),
			pastedRightShare: z.number().nullable(),
			practiceGatePassed: z.number().nullable()
		})
	),
	strategy: z.array(
		z.object({ grade: z.enum(GRADE_KEYS), attackerShift: z.number(), gain: z.number(), outcome: outcomeSchema })
	),
	matrix: z.array(
		z.object({
			profile: z.enum(GRADE_KEYS),
			grade: z.enum(GRADE_KEYS),
			formA: outcomeSchema,
			formB: outcomeSchema,
			retakeAgreement: z.number()
		})
	),
	ladder: z.array(
		z.object({
			profile: z.enum(GRADE_KEYS),
			assignedA: z.record(z.string(), z.number()),
			agreement: z.number()
		})
	)
});
type B3 = z.infer<typeof b3Schema>;

const B3_GRADES = ['junior', 'middle', 'senior'] as const satisfies readonly GradeKey[];
const B3_SHIFT = -0.15;

function b3(): B3 {
	return b3Schema.parse(JSON.parse(readFileSync(join(TRAJECTORIES, 'b3-report.json'), 'utf8')));
}

function transferRows(report: B3, leak: B3['transfer'][number]['leak'], source: 'donor' | 'class' | null) {
	return B3_GRADES.map((grade) => {
		const row = report.transfer.find(
			(t) =>
				t.grade === grade && Math.abs(t.attackerShift - B3_SHIFT) < 1e-9 && t.leak === leak && t.source === source
		);
		if (!row) throw new Error(`b3-report.json: no transfer ${leak}/${String(source)} at ${grade}`);
		return row;
	});
}

function strategyAt(report: B3, gain: number): number[] {
	return B3_GRADES.map((grade) => {
		const row = report.strategy.find(
			(s) => s.grade === grade && Math.abs(s.attackerShift - B3_SHIFT) < 1e-9 && Math.abs(s.gain - gain) < 1e-9
		);
		if (!row) throw new Error(`b3-report.json: no strategy point δ = ${gain} at ${grade}`);
		return row.outcome.confirmed;
	});
}

function matrixCell(report: B3, profile: GradeKey, grade: GradeKey): B3['matrix'][number] {
	const cell = report.matrix.find((m) => m.profile === profile && m.grade === grade);
	if (!cell) throw new Error(`b3-report.json: no matrix cell ${profile} × ${grade}`);
	return cell;
}

function ladderRow(report: B3, profile: GradeKey): B3['ladder'][number] {
	const row = report.ladder.find((l) => l.profile === profile);
	if (!row) throw new Error(`b3-report.json: no ladder row ${profile}`);
	return row;
}

/** The cell of a profile on the grade above its own, when the report has that grade. */
function aboveCell(report: B3, profile: GradeKey): B3['matrix'][number] | null {
	const above = B3_GRADES.find((g) => GRADE_KEYS.indexOf(g) === GRADE_KEYS.indexOf(profile) + 1);
	return above ? matrixCell(report, profile, above) : null;
}
const gradeTitle = (g: GradeKey): string => `${g.charAt(0).toUpperCase()}${g.slice(1)}`;

// ---------------------------------------------------------------------------------------------------------------
// The fragments.

function fragments(): Record<string, string> {
	const banks = bankFacts();
	const traj = trajectories();
	const attacks = b3();
	const sum = (f: (b: BankFacts) => number) => banks.reduce((s, b) => s + f(b), 0);
	const collisions = banks.map((b) => b.collisionMax);
	const scores = banks.flatMap((b) => (b.mutationScoreMin === null ? [] : [b.mutationScoreMin]));
	const transfers = banks.flatMap((b) => (b.transferMax === null ? [] : [b.transferMax]));
	const all = traj.flatMap((t) => GRADE_KEYS.map((g) => t.grades[g]));
	const accepted = traj.filter((t) => GRADE_KEYS.every((g) => t.grades[g].accepted)).length;
	const backend = traj.find((t) => t.key === 'backend');
	if (!backend) throw new Error('no trajectory report of backend');
	const honest = transferRows(attacks, 'none', null);
	const programClass = transferRows(attacks, 'practice', 'class');
	const programDonor = transferRows(attacks, 'practice', 'donor');
	const answersDonor = transferRows(attacks, 'answers', 'donor');
	const answersClass = transferRows(attacks, 'answers', 'class');
	const confirmed = (rows: { outcome: { confirmed: number } }[]) => slash(rows.map((r) => r.outcome.confirmed));
	const gatePassed = (rows: { practiceGatePassed: number | null }[]) =>
		`${range(
			rows.map((r) => {
				if (r.practiceGatePassed === null) throw new Error('b3-report.json: a practice transfer without its gate share');
				return r.practiceGatePassed;
			}),
			pct
		)} %`;
	const strategy = (gain: number) => range(strategyAt(attacks, gain), (x) => dec(x, 2));
	const allReviewed = banks.every((b) => b.reviewed === b.families && b.rated === b.levels);
	const profiles = B3_GRADES;

	return {
		'families-total': `${int(sum((b) => b.families))} ${plural(sum((b) => b.families), 'семейство', 'семейства', 'семейств')}`,
		'reference-failures-total': `${int(sum((b) => b.referenceFailures))} отказов эталона`,
		'wrong-total': `${int(sum((b) => b.wrongCaught))} из ${int(sum((b) => b.wrongMustBeCaught))}`,
		'collision-max': dec(Math.max(...collisions)),
		'transfer-max': share(Math.max(...transfers), 4),
		'trajectories-accepted':
			accepted === traj.length
				? `все ${traj.length} банков в пороге приёмки`
				: `в пороге приёмки ${accepted} из ${traj.length} банков`,
		'gates-table': table(
			[
				'Специализация',
				'Семейств (уровней)',
				'Отказов эталона',
				'Ошибочные решения',
				'Коллизия ответов, макс.',
				'Сила тестов практики, мин.',
				'Перенос, макс.'
			],
			[
				...banks.map((b) => [
					b.title,
					`${b.families} (${b.levels})`,
					int(b.referenceFailures),
					`${int(b.wrongCaught)} из ${int(b.wrongMustBeCaught)}`,
					dec(b.collisionMax),
					b.mutationScoreMin === null ? 'мутанты QA' : dec(b.mutationScoreMin),
					b.transferMax === null ? '—' : share(b.transferMax, 4)
				]),
				[
					'**Всего**',
					`**${int(sum((b) => b.families))} (${int(sum((b) => b.levels))})**`,
					`**${int(sum((b) => b.referenceFailures))}**`,
					`**${int(sum((b) => b.wrongCaught))} из ${int(sum((b) => b.wrongMustBeCaught))}**`,
					`**≤ ${dec(Math.max(...collisions))}**`,
					`**≥ ${dec(Math.min(...scores))}**`,
					`**≤ ${share(Math.max(...transfers), 4)}**`
				]
			]
		),
		'reviews-table': table(
			['Специализация', 'Ревью двумя линейками', 'Уровней с двумя оценками Angoff', 'Наибольшее расхождение оценок'],
			banks.map((b) => [
				b.title,
				`${b.reviewed} из ${b.families}`,
				`${b.rated} из ${b.levels}`,
				b.secondRounds === 0 ? dec(b.ratingGapMax, 2) : `${dec(b.ratingGapMax, 2)}, второй раунд — ${b.secondRounds}`
			])
		),
		'reviews-summary': allReviewed
			? `Суждения внесены во всех ${banks.length} банках: у каждого семейства — одобрение двух линеек на текущих ` +
				`исходниках, у каждого семейства-уровня — две оценки Angoff; наибольшее расхождение двух оценок одного уровня — ` +
				`${dec(Math.max(...banks.map((b) => b.ratingGapMax)), 2)}, второй раунд (он — при расхождении больше 0,2) ` +
				(banks.every((b) => b.secondRounds === 0)
					? 'не понадобился.'
					: `понадобился на ${sum((b) => b.secondRounds)} уровнях.`)
			: `Суждения внесены не везде: ревью двух линеек — у ${sum((b) => b.reviewed)} из ${sum((b) => b.families)} семейств, ` +
				`две оценки Angoff — у ${sum((b) => b.rated)} из ${sum((b) => b.levels)} семейств-уровней; остальные валидатор контракта ` +
				`перечисляет с предварительным порогом (\`assessments/families/gates-report.md\`, «Валидатор контракта»).`,
		'trajectories-table': table(
			['Специализация', 'Ложные, −0,15', 'На пороге', 'Верные, +0,15', '«Не определено», макс.'],
			traj.map((t) => [
				t.title,
				slash(GRADE_KEYS.map((g) => t.grades[g].low)),
				slash(GRADE_KEYS.map((g) => t.grades[g].cut)),
				slash(GRADE_KEYS.map((g) => t.grades[g].high)),
				slash(GRADE_KEYS.map((g) => t.grades[g].undeterminedMax))
			])
		),
		'trajectories-summary':
			`По всем ${all.length} точкам: ложные ${range(
				all.map((p) => p.low),
				dec
			)}, верные ${range(
				all.map((p) => p.high),
				dec
			)}, «не определено» ≤ ${dec(Math.max(...all.map((p) => p.undeterminedMax)))}. На пороге — ${range(
				all.map((p) => p.cut),
				(x) => dec(x, 2)
			)}: у пограничного испытуемого исход близок к жребию, это свойство любого порога.`,
		'trajectories-ranges':
			`кандидат на 0,15 ниже порога подтверждается в ${range(
				all.map((p) => p.low),
				(x) => dec(x, 2)
			)} случаев, на 0,15 выше — в ${range(
				all.map((p) => p.high),
				(x) => dec(x, 2)
			)}, ровно на пороге — в ${range(
				all.map((p) => p.cut),
				(x) => dec(x, 2)
			)}`,
		'consistency-ranges': `По отчётам траекторий ${traj.length} банков: на 0,15 ниже порога ${range(
			all.map((p) => p.consistencyLow),
			(x) => dec(x, 2)
		)}, на 0,15 выше ${range(
			all.map((p) => p.consistencyHigh),
			(x) => dec(x, 2)
		)}`,
		'consistency-table': table(
			['Специализация', 'На −0,15, по грейдам', 'На +0,15, по грейдам'],
			traj.map((t) => [
				t.title,
				slash(GRADE_KEYS.map((g) => t.grades[g].consistencyLow)),
				slash(GRADE_KEYS.map((g) => t.grades[g].consistencyHigh))
			])
		),
		'release-ids': `${[...new Set(traj.map((t) => t.releaseId.replace(/^[^@]+/u, '*')))].map((id) => `\`${id}\``).join(', ')}, \`${[...new Set(traj.map((t) => t.procedureVersion))].join(', ')}\``,
		'bank-state-table': table(
			[
				'Специализация',
				'Семейств (уровней)',
				'Ревью рубрик двумя рецензентами / уровней с двумя оценками Angoff',
				'Ложные подтверждения, −0,15',
				'Подтверждения, +0,15'
			],
			banks.map((b) => {
				const t = traj.find((x) => x.key === b.key);
				if (!t) throw new Error(`no trajectory report of ${b.key}`);
				return [
					b.title,
					`${b.families} (${b.levels})`,
					`${b.reviewed} / ${b.rated}`,
					slash(GRADE_KEYS.map((g) => t.grades[g].low)),
					slash(GRADE_KEYS.map((g) => t.grades[g].high))
				];
			})
		),
		'levels-by-grade': banks
			.map((b) => `${b.title} ${slash(GRADE_KEYS.map((g) => b.levelsByGrade[g]), String)}`)
			.join(', '),
		'rating-gap-max': dec(Math.max(...banks.map((b) => b.ratingGapMax)), 2),
		'gates-summary':
			`отказов эталона ${sum((b) => b.referenceFailures) === 0 ? `0 во всех ${banks.length} банках` : banks.map((b) => `${b.title} ${int(b.referenceFailures)}`).join(', ')}; ` +
			`обязательных ошибочных решений поймано ${banks.map((b) => `${b.title} ${int(b.wrongCaught)} из ${int(b.wrongMustBeCaught)}`).join(', ')}; ` +
			`наибольшая коллизия ответов — ${banks.map((b) => dec(b.collisionMax)).join(', ')}; ` +
			`сила скрытых тестов практики не ниже ${dec(Math.min(...scores))} (у QA практика проверяется мутантами, поле не заполняется); ` +
			`перенос между классами не выше ${share(Math.max(...transfers), 4)}`,
		'b3-honest': confirmed(honest),
		'b3-baseline': slash(B3_GRADES.map((g) => backend.grades[g].low)),
		'b3-answers': `${confirmed(answersDonor)} и ${confirmed(answersClass)}`,
		'b3-answers-right': `${range(
			[...answersDonor, ...answersClass].map((r) => {
				if (r.pastedRightShare === null) throw new Error('b3-report.json: answers transfer without its pasted right share');
				return r.pastedRightShare;
			}),
			(x) => String(round(x * 100, 1)).replace('.', ',')
		)} %`,
		'b3-donor-coverage': `${range(
			answersDonor.map((r) => {
				if (r.computedLeakedShare === null) throw new Error('b3-report.json: answers transfer without its coverage');
				return r.computedLeakedShare;
			}),
			pct
		)} %`,
		'b3-attack-summary':
			`чужие ответы: ложных подтверждений ≤ ${dec(Math.max(...[...answersDonor, ...answersClass].map((r) => r.outcome.confirmed)))}; ` +
			`программа практики: ≤ ${dec(Math.max(...[...programClass, ...programDonor].map((r) => r.outcome.confirmed)))}`,
		'b3-program-class': confirmed(programClass),
		'b3-program-class-gate': gatePassed(programClass),
		'b3-program-donor': confirmed(programDonor),
		'b3-program-donor-gate': gatePassed(programDonor),
		'b3-strategy':
			`δ = 0,05: ${strategy(0.05)}; δ = 0,10: ${strategy(0.1)}; δ = 0,15: ${strategy(0.15)}`,
		'b3-strategy-arrows': `δ = 0,05 → ${strategy(0.05)}; δ = 0,10 → ${strategy(0.1)}; δ = 0,15 → ${strategy(0.15)}`,
		'b3-matrix-short': table(
			['Профиль', 'Подтверждён свой грейд, A / B', 'Подтверждён грейд выше, A / B', 'Стабильный грейд (A и повтор B)'],
			profiles.map((p) => {
				const own = matrixCell(attacks, p, p);
				const above = aboveCell(attacks, p);
				return [
					`типичный ${gradeTitle(p)}`,
					slash([own.formA.confirmed, own.formB.confirmed]),
					above ? slash([above.formA.confirmed, above.formB.confirmed]) : '—',
					dec(ladderRow(attacks, p).agreement)
				];
			})
		),
		'b3-matrix-full': table(
			[
				'Профиль',
				'Подтверждён свой грейд, A / B',
				'Подтверждён грейд выше, A / B',
				'Повтор на B совпал с A, свой грейд',
				'Назначен свой грейд',
				'Назначенный грейд совпал на повторе'
			],
			profiles.map((p) => {
				const own = matrixCell(attacks, p, p);
				const above = aboveCell(attacks, p);
				const ladder = ladderRow(attacks, p);
				const assigned = ladder.assignedA[p];
				if (assigned === undefined) throw new Error(`b3-report.json: ladder ${p} has no share of its own grade`);
				return [
					`типичный ${gradeTitle(p)}`,
					slash([own.formA.confirmed, own.formB.confirmed]),
					above ? slash([above.formA.confirmed, above.formB.confirmed]) : '—',
					dec(own.retakeAgreement),
					dec(assigned),
					dec(ladder.agreement)
				];
			})
		),
		'b3-own-range': range(
			profiles.flatMap((p) => {
				const own = matrixCell(attacks, p, p);
				return [own.formA.confirmed, own.formB.confirmed];
			}),
			(x) => dec(x, 2)
		),
		'b3-above-range': range(
			profiles.flatMap((p) => {
				const above = aboveCell(attacks, p);
				return above ? [above.formA.confirmed, above.formB.confirmed] : [];
			}),
			(x) => dec(x, 2)
		),
		'b3-form-gap': dec(
			Math.max(
				...attacks.matrix.map((m) => Math.abs(m.formA.confirmed - m.formB.confirmed))
			),
			2
		),
		'b3-stable-range': range(
			profiles.map((p) => ladderRow(attacks, p).agreement),
			(x) => dec(x, 2)
		)
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The sections.

const FRAGMENT = /<!-- bank-facts:([a-z0-9-]+) -->([\s\S]*?)<!-- \/bank-facts:\1 -->/gu;

/** A fragment on lines of its own keeps its content on lines of its own. */
const wrap = (body: string, rendered: string): string => (body.startsWith('\n') ? `\n\n${rendered}\n\n` : rendered);

function main(): number {
	const { values: args } = parseArgs({ options: { write: { type: 'boolean', default: false } } });
	const rendered = fragments();
	const used = new Set<string>();
	const differences: string[] = [];
	const problems: string[] = [];
	const rewritten = new Map<string, string>();
	for (const section of SECTIONS) {
		const path = join(ROOT, section);
		const text = readFileSync(path, 'utf8');
		const next = text.replace(FRAGMENT, (whole, name: string, body: string) => {
			const value = rendered[name];
			if (value === undefined) {
				problems.push(`${section}: unknown fragment ${name}`);
				return whole;
			}
			used.add(name);
			const expected = wrap(body, value);
			if (body !== expected)
				differences.push(`${section}: ${name}\n  in the section: ${body.trim()}\n  from the files: ${value}`);
			return `<!-- bank-facts:${name} -->${expected}<!-- /bank-facts:${name} -->`;
		});
		if (next !== text) rewritten.set(path, next);
	}
	for (const name of Object.keys(rendered).filter((n) => !used.has(n)))
		problems.push(`fragment ${name} is used by no section`);
	if (problems.length > 0) {
		console.error(`bank facts: the sections and the fragments do not match:\n${problems.join('\n')}`);
		return 1;
	}
	if (differences.length === 0) {
		console.log(`bank facts: ${used.size} fragments agree with the files`);
		return 0;
	}
	if (args.write) {
		for (const [path, text] of rewritten) writeFileSync(path, text);
		console.log(`bank facts: ${differences.length} fragments rewritten from the files`);
		return 0;
	}
	console.error(
		`bank facts differ from the files (pnpm docs:bank-facts --write rewrites them):\n${differences.join('\n')}`
	);
	return 1;
}

process.exitCode = main();
