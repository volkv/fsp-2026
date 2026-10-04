// The candidate's search terms against the database (docs/domain.md, sections 7.1, 17.1): the region is checked
// against the reference of regions, and a change of it moves `profile_revision` and enqueues the matches like any
// other term.
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { updateProfileSettings } from '$lib/server/candidates/settings';
import { candidates, jobs } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { regionReference } from '$lib/server/regions';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
}, 180_000);

afterAll(async () => {
	await database.drop();
});

async function candidateWithSubject() {
	const candidate = await createCandidate(database.db);
	const subject: AccessSubject = {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	const state = async () => {
		const [row] = await database.db
			.select({ revision: candidates.profileRevision, preferences: candidates.preferences })
			.from(candidates)
			.where(eq(candidates.id, candidate.id));
		if (!row) throw new Error('candidate is missing');
		return row;
	};
	const matchKey = and(eq(jobs.type, 'match.refresh'), eq(jobs.dedupKey, `match:candidate:${candidate.id}`));
	const matchJobs = () => database.db.select({ inputVersion: jobs.inputVersion }).from(jobs).where(matchKey);
	/** The refresh has run: the next change queues a new one. */
	const runMatches = () =>
		database.db.update(jobs).set({ status: 'succeeded', finishedAt: new Date() }).where(matchKey);
	return { subject, state, matchJobs, runMatches };
}

describe('the region of the candidate', () => {
	it('is read from the reference of regions, by name', async () => {
		const { regions } = await regionReference();
		expect(regions.length).toBeGreaterThan(0);
		expect(regions).toContainEqual({ code: 'RU-MOW', name: 'Москва' });
		expect(new Set(regions.map((region) => region.code)).size).toBe(regions.length);
		const names = regions.map((region) => region.name);
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'ru')));
	});

	it('refuses a code the reference does not know and leaves the profile as it was', async () => {
		const { subject, state, matchJobs } = await candidateWithSubject();
		const before = await state();

		const refusal = await updateProfileSettings(database.db, subject, {
			preferences: { region_code: 'RU-XXX' },
			desiredRoleKeys: []
		}).catch((cause: unknown) => cause);

		expect(refusal).toBeInstanceOf(ApiError);
		expect(refusal).toMatchObject({
			code: 'validation_failed',
			details: [{ path: 'region_code', code: 'unknown', message: 'Такого региона нет в справочнике' }]
		});
		expect(await state()).toEqual(before);
		expect(await matchJobs()).toEqual([]);
	});

	it('is stored when known, and every change moves the revision and enqueues the matches', async () => {
		const { subject, state, matchJobs, runMatches } = await candidateWithSubject();
		const before = await state();

		await updateProfileSettings(database.db, subject, { preferences: { region_code: 'RU-TA' }, desiredRoleKeys: [] });
		const stated = await state();
		expect(stated.preferences).toEqual({ region_code: 'RU-TA' });
		expect(stated.revision).toBe(before.revision + 1);
		expect(await matchJobs()).toEqual([{ inputVersion: String(stated.revision) }]);

		// Taking the region away is a change as well; the matches still waiting are joined — they read the profile when
		// they run — and a new refresh is queued once they have run.
		await updateProfileSettings(database.db, subject, { preferences: {}, desiredRoleKeys: [] });
		const cleared = await state();
		expect(cleared.preferences).toEqual({});
		expect(cleared.revision).toBe(stated.revision + 1);
		expect(await matchJobs()).toEqual([{ inputVersion: String(stated.revision) }]);
		await runMatches();
		await updateProfileSettings(database.db, subject, { preferences: { region_code: 'RU-MOW' }, desiredRoleKeys: [] });
		const moved = await state();
		expect(moved.revision).toBe(cleared.revision + 1);
		expect(await matchJobs()).toContainEqual({ inputVersion: String(moved.revision) });
	});
});
