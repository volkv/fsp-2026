import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaxonomyDatasets } from '$lib/server/taxonomy/datasets';
import { buildSkillIndex, matchSkill } from '$lib/server/taxonomy/normalize';
import { publishTaxonomy, type PublishOutcome } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets, TaxonomyError, type TaxonomyRelease } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { expectDbError, SQLSTATE } from '../helpers/errors';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));

const CONTENT_TABLES = {
	roles: 'roles',
	skills: 'skills',
	skillAliases: 'skill_aliases',
	grades: 'grades',
	workFormats: 'work_formats',
	fspProjectionRules: 'fsp_projection_rules',
	fspLevelRules: 'fsp_level_rules',
	receiptTemplates: 'receipt_templates',
	salaryReferences: 'salary_references'
} as const;

let database: TestDatabase;
/** A client without the parsers and serializers Drizzle installs: the configuration of the seed script. */
let client: postgres.Sql;
let datasets: TaxonomyDatasets;
let release: TaxonomyRelease;
let first: PublishOutcome;

beforeAll(async () => {
	database = await createTestDatabase();
	client = postgres(database.url, { max: 4, onnotice: () => {} });
	datasets = await readTaxonomyDatasets(TAXONOMY_DIR);
	release = buildRelease(datasets);
	first = await publishTaxonomy(client, release);
});

afterAll(async () => {
	await client.end({ timeout: 5 });
	await database.drop();
});

/** The repository release with changes applied to a copy of its datasets. */
function changedRelease(change: (copy: TaxonomyDatasets) => void): TaxonomyRelease {
	const copy = structuredClone(datasets);
	change(copy);
	return buildRelease(copy);
}

/** A label after the repository release, `offset` releases later in the same month. */
function laterLabel(offset: number): string {
	const [year, month, number] = release.label.split('.');
	return `${year}.${month}.${Number(number) + offset}`;
}

/** A categorization rule set version after the repository release. */
function laterRuleset(offset: number): number {
	return release.ruleset.version + offset;
}

/** A match rule set version after the repository release. */
function laterMatchRuleset(offset: number): number {
	return release.matchRuleset.version + offset;
}

async function expectTaxonomyError(operation: Promise<unknown>, code: TaxonomyError['code']): Promise<void> {
	const failure = await operation.then(
		() => undefined,
		(error: unknown) => error
	);
	expect(failure).toBeInstanceOf(TaxonomyError);
	expect((failure as TaxonomyError).code).toBe(code);
}

async function rowCounts(versionId: string): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const [name, table] of Object.entries(CONTENT_TABLES)) {
		const [row] = await database.sql<{ count: number }[]>`
			select count(*)::int as count from ${database.sql(table)} where taxonomy_version_id = ${versionId}
		`;
		counts[name] = row?.count ?? 0;
	}
	return counts;
}

