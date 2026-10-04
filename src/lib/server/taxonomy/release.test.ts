import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { DATASET_FILES, datasetSchemas, type DatasetName } from './datasets';
import { buildRelease, contentHash, parseTaxonomyDatasets, readTaxonomyDatasets } from './release';

const TAXONOMY_DIR = fileURLToPath(new URL('../../../../taxonomy', import.meta.url));

/** The files as JSON: the input side of the schemas. */
type RawDatasets = { [K in DatasetName]: z.input<(typeof datasetSchemas)[K]> };

let original: RawDatasets;

beforeAll(async () => {
	const entries = await Promise.all(
		(Object.entries(DATASET_FILES) as [DatasetName, string][]).map(
			async ([name, file]) => [name, JSON.parse(await readFile(join(TAXONOMY_DIR, file), 'utf8'))] as const
		)
	);
	original = Object.fromEntries(entries) as RawDatasets;
});

/** A deep copy of the release files with one change applied. */
function variant(change: (raw: RawDatasets) => void): RawDatasets {
	const copy = structuredClone(original);
	change(copy);
	return copy;
}

function item<T>(items: T[], index: number): T {
	const value = items[index];
	if (value === undefined) throw new Error(`no item ${index}`);
	return value;
}

function firstRule(raw: RawDatasets) {
	return item(raw.fspProjection.ruleGroups, 0);
}

function roleRule(raw: RawDatasets) {
	const group = raw.fspProjection.ruleGroups.find((g) => g.targets.role !== undefined);
	if (group === undefined) throw new Error('no rule group targets a role');
	return group;
}

function releaseOf(raw: RawDatasets) {
	return buildRelease(parseTaxonomyDatasets(raw));
}

describe('taxonomy release in the repository', () => {
	it('is valid and holds every dataset', async () => {
		const release = buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR));
		expect(release.label).toMatch(/^\d{4}\.\d{2}\.\d+$/);
		expect(release.contentSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(release.content.roles.length).toBeGreaterThan(0);
		expect(release.content.skills.length).toBeGreaterThan(0);
		expect(release.content.skillAliases.length).toBeGreaterThan(release.content.skills.length);
		expect(release.content.fspProjectionRules.length).toBeGreaterThan(0);
		expect(release.content.fspLevelRules.map((l) => l.level).sort()).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
	});

	it('names the unmanned aircraft discipline uas and keeps the uav skill', () => {
		const release = releaseOf(original);
		const uas = release.content.fspProjectionRules.filter((r) => r.discipline === 'uas');
		expect(uas).toContainEqual(expect.objectContaining({ target_kind: 'skill', target_key: 'uav' }));
		expect(release.content.fspProjectionRules.some((r) => r.discipline === 'uav')).toBe(false);
	});

	it('derives a role only from a personal specialization in a team', () => {
		// A result without a specialization tells how strong a participant is and in which skills, not what work they do.
		const roleRules = releaseOf(original).content.fspProjectionRules.filter((r) => r.target_kind === 'role');
		expect(roleRules.length).toBeGreaterThan(0);
		expect(roleRules.filter((r) => r.requires_specialization === null || r.applies_to !== 'team')).toEqual([]);
		expect(roleRules.filter((r) => r.discipline === 'algorithmic')).toEqual([]);
	});

	it('never confirms anything directly from a team result and derives teamwork without a badge', () => {
		const rules = releaseOf(original).content.fspProjectionRules;
		expect(rules.filter((r) => r.attestation === 'direct' && r.applies_to !== 'individual')).toEqual([]);
		const teamwork = rules.filter((r) => r.target_key === 'teamwork');
		expect(teamwork.length).toBeGreaterThan(0);
		expect(teamwork.every((r) => r.attestation === 'derived' && r.applies_to === 'team')).toBe(true);
	});

	it('keeps every external code of a role, the main one first', () => {
		const roles = new Map(releaseOf(original).content.roles.map((r) => [r.key, r]));
		expect(roles.get('business_analyst')).toMatchObject({
			hh_role_id: ['150', '10'],
			prof_standard: ['06.022', '06.015']
		});
		expect(roles.get('security_engineer')?.habr_spec).toEqual([
			'security_engineer',
			'infosecspec',
			'security_administrator',
			'Infosec_architect'
		]);
		expect(roles.get('team_lead')?.habr_spec).toEqual([]);
		expect(roles.get('tech_support')?.prof_standard).toEqual([]);
	});

	it('keeps stack premiums as separate estimated rows', () => {
		const references = releaseOf(original).content.salaryReferences;
		const estimated = references.filter((r) => r.method === 'estimated_stack_adjustment');
		expect(estimated.length).toBeGreaterThan(0);
		expect(estimated.every((r) => r.skill_key !== null && r.p25 === null && r.p75 === null)).toBe(true);
		expect(references.filter((r) => r.method === 'observed_median').every((r) => r.skill_key === null)).toBe(true);
	});
});

describe('content hash', () => {
	it('does not depend on the order of rows or keys', () => {
		const release = releaseOf(original);
		const reordered = {
			...release.content,
			skills: [...release.content.skills].reverse(),
			grades: release.content.grades.map((g) => ({ name: g.name, ordinal: g.ordinal, key: g.key }))
		};
		expect(contentHash(reordered)).toBe(release.contentSha256);
	});

	it('changes with any value', () => {
		const changed = releaseOf(
			variant((raw) => {
				item(raw.grades.grades, 0).name = 'Стажёр-исследователь';
			})
		);
		expect(changed.contentSha256).not.toBe(releaseOf(original).contentSha256);
	});

	it('keeps the hash of published content: a changed algorithm would refuse every published label', () => {
		const content: Parameters<typeof contentHash>[0] = {
			sources: { rosstat: { url: 'https://rosstat.gov.ru', year: 2025 } },
			roles: [
				{ code: 'backend', title: 'Бэкенд', parents: ['dev'], weight: 0.5 },
				{ code: 'analyst', title: 'Аналитик', parents: [], weight: 1 }
			],
			skills: [],
			skillAliases: [],
			grades: [],
			workFormats: [],
			fspProjectionRules: [],
			fspStrengthParams: { base: 1, decay: null },
			fspLevelRules: [],
			receiptTemplates: [],
			salaryReferences: []
		};
		expect(contentHash(content)).toBe('743933f165605609dcfd8777deb23535dfe538ea9d57f3c63dc0c48c9db4769c');
	});
});

