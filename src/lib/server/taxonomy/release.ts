// A taxonomy release: validated source files turned into the exact rows of one taxonomy version and its hash.
// Imported by plain Node (scripts/seed-taxonomy.ts): relative imports with extensions, erasable syntax only.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../json/canonical.ts';
import {
	DATASET_FILES,
	datasetSchemas,
	type DatasetName,
	type ReceiptLimits,
	type TaxonomyDatasets
} from './datasets.ts';
import { normalizeSkillText } from './normalize.ts';

export class TaxonomyError extends Error {
	readonly code: 'invalid_dataset' | 'version_changed' | 'ruleset_changed' | 'match_ruleset_changed' | 'draft_exists';

	constructor(code: TaxonomyError['code'], message: string) {
		super(message);
		this.name = 'TaxonomyError';
		this.code = code;
	}
}

// Rows in the shape of the database columns (snake_case), without the version id and surrogate ids.
// `jsonb` values are plain JSON; `numeric` values are numbers; timestamps are ISO strings.

type RoleRow = {
	key: string;
	family: string;
	name_ru: string;
	core_skill_groups: unknown;
	typical_skills: string[];
	hh_role_id: string[];
	habr_spec: string[];
	prof_standard: string[];
};

type SkillRow = {
	key: string;
	kind: string;
	parent_key: string | null;
	name: string;
	hh_id: string | null;
	habr_id: string | null;
	so_tag: string | null;
};

type SkillAliasRow = {
	alias_normalized: string;
	skill_key: string;
};

type GradeRow = {
	key: string;
	ordinal: number;
	name: string;
};

type WorkFormatRow = {
	dimension: string;
	key: string;
	name: string;
};

type FspProjectionRuleRow = {
	discipline: string;
	target_kind: string;
	target_key: string;
	weight: number;
	attestation: string;
	requires_specialization: string | null;
	applies_to: string;
};

type FspStrengthParamsRow = {
	evsk_norm: unknown;
	rank_strength: unknown;
	format_factors: unknown;
	unknown_role_factor: number;
	recency_half_life_years: number;
};

type FspLevelRuleRow = {
	level: string;
	criteria: unknown;
};

type ReceiptTemplateRow = {
	source: string;
	fact_type: string;
	asserts: unknown;
	does_not_assert: ReceiptLimits;
};

type SalaryReferenceRow = {
	source: string;
	collected_at: string;
	role_key: string;
	grade_key: string | null;
	skill_key: string | null;
	median: number | null;
	p25: number | null;
	p75: number | null;
	sample_size: number;
	currency: string;
	period: string;
	tax_base: string;
	geography: string;
	method: string;
};

export interface TaxonomyContent {
	sources: unknown;
	roles: RoleRow[];
	skills: SkillRow[];
	skillAliases: SkillAliasRow[];
	grades: GradeRow[];
	workFormats: WorkFormatRow[];
	fspProjectionRules: FspProjectionRuleRow[];
	fspStrengthParams: FspStrengthParamsRow;
	fspLevelRules: FspLevelRuleRow[];
	receiptTemplates: ReceiptTemplateRow[];
	salaryReferences: SalaryReferenceRow[];
}

export interface TaxonomyRelease {
	label: string;
	content: TaxonomyContent;
	/** SHA-256 of the canonical content: what the version holds, independent of row order. */
	contentSha256: string;
	/** Categorization rule set of the release. */
	ruleset: { version: number; params: unknown };
	matchRuleset: { version: number; params: unknown };
}