describe('taxonomy publication', () => {
	it('publishes the release into an empty database', async () => {
		expect(first).toMatchObject({
			label: release.label,
			taxonomy: 'published',
			contentSha256: release.contentSha256,
			ruleset: { version: release.ruleset.version, outcome: 'created' },
			matchRuleset: { version: release.matchRuleset.version, outcome: 'created' }
		});

		const [version] = await database.sql<{ status: string; published: boolean }[]>`
			select status, published_at is not null as published from taxonomy_versions where id = ${first.taxonomyVersionId}
		`;
		expect(version).toEqual({ status: 'published', published: true });

		const expected = Object.fromEntries(
			Object.keys(CONTENT_TABLES).map((name) => [name, release.content[name as keyof typeof CONTENT_TABLES].length])
		);
		expect(await rowCounts(first.taxonomyVersionId)).toEqual(expected);

		const [strength] = await database.sql<{ unknown_role_factor: string }[]>`
			select unknown_role_factor from fsp_strength_params where taxonomy_version_id = ${first.taxonomyVersionId}
		`;
		expect(Number(strength?.unknown_role_factor)).toBe(datasets.fspStrength.unknownRoleFactor);

		const [types] = await database.sql<Record<string, string>[]>`
			select
				(select jsonb_typeof(sources) from taxonomy_versions where id = ${first.taxonomyVersionId}) as sources,
				(select jsonb_typeof(core_skill_groups) from roles where taxonomy_version_id = ${first.taxonomyVersionId} limit 1)
					as core_skill_groups,
				(select jsonb_typeof(evsk_norm) from fsp_strength_params where taxonomy_version_id = ${first.taxonomyVersionId})
					as evsk_norm,
				(select jsonb_typeof(params) from categorization_rulesets where version = ${release.ruleset.version}) as params
		`;
		expect(types).toEqual({ sources: 'object', core_skill_groups: 'array', evsk_norm: 'object', params: 'object' });
		// What a receipt does not assert is stored by the kind of a result and the role, as the file states it.
		const [limits] = await database.sql<{ does_not_assert: unknown }[]>`
			select does_not_assert from receipt_templates
			where taxonomy_version_id = ${first.taxonomyVersionId} and source = 'fsp' and fact_type = 'competition_result'
		`;
		expect(limits?.does_not_assert).toEqual(
			datasets.receiptTemplates.templates.find((t) => t.source === 'fsp' && t.factType === 'competition_result')
				?.doesNotAssert
		);

		const [ruleset] = await database.sql<{ taxonomy_version_id: string }[]>`
			select taxonomy_version_id from categorization_rulesets where version = ${release.ruleset.version}
		`;
		expect(ruleset?.taxonomy_version_id).toBe(first.taxonomyVersionId);
		const [matchRuleset] = await database.sql<{ taxonomy_version_id: string; params: unknown }[]>`
			select taxonomy_version_id, params from match_rulesets where version = ${release.matchRuleset.version}
		`;
		expect(matchRuleset).toEqual({
			taxonomy_version_id: first.taxonomyVersionId,
			params: datasets.matchRuleset.params
		});

		// External codes of a role are lists, the main code first.
		const [role] = await database.sql<{ hh_role_id: string[]; habr_spec: string[]; prof_standard: string[] }[]>`
			select hh_role_id, habr_spec, prof_standard from roles
			where taxonomy_version_id = ${first.taxonomyVersionId} and key = 'business_analyst'
		`;
		expect(role).toEqual({
			hh_role_id: ['150', '10'],
			habr_spec: ['business_analyst'],
			prof_standard: ['06.022', '06.015']
		});
	});

	it('treats a repeated publication of the same release as a no-op', async () => {
		const before = await rowCounts(first.taxonomyVersionId);
		const again = await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
		expect(again).toEqual({
			...first,
			taxonomy: 'unchanged',
			ruleset: { version: release.ruleset.version, outcome: 'unchanged' },
			matchRuleset: { version: release.matchRuleset.version, outcome: 'unchanged' }
		});
		expect(await rowCounts(first.taxonomyVersionId)).toEqual(before);
		const [versions] = await database.sql<{ count: number }[]>`select count(*)::int as count from taxonomy_versions`;
		expect(versions?.count).toBe(1);
	});

	it('refuses changed content under a published label and keeps the stored version', async () => {
		const changed = changedRelease((copy) => {
			const grade = copy.grades.grades[0];
			if (!grade) throw new Error('no grades');
			grade.name = 'Стажёр-исследователь';
		});
		expect(changed.label).toBe(release.label);

		await expectTaxonomyError(publishTaxonomy(client, changed), 'version_changed');

		const names = await database.sql<{ name: string }[]>`
			select name from grades where taxonomy_version_id = ${first.taxonomyVersionId} order by ordinal
		`;
		expect(names.map((g) => g.name)).toEqual(datasets.grades.grades.map((g) => g.name));
	});

	it('refuses changed rule set parameters under the same rule set version', async () => {
		const changed = changedRelease((copy) => {
			copy.categorizationRuleset.params.strengthBands.strong = 0.7;
		});
		expect(changed.contentSha256).toBe(release.contentSha256);
		await expectTaxonomyError(publishTaxonomy(client, changed), 'ruleset_changed');
	});

	it('refuses changed match rule set parameters under the same match rule set version', async () => {
		const changed = changedRelease((copy) => {
			copy.matchRuleset.params.poolThreshold = 0.6;
		});
		expect(changed.contentSha256).toBe(release.contentSha256);
		await expectTaxonomyError(publishTaxonomy(client, changed), 'match_ruleset_changed');
		const [stored] = await database.sql<{ threshold: number }[]>`
			select (params->>'poolThreshold')::float8 as threshold from match_rulesets
			where version = ${release.matchRuleset.version}
		`;
		expect(stored?.threshold).toBe(datasets.matchRuleset.params.poolThreshold);
	});

	it('refuses a new taxonomy version bound to an existing match rule set version and writes nothing', async () => {
		const changed = changedRelease((copy) => {
			copy.release.label = laterLabel(80);
			copy.categorizationRuleset.version = laterRuleset(80);
		});
		await expectTaxonomyError(publishTaxonomy(client, changed), 'match_ruleset_changed');
		expect(await database.sql`select 1 from taxonomy_versions where label = ${laterLabel(80)}`).toHaveLength(0);
		expect(await database.sql`select 1 from categorization_rulesets where version = ${laterRuleset(80)}`).toHaveLength(
			0
		);
	});

	it('refuses a new taxonomy version bound to an existing rule set version and writes nothing', async () => {
		const changed = changedRelease((copy) => {
			copy.release.label = laterLabel(90);
		});
		await expectTaxonomyError(publishTaxonomy(client, changed), 'ruleset_changed');
		const rows = await database.sql`select 1 from taxonomy_versions where label = ${laterLabel(90)}`;
		expect(rows).toHaveLength(0);
	});

	it('publishes a changed release under a new label next to the old version', async () => {
		const changed = changedRelease((copy) => {
			copy.release.label = laterLabel(1);
			copy.categorizationRuleset.version = laterRuleset(1);
			copy.matchRuleset.version = laterMatchRuleset(1);
			const grade = copy.grades.grades[0];
			if (!grade) throw new Error('no grades');
			grade.name = 'Стажёр-исследователь';
		});
		const outcome = await publishTaxonomy(client, changed);
		expect(outcome).toMatchObject({
			label: laterLabel(1),
			taxonomy: 'published',
			ruleset: { version: laterRuleset(1), outcome: 'created' },
			matchRuleset: { version: laterMatchRuleset(1), outcome: 'created' }
		});
		expect(outcome.taxonomyVersionId).not.toBe(first.taxonomyVersionId);

		const versions = await database.sql<{ label: string; status: string }[]>`
			select label, status from taxonomy_versions order by published_at
		`;
		expect(versions).toEqual([
			{ label: release.label, status: 'published' },
			{ label: laterLabel(1), status: 'published' }
		]);
	});

	it('serializes concurrent publications of one release', async () => {
		const changed = changedRelease((copy) => {
			copy.release.label = laterLabel(2);
			copy.categorizationRuleset.version = laterRuleset(2);
			copy.matchRuleset.version = laterMatchRuleset(2);
		});
		const [one, other] = await Promise.all([publishTaxonomy(client, changed), publishTaxonomy(client, changed)]);
		expect([one.taxonomy, other.taxonomy].sort()).toEqual(['published', 'unchanged']);
		expect(one.taxonomyVersionId).toBe(other.taxonomyVersionId);
	});
});

