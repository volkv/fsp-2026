// The taxonomy release the bridge measures with: read from `taxonomy/` of the checkout, which the caller locates, the
// same files the release publishes (scripts/seed-taxonomy.ts), so no database is needed. The version is identified by
// its label and content hash, which equal those of the published version built from the same files. The FSP projection
// rules are the rows the release publishes (`fsp_projection_rules`), so FSP achievements become the claims the
// synchronization writes.
import { z } from 'zod';
import type { RulesContext } from '$lib/server/categorization/types';
import type { ProjectionTaxonomy } from '$lib/server/fsp/projection';
import { buildResumeTaxonomy, type ResumeTaxonomy } from '$lib/server/resumes/taxonomy';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';

export interface EvalTaxonomy {
	label: string;
	contentSha256: string;
	resume: ResumeTaxonomy;
	rules: RulesContext;
	projection: ProjectionTaxonomy;
}

/** A published projection rule row; the release types its enumerations as text. */
const projectionRuleRow = z.strictObject({
	discipline: z.string().min(1),
	target_kind: z.enum(['skill', 'role', 'marker']),
	target_key: z.string().min(1),
	weight: z.number().min(0).max(1),
	attestation: z.enum(['direct', 'derived']),
	requires_specialization: z.string().nullable(),
	applies_to: z.enum(['individual', 'team', 'any'])
});

export async function loadEvalTaxonomy(directory: string): Promise<EvalTaxonomy> {
	const datasets = await readTaxonomyDatasets(directory);
	const release = buildRelease(datasets);
	// Stands for the database id of the version: stable for the same content.
	const versionId = `release:${release.label}:${release.contentSha256.slice(0, 12)}`;
	const strength = datasets.fspStrength;
	const projection: ProjectionTaxonomy = {
		versionId,
		label: release.label,
		rules: release.content.fspProjectionRules.map((raw) => {
			const row = projectionRuleRow.parse(raw);
			return {
				// Stands for the row id: unique within a release by the rule's own key.
				id: `${row.discipline}/${row.applies_to}/${row.requires_specialization ?? '*'}/${row.target_kind}:${row.target_key}`,
				discipline: row.discipline,
				targetKind: row.target_kind,
				targetKey: row.target_key,
				weight: row.weight,
				attestation: row.attestation,
				requiresSpecialization: row.requires_specialization,
				appliesTo: row.applies_to
			};
		}),
		strength: {
			evskNorm: strength.evskNorm,
			rankStrength: strength.rankStrength,
			formatFactors: strength.formatFactors,
			unknownRoleFactor: strength.unknownRoleFactor
		},
		// Receipts are not measured: the projection of claims does not read them.
		receiptTemplates: new Map()
	};
	return {
		label: release.label,
		contentSha256: release.contentSha256,
		resume: buildResumeTaxonomy({
			id: versionId,
			label: release.label,
			aliases: release.content.skillAliases.map((a) => ({
				aliasNormalized: a.alias_normalized,
				skillKey: a.skill_key
			})),
			roles: release.content.roles.map((r) => ({ key: r.key, nameRu: r.name_ru }))
		}),
		rules: {
			taxonomyVersionId: versionId,
			taxonomyLabel: release.label,
			rulesetId: `ruleset:${datasets.categorizationRuleset.version}`,
			rulesetVersion: datasets.categorizationRuleset.version,
			params: datasets.categorizationRuleset.params,
			roles: datasets.roles.roles
				.map((r) => ({
					key: r.key,
					family: r.family,
					coreSkillGroups: r.coreSkillGroups,
					typicalSkills: r.typicalSkills
				}))
				.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
			skills: datasets.skills.skills
				.map((s) => ({ key: s.key, kind: s.kind, parentKey: s.parentKey }))
				.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
			grades: datasets.grades.grades
				.map((g) => ({ key: g.key, ordinal: g.ordinal }))
				.sort((a, b) => a.ordinal - b.ordinal),
			fspLevelRules: [...datasets.fspLevels.levels].sort((a, b) => (a.level < b.level ? -1 : 1))
		},
		projection
	};
}