/** Reads and validates every source file of a release directory. */
export async function readTaxonomyDatasets(directory: string): Promise<TaxonomyDatasets> {
	const raw: Partial<Record<DatasetName, unknown>> = {};
	for (const [name, file] of Object.entries(DATASET_FILES) as [DatasetName, string][]) {
		const path = join(directory, file);
		try {
			raw[name] = JSON.parse(await readFile(path, 'utf8'));
		} catch (error) {
			throw new TaxonomyError('invalid_dataset', `${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return parseTaxonomyDatasets(raw);
}

/** Validates the parsed JSON of every source file against its schema. */
export function parseTaxonomyDatasets(raw: Partial<Record<DatasetName, unknown>>): TaxonomyDatasets {
	const issues: string[] = [];
	const parsed: Partial<Record<DatasetName, unknown>> = {};
	for (const name of Object.keys(DATASET_FILES) as DatasetName[]) {
		const result = datasetSchemas[name].safeParse(raw[name]);
		if (result.success) {
			parsed[name] = result.data;
		} else {
			for (const issue of result.error.issues) {
				issues.push(`${DATASET_FILES[name]} ${issue.path.join('.') || '(root)'}: ${issue.message}`);
			}
		}
	}
	if (issues.length > 0) throw new TaxonomyError('invalid_dataset', issues.join('\n'));
	return parsed as TaxonomyDatasets;
}

/** Checks references between datasets and builds the rows of the release. */
export function buildRelease(datasets: TaxonomyDatasets): TaxonomyRelease {
	const issues: string[] = [];
	const report = (file: DatasetName, message: string) => {
		issues.push(`${DATASET_FILES[file]}: ${message}`);
	};

	const skillKeys = unique(
		datasets.skills.skills.map((s) => s.key),
		(key) => {
			report('skills', `duplicate skill ${key}`);
		}
	);
	const roleKeys = unique(
		datasets.roles.roles.map((r) => r.key),
		(key) => {
			report('roles', `duplicate role ${key}`);
		}
	);
	const gradeKeys = unique(
		datasets.grades.grades.map((g) => g.key),
		(key) => {
			report('grades', `duplicate grade ${key}`);
		}
	);
	unique(
		datasets.grades.grades.map((g) => String(g.ordinal)),
		(ordinal) => {
			report('grades', `duplicate ordinal ${ordinal}`);
		}
	);

	for (const role of datasets.roles.roles) {
		if (!(role.family in datasets.roles.families)) report('roles', `${role.key}: unknown family ${role.family}`);
		for (const skill of [...role.coreSkillGroups.flat(), ...role.typicalSkills]) {
			if (!skillKeys.has(skill)) report('roles', `${role.key}: unknown skill ${skill}`);
		}
	}

	const parents = new Map(datasets.skills.skills.map((s) => [s.key, s.parentKey]));
	for (const skill of datasets.skills.skills) {
		if (skill.parentKey !== null && !skillKeys.has(skill.parentKey)) {
			report('skills', `${skill.key}: unknown parent ${skill.parentKey}`);
		}
		const chain = new Set<string>([skill.key]);
		for (let parent = skill.parentKey; parent !== null; parent = parents.get(parent) ?? null) {
			if (chain.has(parent)) {
				report('skills', `${skill.key}: parent cycle through ${parent}`);
				break;
			}
			chain.add(parent);
		}
	}

	const aliases = new Map<string, string>();
	for (const skill of datasets.skills.skills) {
		for (const spelling of [skill.name, ...skill.aliases]) {
			const normalized = normalizeSkillText(spelling);
			if (normalized === '') {
				report('skills', `${skill.key}: spelling "${spelling}" is empty after normalization`);
				continue;
			}
			const owner = aliases.get(normalized);
			if (owner !== undefined && owner !== skill.key) {
				report('skills', `spelling "${normalized}" belongs to both ${owner} and ${skill.key}`);
			}
			aliases.set(normalized, skill.key);
		}
	}

	const projectionRules: FspProjectionRuleRow[] = [];
	for (const group of datasets.fspProjection.ruleGroups) {
		const targets = [
			...Object.entries(group.targets.skill ?? {}).map(([key, weight]) => ['skill', key, weight] as const),
			...Object.entries(group.targets.role ?? {}).map(([key, weight]) => ['role', key, weight] as const),
			...Object.entries(group.targets.marker ?? {}).map(([key, weight]) => ['marker', key, weight] as const)
		];
		for (const [kind, key, weight] of targets) {
			if (kind === 'skill' && !skillKeys.has(key)) report('fspProjection', `${group.discipline}: unknown skill ${key}`);
			if (kind === 'role' && !roleKeys.has(key)) report('fspProjection', `${group.discipline}: unknown role ${key}`);
			// A role names a personal specialization in a team, never a plain outcome of participation (domain 9.3).
			if (kind === 'role' && group.requiresSpecialization === null) {
				report('fspProjection', `${group.discipline}: role ${key} requires a specialization`);
			}
			projectionRules.push({
				discipline: group.discipline,
				target_kind: kind,
				target_key: key,
				weight,
				attestation: group.attestation,
				requires_specialization: group.requiresSpecialization,
				applies_to: group.appliesTo
			});
		}
	}
	unique(
		projectionRules.map((r) =>
			[r.discipline, r.target_kind, r.target_key, r.requires_specialization ?? '', r.applies_to].join('/')
		),
		(rule) => {
			report('fspProjection', `duplicate rule ${rule}`);
		}
	);

	unique(
		datasets.fspStrength.evskNorm.rows.map((r) => `${r.level}/${r.ageGroup}`),
		(row) => {
			report('fspStrength', `duplicate EVSK row ${row}`);
		}
	);
	unique(
		datasets.fspLevels.levels.map((l) => l.level),
		(level) => {
			report('fspLevels', `duplicate level ${level}`);
		}
	);
	if (datasets.fspLevels.levels.length !== 5) report('fspLevels', 'every level L1–L5 must be defined');
	unique(
		datasets.receiptTemplates.templates.map((t) => `${t.source}/${t.factType}`),
		(template) => {
			report('receiptTemplates', `duplicate template ${template}`);
		}
	);
	// Only a competition result is team or personal and has a role in a team: limits by them on another fact would
	// never be asserted.
	for (const template of datasets.receiptTemplates.templates) {
		const { team, individual, byRole } = template.doesNotAssert;
		const byResult = team.length > 0 || individual.length > 0 || Object.keys(byRole).length > 0;
		if (byResult && !(template.source === 'fsp' && template.factType === 'competition_result')) {
			report(
				'receiptTemplates',
				`${template.source}/${template.factType}: limits by team, personal result or role apply to FSP competition results only`
			);
		}
	}

	for (const reference of datasets.salaryReferences.references) {
		const id = `${reference.roleKey}/${reference.gradeKey ?? '*'}/${reference.skillKey ?? '*'}`;
		if (!roleKeys.has(reference.roleKey)) report('salaryReferences', `${id}: unknown role`);
		if (reference.gradeKey !== null && !gradeKeys.has(reference.gradeKey)) {
			report('salaryReferences', `${id}: unknown grade`);
		}
		if (reference.skillKey !== null && !skillKeys.has(reference.skillKey)) {
			report('salaryReferences', `${id}: unknown skill`);
		}
	}
	unique(
		datasets.salaryReferences.references.map(
			(r) => `${r.roleKey}/${r.gradeKey ?? '*'}/${r.skillKey ?? '*'}/${r.method}`
		),
		(reference) => {
			report('salaryReferences', `duplicate reference ${reference}`);
		}
	);

	const grade = datasets.categorizationRuleset.params.grade;
	const ordinals = new Map(datasets.grades.grades.map((g) => [g.key, g.ordinal]));
	let expectedFrom = 0;
	grade.experienceBands.forEach((band, index) => {
		const minOrdinal = ordinals.get(band.min);
		const maxOrdinal = ordinals.get(band.max);
		if (minOrdinal === undefined || maxOrdinal === undefined) {
			report('categorizationRuleset', `experience band ${index}: unknown grade`);
		} else if (minOrdinal > maxOrdinal) {
			report('categorizationRuleset', `experience band ${index}: min grade above max grade`);
		}
		if (band.fromMonths !== expectedFrom) {
			report('categorizationRuleset', `experience band ${index} must start at ${expectedFrom} months`);
		}
		const last = index === grade.experienceBands.length - 1;
		if (last !== (band.toMonths === null)) {
			report('categorizationRuleset', 'only the last experience band is open-ended');
		}
		if (band.toMonths !== null) {
			if (band.toMonths < band.fromMonths) report('categorizationRuleset', `experience band ${index} is empty`);
			expectedFrom = band.toMonths + 1;
		}
	});
	for (const key of grade.responsibilityMarkers.requiredFor) {
		if (!gradeKeys.has(key)) report('categorizationRuleset', `responsibility markers: unknown grade ${key}`);
	}

	const profiles = datasets.categorizationRuleset.params.evidence.publicProfiles;
	for (const skill of profiles.codeforces.skills) {
		if (!skillKeys.has(skill))
			report('categorizationRuleset', `public profiles: Codeforces confirms unknown skill ${skill}`);
	}
	unique(
		Object.keys(profiles.github.languages).map((name) => name.toLowerCase()),
		(name) => {
			report('categorizationRuleset', `public profiles: GitHub language ${name} is listed twice`);
		}
	);
	for (const [language, skill] of Object.entries(profiles.github.languages)) {
		if (!skillKeys.has(skill)) {
			report('categorizationRuleset', `public profiles: GitHub language ${language} confirms unknown skill ${skill}`);
		}
	}

	if (issues.length > 0) throw new TaxonomyError('invalid_dataset', issues.join('\n'));

	const salary = datasets.salaryReferences;
	const collectedAt = new Date(`${salary.collectedAt}T00:00:00Z`).toISOString();
	const content: TaxonomyContent = {
		sources: {
			release: datasets.release,
			datasets: (Object.keys(DATASET_FILES) as DatasetName[])
				.filter((name) => name !== 'release' && name !== 'categorizationRuleset' && name !== 'matchRuleset')
				.map((name) => {
					const { meta } = datasets[name];
					return { file: DATASET_FILES[name], ...meta };
				})
		},
		roles: datasets.roles.roles.map((r) => ({
			key: r.key,
			family: r.family,
			name_ru: r.nameRu,
			core_skill_groups: r.coreSkillGroups,
			typical_skills: r.typicalSkills,
			hh_role_id: r.hhRoleIds,
			habr_spec: r.habrSpecs,
			prof_standard: r.profStandards
		})),
		skills: datasets.skills.skills.map((s) => ({
			key: s.key,
			kind: s.kind,
			parent_key: s.parentKey,
			name: s.name,
			hh_id: s.hhId,
			habr_id: s.habrId,
			so_tag: s.soTag
		})),
		skillAliases: [...aliases].map(([alias_normalized, skill_key]) => ({ alias_normalized, skill_key })),
		grades: datasets.grades.grades.map((g) => ({ key: g.key, ordinal: g.ordinal, name: g.name })),
		workFormats: Object.entries(datasets.workFormats.dimensions).flatMap(([dimension, values]) =>
			values.map((v) => ({ dimension, key: v.key, name: v.name }))
		),
		fspProjectionRules: projectionRules,
		fspStrengthParams: {
			evsk_norm: datasets.fspStrength.evskNorm,
			rank_strength: datasets.fspStrength.rankStrength,
			format_factors: datasets.fspStrength.formatFactors,
			unknown_role_factor: datasets.fspStrength.unknownRoleFactor,
			recency_half_life_years: datasets.fspStrength.recencyHalfLifeYears
		},
		fspLevelRules: datasets.fspLevels.levels.map((l) => ({ level: l.level, criteria: l.criteria })),
		receiptTemplates: datasets.receiptTemplates.templates.map((t) => ({
			source: t.source,
			fact_type: t.factType,
			asserts: t.asserts,
			does_not_assert: t.doesNotAssert
		})),
		salaryReferences: salary.references.map((r) => ({
			source: salary.source,
			collected_at: collectedAt,
			role_key: r.roleKey,
			grade_key: r.gradeKey,
			skill_key: r.skillKey,
			median: r.median,
			p25: r.p25,
			p75: r.p75,
			sample_size: r.sampleSize,
			currency: salary.currency,
			period: salary.period,
			tax_base: salary.taxBase,
			geography: salary.geography,
			method: r.method
		}))
	};

	return {
		label: datasets.release.label,
		content,
		contentSha256: contentHash(content),
		ruleset: {
			version: datasets.categorizationRuleset.version,
			params: datasets.categorizationRuleset.params
		},
		matchRuleset: {
			version: datasets.matchRuleset.version,
			params: datasets.matchRuleset.params
		}
	};
}

/** Hash of the content: every row list is compared as a set, JSON objects with sorted keys. */
export function contentHash(content: Record<keyof TaxonomyContent, unknown>): string {
	const canonical = Object.fromEntries(
		Object.entries(content).map(([name, value]) => [
			name,
			Array.isArray(value) ? value.map((row) => canonicalJson(row)).sort() : canonicalJson(value)
		])
	);
	return sha256(canonicalJson(canonical));
}

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/** The set of values; `onDuplicate` is called once per repeated value. */
function unique(values: readonly string[], onDuplicate: (value: string) => void): Set<string> {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) onDuplicate(value);
		seen.add(value);
	}
	return seen;
}