describe('published taxonomy', () => {
	it('rejects changes to its rows', async () => {
		const { sql } = database;
		const id = first.taxonomyVersionId;
		await expectDbError(
			sql`update skills set name = 'Golang' where taxonomy_version_id = ${id} and key = 'go'`,
			SQLSTATE.restrictViolation
		);
		await expectDbError(
			sql`insert into skill_aliases (taxonomy_version_id, alias_normalized, skill_key) values (${id}, 'гоша', 'go')`,
			SQLSTATE.restrictViolation
		);
		await expectDbError(
			sql`delete from fsp_projection_rules where taxonomy_version_id = ${id}`,
			SQLSTATE.restrictViolation
		);
		await expectDbError(
			sql`update fsp_strength_params set unknown_role_factor = 1 where taxonomy_version_id = ${id}`,
			SQLSTATE.restrictViolation
		);
	});

	it('rejects changes to the version itself and to its rule set', async () => {
		const { sql } = database;
		const id = first.taxonomyVersionId;
		await expectDbError(sql`update taxonomy_versions set label = 'x' where id = ${id}`, SQLSTATE.restrictViolation);
		await expectDbError(
			sql`update taxonomy_versions set status = 'draft', published_at = null where id = ${id}`,
			SQLSTATE.restrictViolation
		);
		await expectDbError(sql`delete from taxonomy_versions where id = ${id}`, SQLSTATE.restrictViolation);
		await expectDbError(
			sql`update categorization_rulesets set params = '{}' where taxonomy_version_id = ${id}`,
			SQLSTATE.restrictViolation
		);
		await expectDbError(
			sql`update match_rulesets set params = '{}' where taxonomy_version_id = ${id}`,
			SQLSTATE.restrictViolation
		);
	});

	it('normalizes skill mentions with its stored dictionary', async () => {
		const aliases = await database.sql<{ alias_normalized: string; skill_key: string }[]>`
			select alias_normalized, skill_key from skill_aliases where taxonomy_version_id = ${first.taxonomyVersionId}
		`;
		const index = buildSkillIndex(aliases.map((a) => ({ aliasNormalized: a.alias_normalized, skillKey: a.skill_key })));

		expect(matchSkill(index, 'Golang')).toMatchObject({ method: 'alias', skillKey: 'go' });
		expect(matchSkill(index, 'Си плюс плюс')).toMatchObject({ method: 'alias', skillKey: 'cpp' });
		expect(matchSkill(index, 'C#')).toMatchObject({ method: 'alias', skillKey: 'csharp' });
		expect(matchSkill(index, 'javascrpit')).toMatchObject({ method: 'fuzzy', skillKey: 'javascript' });
		expect(matchSkill(index, 'mxsql')).toMatchObject({
			method: 'unknown',
			skillKey: null,
			alternatives: [
				{ skillKey: 'mssql', score: 0.8 },
				{ skillKey: 'mysql', score: 0.8 }
			]
		});
		expect(matchSkill(index, 'Blorptech 3000')).toMatchObject({
			method: 'unknown',
			skillKey: null,
			normalized: 'blorptech 3000',
			alternatives: []
		});
	});
});

// `taxonomy/released.json` is the manifest of the release currently live on the shared stand: label and rule set
// versions, updated by hand once a new release is confirmed deployed there. A label bump under the repository's files
// with no matching rule set bump is exactly what `storeRuleset` refuses when seeding over that stand (`ruleset_changed`
// / `match_ruleset_changed`): the new label reuses a rule set version already bound to the old taxonomy version.
describe('release checkpoint', () => {
	it('bumps both rule set versions whenever the label differs from the deployed release', async () => {
		const released = JSON.parse(await readFile(join(TAXONOMY_DIR, 'released.json'), 'utf8')) as {
			label: string;
			categorizationRulesetVersion: number;
			matchRulesetVersion: number;
		};

		if (release.label === released.label) {
			expect(release.ruleset.version).toBe(released.categorizationRulesetVersion);
			expect(release.matchRuleset.version).toBe(released.matchRulesetVersion);
			return;
		}
		expect(release.ruleset.version).toBeGreaterThan(released.categorizationRulesetVersion);
		expect(release.matchRuleset.version).toBeGreaterThan(released.matchRulesetVersion);
	});
});
