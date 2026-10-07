// The figures of the landing page are read from the database: the published taxonomy and the released test banks.
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bankReleases } from '$lib/server/db/schema';
import { platformMetrics } from '$lib/server/landing/metrics';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
}, 180_000);

afterAll(async () => {
	await database.drop();
});

function release(id: string, families: number, status: 'released' | 'retired') {
	return {
		id,
		specialization: id.split('@')[0] ?? id,
		catalogVersion: '2026.10.1',
		procedureVersion: '1',
		contentSha256: 'a'.repeat(64),
		sharedSha256: 'b'.repeat(64),
		manifest: { families: Array.from({ length: families }, (_, index) => ({ key: `f${index}` })) },
		status,
		releasedAt: new Date('2026-10-01T00:00:00Z'),
		retiredAt: status === 'retired' ? new Date('2026-10-02T00:00:00Z') : null
	};
}

describe('platform metrics of the landing page', () => {
	it('shows nothing the database does not have yet', async () => {
		expect(await platformMetrics(database.db)).toEqual({ taxonomy: null, taskFamilies: 0 });
	});

	it('counts the roles and skills of the published taxonomy and the families of the released banks only', async () => {
		const datasets = await readTaxonomyDatasets(TAXONOMY_DIR);
		const client = postgres(database.url, { max: 1, onnotice: () => {} });
		try {
			await publishTaxonomy(client, buildRelease(datasets));
		} finally {
			await client.end({ timeout: 5 });
		}
		await database.db
			.insert(bankReleases)
			.values([
				release('backend@2026.10.1-1', 5, 'retired'),
				release('backend@2026.10.1-2', 7, 'released'),
				release('frontend@2026.10.1-1', 4, 'released')
			]);
		expect(await platformMetrics(database.db)).toEqual({
			taxonomy: { roles: datasets.roles.roles.length, skills: datasets.skills.skills.length },
			taskFamilies: 11
		});
	});
});
