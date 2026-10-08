// The grade hint (docs/domain.md, section 12.2): advice on which grade to declare, with its grounds — not a decision.
// It is built at every showing from the evidence in force: the experience in the specialization and the responsibility
// markers of the resume, the FSP achievements and their level, the verified public profiles.
//
// Production experience sets the grade: the months of the specialization's roles (the union of periods, shortest
// reading) fall into a band of the rule set, and a responsibility marker of the resume raises it by the rule set's step
// within the band of the longest reading. Competitions and public profiles confirm skills, not production experience:
// by themselves they never suggest above `nonProductionCeiling`. Pure and deterministic: no clock, no model.
import { z } from 'zod';
import {
	CATALOG,
	GRADE_KEYS,
	gradeOrdinal,
	PRACTICE_LANGUAGE_SKILLS,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { GRADE_POLICY } from '$lib/server/assessments/contract/policy';
import { CATEGORY_GRADE_NAMES } from '$lib/server/categories/labels';
import { aggregateStrength, collectEvidence } from '$lib/server/evidence/inferences';
import { experienceMonths, hasValidPeriod } from '$lib/server/evidence/experience';
import { fspLevels } from '$lib/server/evidence/fsp-level';
import type { EvidenceSnapshot, ClaimInput, Contribution, FspLevel, RulesContext } from '$lib/server/evidence/types';
import { rolesOfSpecialization } from '$lib/server/categories/roles';
import { DISCIPLINES, pluralize, type DisciplineCode } from '$lib/components/product/model';

/** The rules of the hint; a change of them is a new version, named in every stored snapshot. */
export const HINT_RULES = {
	version: 1,
	/** The highest grade competitions and public profiles suggest by themselves. */
	nonProductionCeiling: 'junior' as GradeKey,
	/** FSP levels from which a relevant competition result suggests the ceiling; lower levels suggest Intern. */
	fspCeilingLevels: ['L3', 'L4', 'L5'] as readonly FspLevel[],
	/** A public profile suggests the ceiling when a relevant skill reaches this band of the rule set; else Intern. */
	publicProfileCeilingBand: 'strong' as 'moderate' | 'strong'
} as const;

export type HintSource = 'resume' | 'fsp' | 'public_profile';

export interface HintBasis {
	source: HintSource;
	text: string;
	fact_id?: string;
}

/** The hint as the candidate sees it and as a declaration stores it (`grade_declarations.hint`). */
export interface GradeHint {
	version: number;
	suggested: GradeKey | null;
	bases: HintBasis[];
	caveats: string[];
}

/** The stored snapshot read back: a declaration without a valid hint is a data error. */
export const gradeHintSchema: z.ZodType<GradeHint> = z.strictObject({
	version: z.int().positive(),
	suggested: z.enum(GRADE_KEYS).nullable(),
	bases: z.array(
		z.strictObject({
			source: z.enum(['resume', 'fsp', 'public_profile']),
			text: z.string().min(1),
			fact_id: z.uuid().optional()
		})
	),
	caveats: z.array(z.string().min(1))
});

export interface HintInput {
	snapshot: EvidenceSnapshot;
	rules: RulesContext;
	specialization: SpecializationKey;
	/** Names of the taxonomy skills for the text of the grounds. */
	skillNames: Readonly<Record<string, string>>;
	asOf: Date;
}

const MARKER_TEXT: Record<string, string> = {
	mentoring: 'наставничество',
	team_lead: 'руководство командой',
	architecture: 'архитектурные решения'
};

const GRADE_TITLE = CATEGORY_GRADE_NAMES;

const withDiscipline = z.looseObject({ discipline: z.string() });
/** Where the FSP payloads (contracts 1.3) carry the discipline of a result, a rank and a team place. */
const DISCIPLINE_HOLDERS = ['competition', 'qualification', 'nationalTeam'] as const;

function disciplineOf(payload: unknown): string | null {
	if (payload === null || typeof payload !== 'object') return null;
	for (const holder of DISCIPLINE_HOLDERS) {
		const parsed = withDiscipline.safeParse((payload as Record<string, unknown>)[holder]);
		if (parsed.success) return parsed.data.discipline;
	}
	return null;
}

const disciplineName = (code: string) =>
	code in DISCIPLINES ? DISCIPLINES[code as DisciplineCode].name : DISCIPLINES.unknown.name;

/** «2 года 3 месяца», «7 месяцев», «меньше месяца». */
export function monthsText(months: number): string {
	const years = Math.floor(months / 12);
	const rest = months % 12;
	const parts: string[] = [];
	if (years > 0) parts.push(`${years} ${pluralize(years, ['год', 'года', 'лет'])}`);
	if (rest > 0) parts.push(`${rest} ${pluralize(rest, ['месяц', 'месяца', 'месяцев'])}`);
	return parts.length === 0 ? 'меньше месяца' : parts.join(' ');
}

/** Skills a test of the specialization confirms: the skills of its blocks and of its practice languages. */
export function specializationSkills(specialization: SpecializationKey): Set<string> {
	const skills = new Set<string>();
	for (const block of CATALOG.blocks) {
		if (block.specialization === specialization) for (const skill of block.skillKeys) skills.add(skill);
	}
	const definition = CATALOG.specializations.find((s) => s.key === specialization);
	if (!definition) throw new Error(`catalog ${CATALOG.version} has no specialization ${specialization}`);
	for (const language of definition.practiceLanguages) skills.add(PRACTICE_LANGUAGE_SKILLS[language]);
	return skills;
}

/** A grade of the taxonomy scale on the catalog's scale: Lead and above are not declared — Senior is the top. */
function catalogGrade(taxonomyKey: string, rules: RulesContext): GradeKey {
	const found = GRADE_KEYS.find((key) => key === taxonomyKey);
	if (found) return found;
	const ordinal = rules.grades.find((g) => g.key === taxonomyKey)?.ordinal;
	const senior = rules.grades.find((g) => g.key === 'senior')?.ordinal;
	if (ordinal === undefined || senior === undefined || ordinal < senior) {
		throw new Error(`grade ${taxonomyKey} of the rule set is not on the catalog scale`);
	}
	return 'senior';
}

const factRef = (id: string | undefined): { fact_id?: string } => (id === undefined ? {} : { fact_id: id });

const higher = (a: GradeKey | null, b: GradeKey | null): GradeKey | null =>
	a === null ? b : b === null ? a : gradeOrdinal(a) >= gradeOrdinal(b) ? a : b;
const lower = (a: GradeKey, b: GradeKey): GradeKey => (gradeOrdinal(a) <= gradeOrdinal(b) ? a : b);

interface Reading {
	grade: GradeKey | null;
	bases: HintBasis[];
	caveats: string[];
}

function fromExperience(input: HintInput, markers: ReturnType<typeof collectEvidence>['resumeMarkers']): Reading {
	const { snapshot, rules, specialization, asOf } = input;
	const params = rules.params.grade;
	// The roles whose experience counts: the roles whose vacancies the specialization serves.
	const roles = new Set<string>(rolesOfSpecialization(specialization));
	const inScope = snapshot.experience.filter((e) => e.roleKey !== null && roles.has(e.roleKey));
	const counted = inScope.filter(hasValidPeriod).sort((a, b) => (a.id < b.id ? -1 : 1));
	const caveats: string[] = [];
	const undated = inScope.length - counted.length;
	if (undated > 0) {
		caveats.push(
			`${undated} ${pluralize(undated, ['место работы', 'места работы', 'мест работы'])} по специализации без дат не ` +
				'учтено: уточните даты в резюме'
		);
	}
	if (counted.some((e) => e.candidateReview === 'pending')) {
		caveats.push('Опыт из резюме ещё не проверен вами: проверьте разбор резюме');
	}
	if (counted.length === 0) return { grade: null, bases: [], caveats };

	const months = experienceMonths(counted, asOf);
	const bandOf = (value: number) => {
		const band = params.experienceBands.find(
			(b) => b.fromMonths <= value && (b.toMonths === null || value <= b.toMonths)
		);
		if (!band) throw new Error(`no experience band of the rule set covers ${value} months`);
		return band;
	};
	let grade = catalogGrade(bandOf(months.min_months).min, rules);
	const ceiling = catalogGrade(bandOf(months.max_months).max, rules);
	const span =
		months.min_months === months.max_months
			? monthsText(months.min_months)
			: `от ${monthsText(months.min_months)} до ${monthsText(months.max_months)}`;
	const bases: HintBasis[] = [
		{
			source: 'resume',
			text: `Опыт по специализации — ${span} (${counted.length} ${pluralize(counted.length, ['место работы', 'места работы', 'мест работы'])})`,
			...factRef(counted[0]?.factId)
		}
	];
	const markerSources = new Set<string>(params.responsibilityMarkerSources);
	const markerKeys = new Set<string>(params.responsibilityMarkers.markers);
	const counting = params.signals.includes('responsibility_markers')
		? markers.filter((m) => markerSources.has(m.source) && markerKeys.has(m.marker))
		: [];
	if (counting.length > 0) {
		const raised =
			GRADE_KEYS[Math.min(gradeOrdinal(grade) + params.responsibilityMarkers.raiseUpperBy, GRADE_KEYS.length - 1)];
		if (raised) grade = lower(raised, ceiling);
		const seen = new Set<string>();
		for (const marker of [...counting].sort((a, b) => (a.claim_id < b.claim_id ? -1 : 1))) {
			if (seen.has(marker.marker)) continue;
			seen.add(marker.marker);
			bases.push({
				source: 'resume',
				text: `В резюме: ${MARKER_TEXT[marker.marker] ?? marker.marker}`,
				...factRef(marker.fact_id)
			});
		}
	}
	return { grade, bases, caveats };
}

const relevantContributions = (
	evidence: ReturnType<typeof collectEvidence>,
	skills: ReadonlySet<string>,
	keep: (c: Contribution) => boolean
): Map<string, Contribution[]> => {
	const out = new Map<string, Contribution[]>();
	for (const [skill, contributions] of [...evidence.skills.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (!skills.has(skill)) continue;
		const kept = contributions.filter(keep);
		if (kept.length > 0) out.set(skill, kept);
	}
	return out;
};

function fromFsp(input: HintInput, evidence: ReturnType<typeof collectEvidence>, skills: ReadonlySet<string>): Reading {
	const relevant = relevantContributions(
		evidence,
		skills,
		(c) => c.basis === 'fsp_projection' && c.trust_level === 'fsp_verified' && c.contribution > 0
	);
	if (relevant.size === 0) return { grade: null, bases: [], caveats: [] };
	const facts = new Map(input.snapshot.facts.map((f) => [f.id, f]));
	const factIds = [...new Set([...relevant.values()].flat().map((c) => c.fact_id))].sort();
	const disciplines = new Set(factIds.flatMap((id) => disciplineOf(facts.get(id)?.payload) ?? []));
	const claimsByFact = new Map<string, ClaimInput[]>();
	for (const claim of input.snapshot.claims) {
		claimsByFact.set(claim.factId, [...(claimsByFact.get(claim.factId) ?? []), claim]);
	}
	const levels = fspLevels(input.snapshot.facts, claimsByFact, input.rules).filter((l) =>
		disciplines.has(l.discipline)
	);
	const best = [...levels].sort((a, b) => (a.level < b.level ? 1 : a.level > b.level ? -1 : 0))[0] ?? null;
	const grade: GradeKey =
		best !== null && HINT_RULES.fspCeilingLevels.includes(best.level) ? HINT_RULES.nonProductionCeiling : 'intern';
	const names = [...relevant.keys()].map((skill) => input.skillNames[skill] ?? skill);
	const where = best === null ? '' : `; уровень ${best.level} — ${disciplineName(best.discipline)}`;
	return {
		grade,
		bases: [
			{
				source: 'fsp',
				text: `Результаты ФСП подтверждают навыки специализации: ${names.join(', ')}${where}`,
				...factRef(best?.basisFactIds[0] ?? factIds[0])
			}
		],
		caveats: []
	};
}

function fromPublicProfiles(
	input: HintInput,
	evidence: ReturnType<typeof collectEvidence>,
	skills: ReadonlySet<string>
): Reading {
	const relevant = relevantContributions(evidence, skills, (c) => c.basis === 'public_profile' && c.contribution > 0);
	if (relevant.size === 0) return { grade: null, bases: [], caveats: [] };
	const threshold = input.rules.params.strengthBands[HINT_RULES.publicProfileCeilingBand];
	const strongest = Math.max(...[...relevant.values()].map((contributions) => aggregateStrength(contributions)));
	const grade: GradeKey = strongest >= threshold ? HINT_RULES.nonProductionCeiling : 'intern';
	const bases: HintBasis[] = [];
	for (const platform of ['codeforces', 'github'] as const) {
		const skillsOf = [...relevant.entries()].filter(([, contributions]) =>
			contributions.some((c) => c.source === platform)
		);
		if (skillsOf.length === 0) continue;
		const factId = skillsOf
			.flatMap(([, contributions]) => contributions.filter((c) => c.source === platform))
			.map((c) => c.fact_id)
			.sort()[0];
		bases.push({
			source: 'public_profile',
			text: `${platform === 'codeforces' ? 'Codeforces' : 'GitHub'} подтверждает навыки: ${skillsOf
				.map(([skill]) => input.skillNames[skill] ?? skill)
				.join(', ')}`,
			...factRef(factId)
		});
	}
	return { grade, bases, caveats: [] };
}

/** The hint for a specialization of the candidate as of `asOf`. */
export function gradeHint(input: HintInput): GradeHint {
	const evidence = collectEvidence(input.snapshot, input.rules, input.asOf);
	const skills = specializationSkills(input.specialization);
	const experience = fromExperience(input, evidence.resumeMarkers);
	const fsp = fromFsp(input, evidence, skills);
	const profiles = fromPublicProfiles(input, evidence, skills);

	// Each competitive reading is at most `nonProductionCeiling` by its own rule.
	const competitive = higher(fsp.grade, profiles.grade);
	const suggested = higher(experience.grade, competitive);
	const caveats = [...experience.caveats];
	if (
		competitive !== null &&
		(experience.grade === null || gradeOrdinal(experience.grade) < gradeOrdinal(competitive))
	) {
		caveats.push(
			`Соревнования и публичные профили подтверждают навыки, а не производственный опыт: сами по себе они не ` +
				`подсказывают грейд выше ${GRADE_TITLE[HINT_RULES.nonProductionCeiling]}`
		);
	}
	if (suggested === null) caveats.push('Оснований для подсказки нет: выберите грейд сами');
	caveats.push(
		`Подсказка — совет, а не решение: грейд подтверждает только тест. Если тест заявленного грейда не будет ` +
			`пройден, тест грейда ниже откроется сразу, повтор того же грейда — через ${GRADE_POLICY.retakeIntervalDays} ` +
			pluralize(GRADE_POLICY.retakeIntervalDays, ['день', 'дня', 'дней']) +
			', и тест ниже этот повтор не откладывает'
	);
	return {
		version: HINT_RULES.version,
		suggested,
		bases: [...experience.bases, ...fsp.bases, ...profiles.bases],
		caveats
	};
}