describe('validation', () => {
	it.each<[string, (raw: RawDatasets) => void, RegExp]>([
		[
			'an unknown skill in a projection rule',
			(raw) => {
				firstRule(raw).targets.skill = { ...firstRule(raw).targets.skill, telepathy: 0.5 };
			},
			/fsp-projection\.json: algorithmic: unknown skill telepathy/
		],
		[
			'a direct attestation of a team result',
			(raw) => {
				firstRule(raw).appliesTo = 'team';
			},
			/direct attestation applies to individual results only/
		],
		[
			'a direct attestation of a role',
			(raw) => {
				firstRule(raw).targets.role = { algo_engineer: 1 };
			},
			/roles and markers are derived only/
		],
		[
			'a role target without a specialization',
			(raw) => {
				roleRule(raw).requiresSpecialization = null;
			},
			/role \w+ requires a specialization/
		],
		[
			'the old discipline code of unmanned aircraft',
			(raw) => {
				Object.assign(firstRule(raw), { discipline: 'uav' });
			},
			/fsp-projection\.json ruleGroups\.0\.discipline/
		],
		[
			'limits by the kind of a result on a fact that has none',
			(raw) => {
				const qualification = raw.receiptTemplates.templates.find((t) => t.factType === 'qualification');
				qualification?.doesNotAssert.team.push('личный вклад в командное решение');
			},
			/fsp\/qualification: limits by team, personal result or role apply to FSP competition results only/
		],
		[
			'a receipt template without limits of every receipt',
			(raw) => {
				item(raw.receiptTemplates.templates, 0).doesNotAssert.all = [];
			},
			/receipt-templates\.json templates\.0\.doesNotAssert\.all/
		],
		[
			'a spelling shared by two skills',
			(raw) => {
				raw.skills.skills.find((s) => s.key === 'java')?.aliases.push('JS');
			},
			/spelling "js" belongs to both/
		],
		[
			'a weight the database would round',
			(raw) => {
				firstRule(raw).targets.skill = { ...firstRule(raw).targets.skill, algorithms: 0.8125 };
			},
			/must have at most 3 decimals/
		],
		[
			'an unknown format weighing more than an online qualifier',
			(raw) => {
				raw.fspStrength.formatFactors.unknown = 1;
			},
			/unknown factor must equal the online qualifier factor/
		],
		[
			'FSP achievements shifting a grade',
			(raw) => {
				Object.assign(raw.categorizationRuleset.params.grade, { fspAffectsGrade: true });
			},
			/params\.grade\.fspAffectsGrade/
		],
		[
			'FSP team roles as a source of responsibility markers for the grade',
			(raw) => {
				Object.assign(raw.categorizationRuleset.params.grade, { responsibilityMarkerSources: ['resume', 'fsp'] });
			},
			/params\.grade\.responsibilityMarkerSources/
		],
		[
			'a global ranking of sources instead of relevance to the claim',
			(raw) => {
				Object.assign(raw.categorizationRuleset.params.evidence, { weighting: 'most_trusted_source_wins' });
			},
			/params\.evidence\.weighting/
		],
		[
			'a gap between experience bands',
			(raw) => {
				item(raw.categorizationRuleset.params.grade.experienceBands, 1).fromMonths = 7;
			},
			/experience band 1 must start at 6 months/
		],
		[
			'an observed salary row with a skill',
			(raw) => {
				item(raw.salaryReferences.references, 0).skillKey = 'python';
			},
			/observed rows have no skill/
		],
		[
			'a repeated external code of a role',
			(raw) => {
				item(raw.roles.roles, 0).profStandards.push('06.001');
			},
			/roles\.json roles\.0\.profStandards: must not repeat a code/
		],
		[
			'a skill of Codeforces absent from the taxonomy',
			(raw) => {
				raw.categorizationRuleset.params.evidence.publicProfiles.codeforces.skills.push('telepathy');
			},
			/public profiles: Codeforces confirms unknown skill telepathy/
		],
		[
			'a GitHub language mapped to an unknown skill',
			(raw) => {
				raw.categorizationRuleset.params.evidence.publicProfiles.github.languages.Brainfuck = 'brainfuck';
			},
			/public profiles: GitHub language Brainfuck confirms unknown skill brainfuck/
		],
		[
			'a GitHub language weighing as much as a platform test',
			(raw) => {
				const { evidence } = raw.categorizationRuleset.params;
				evidence.publicProfiles.github.weight = evidence.claimWeights.platformTest;
			},
			/a GitHub language must weigh less than a platform test/
		],
		[
			'Codeforces thresholds out of order',
			(raw) => {
				item(raw.categorizationRuleset.params.evidence.publicProfiles.codeforces.ratingStrength, 2).fromRating = 100;
			},
			/thresholds must ascend/
		],
		[
			'an unknown field',
			(raw) => {
				Object.assign(item(raw.grades.grades, 0), { salary: 1 });
			},
			/grades\.json grades\.0/
		]
	])('rejects %s', (_, change, message) => {
		expect(() => releaseOf(variant(change))).toThrow(message);
	});
});
