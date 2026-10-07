// Publication of the product policies (`scripts/seed-policies.ts`): every policy the modules read is in force after the
// seed, a repeat changes nothing, a published version is never edited.
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishPolicies, readPolicyRelease, type PolicyVersion } from '../../scripts/seed-policies';
import { assessmentPolicy } from '$lib/server/assessments/policy';
import { minorsAllowed } from '$lib/server/auth/age';
import { productPolicies } from '$lib/server/db/schema';
import { requiredPolicy } from '$lib/server/invitations/policies';
import { currentRetentionPolicy } from '$lib/server/jobs/retention';
import { loadMarketPolicy } from '$lib/server/market/policy';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import { loadMatchStoragePolicy } from '$lib/server/matching/storage';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

const POLICIES_DIR = fileURLToPath(new URL('../../policies', import.meta.url));

let database: TestDatabase;
let client: postgres.Sql;
let release: PolicyVersion[];

beforeAll(async () => {
	database = await createTestDatabase();
	client = postgres(database.url, { max: 1, onnotice: () => {} });
	release = await readPolicyRelease(POLICIES_DIR);
});

afterAll(async () => {
	await client.end({ timeout: 5 });
	await database.drop();
});

describe('product policies seed', () => {
	it('publishes every policy the modules read, then changes nothing on repeat', async () => {
		// A policy may have several versions: the release is the set of (kind, version) the files state.
		expect(release.map((p) => `${p.kind} v${p.version}`).sort()).toEqual([
			'assessment_policy v1',
			'catalog_policy v1',
			'catalog_policy v2',
			'challenge_policy v1',
			'hiring_policy v1',
			'invitation_policy v1',
			'market_policy v1',
			'matching_policy v1',
			'minor_policy v1',
			'notification_policy v1',
			'retention_policy v1',
			'retention_policy v2',
			'retention_policy v3'
		]);
		const first = await publishPolicies(client, release);
		expect(first.map((p) => `${p.kind} v${p.version} ${p.outcome}`).sort()).toEqual(
			release.map((p) => `${p.kind} v${p.version} published`).sort()
		);
		const second = await publishPolicies(client, release);
		expect(second.every((p) => p.outcome === 'unchanged')).toBe(true);
		expect(await database.db.select().from(productPolicies)).toHaveLength(release.length);

		const now = new Date();
		expect((await requiredPolicy(database.db, 'invitation_policy', now)).params.response_window_hours).toBe(72);
		expect((await requiredPolicy(database.db, 'hiring_policy', now)).params.stages).toHaveLength(4);
		// The catalog policy in force states the salary intervals of the cohort answers (domain 13.10).
		expect((await requiredPolicy(database.db, 'catalog_policy', now)).params).toEqual({
			small_count_threshold: 5,
			salary_bins: [
				{ until: 300_000, step: 25_000 },
				{ until: 600_000, step: 50_000 },
				{ until: null, step: 100_000 }
			]
		});
		expect(await minorsAllowed(database.db, now)).toBe(true);
		expect(await loadMarketPolicy(database.db, now)).toMatchObject({
			windowDays: 30,
			threshold: { candidate_expectations: 5, vacancy_ranges: 5, external_reference: 5 }
		});
		// The store threshold fits the rule set the product ships: it is not above its pool threshold.
		const shipped = {
			id: 'shipped',
			version: shippedMatchRuleset.version,
			params: matchRulesetParamsSchema.parse(shippedMatchRuleset.params)
		};
		expect(await loadMatchStoragePolicy(database.db, shipped, now)).toMatchObject({
			version: 1,
			storeThreshold: 0.3
		});
		// Of the versions in effect from the same moment, the latest one applies: the terms of demo sessions, the notice
		// before the removal for inactivity and the retention of batch files are there.
		expect(await currentRetentionPolicy(database.db)).toEqual({
			audit_retention_months: 36,
			disclosure_retention_months: 36,
			inactive_candidate_purge_days: 730,
			demo_session_hours: 24,
			demo_own_resume_hours: 24,
			inactivity_notice_days: 30,
			fsp_batch_retention_days: 90
		});
		expect((await assessmentPolicy(database.db, now)).params).toEqual({ artifact_retention_days: 365 });
	});

	it('refuses a published version with other parameters: a change is a new version', async () => {
		const changed = release.map((p) =>
			p.kind === 'catalog_policy' && p.version === 1 ? { ...p, params: { small_count_threshold: 3 } } : p
		);
		await expect(publishPolicies(client, changed)).rejects.toThrow(/catalog_policy v1 is published with other/);
		const [catalog] = await database.db
			.select({ params: productPolicies.params })
			.from(productPolicies)
			.where(and(eq(productPolicies.kind, 'catalog_policy'), eq(productPolicies.version, 1)));
		expect(catalog?.params).toEqual({ small_count_threshold: 5 });
	});
});
