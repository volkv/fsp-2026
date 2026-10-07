// The reference of regions (`seeds/regions.json`) is the one list of region codes: a candidate states one of them, the
// employer catalog and the API filter by them and refuse a code it does not know instead of finding nobody, the demo
// seed stops on a region name it does not know instead of dropping the region of a candidate.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import type { AccessSubject } from '$lib/server/access/permissions';
import { auditEvents } from '$lib/server/db/schema';
import { readSeedData, seedsDirectory, type SeedData } from '$lib/server/demo/data';
import { athletePlan } from '$lib/server/demo/generate';
import type { WorldAthlete } from '$lib/server/demo/world';
import { catalogView } from '$lib/server/employer/catalog';
import { uuidv7 } from '$lib/server/ids';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { regionName, regionReference, RegionReference } from '$lib/server/regions';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createTaxonomyVersion } from '../helpers/factories';

describe('reference of regions', () => {
	it('names every subject by its code and knows codes exactly as written', async () => {
		const reference = await regionReference();
		expect(reference.regions).toHaveLength(89);
		expect(reference.regions).toContainEqual({ code: 'RU-MOW', name: 'Москва' });
		expect(reference.codeOf('Москва')).toBe('RU-MOW');
		expect(reference.has('RU-MOW')).toBe(true);
		for (const code of ['ru-mow', 'RU-XX', 'Москва', '']) expect(reference.has(code)).toBe(false);
		await expect(regionName('RU-SPE')).resolves.toBe('Санкт-Петербург');
		await expect(regionName('RU-XX')).rejects.toThrow(/RU-XX .*reference of regions/u);
	});

	it('refuses a file that gives two regions one code', () => {
		expect(
			() => new RegionReference({ description: '', regions: { Москва: 'RU-MOW', 'г. Москва': 'RU-MOW' } })
		).toThrow(/share the code RU-MOW/u);
	});
});

describe('demo seed', () => {
	let data: SeedData;
	const athlete = (region: string | null): WorldAthlete => ({
		fspId: 'FSP-TEST-1',
		lastName: 'Иванов',
		firstName: 'Иван',
		middleName: null,
		birthYear: 2002,
		region,
		email: 'athlete@example.test',
		discipline: 'algorithmic',
		specialization: null,
		officialResults: 1
	});
	const plan = (region: string | null) => athletePlan(athlete(region), data, 'regions-test', new Date(), new Map());
	const regionCodeOf = (region: string | null) => {
		const preferences = plan(region).preferences;
		return 'region_code' in preferences ? preferences.region_code : undefined;
	};

	beforeAll(async () => {
		data = await readSeedData(seedsDirectory());
	});

	it('gives an athlete the code of the region it names, and none for a region it does not state', () => {
		expect(regionCodeOf('Москва')).toBe('RU-MOW');
		expect(regionCodeOf(null)).toBeUndefined();
		expect(regionCodeOf('  ')).toBeUndefined();
	});

	it('stops on a region name the reference does not know instead of dropping it', () => {
		expect(() => plan('г. Москва')).toThrow(/«г\. Москва» of athlete FSP-TEST-1 is not in seeds\/regions\.json/u);
	});

	it('refuses seed data whose hero states a region code the reference does not know', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'seeds-'));
		try {
			await cp(seedsDirectory(), directory, { recursive: true });
			const path = join(directory, 'demo.json');
			const demo = JSON.parse(await readFile(path, 'utf8')) as {
				candidates: { preferences: { region_code: string } }[];
			};
			const hero = demo.candidates[0];
			if (!hero) throw new Error('seeds/demo.json has no candidates');
			hero.preferences.region_code = 'RU-XX';
			await writeFile(path, JSON.stringify(demo));
			await expect(readSeedData(directory)).rejects.toThrow(/region RU-XX of .* is not in seeds\/regions\.json/u);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('employer catalog page', () => {
	let database: TestDatabase;

	beforeAll(async () => {
		database = await createTestDatabase();
		await createTaxonomyVersion(database.db, { status: 'published', publishedAt: new Date() });
	});

	afterAll(async () => {
		await database.drop();
	});

	it('refuses a region code the reference does not know, without searching', async () => {
		const unreachable = () => Promise.reject(new Error('a refused query reaches no model'));
		const models: MatchingModels = { embed: unreachable, rerank: unreachable };
		const deps = {
			db: database.db,
			models,
			pseudonym: () => 'p',
			now: () => new Date(),
			testResults: GRADE_DECISION_RESULTS
		};
		const subject: AccessSubject = {
			userId: uuidv7(),
			via: 'session',
			candidate: null,
			membership: {
				memberId: uuidv7(),
				companyId: uuidv7(),
				role: 'owner',
				status: 'active',
				companyStatus: 'verified'
			},
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
		const meta = { requestId: 'regions-test', ip: null, userAgent: null };
		const url = new URL('http://app.test/company/candidates?region=RU-MOW&region=ru-spe&region=Москва');
		const view = await catalogView(deps, subject, meta, url, undefined);
		expect(view.query.regions).toEqual(['RU-MOW', 'ru-spe', 'Москва']);
		expect(view.page).toBeNull();
		expect(view.problem).toBe('Таких регионов нет в справочнике: ru-spe, Москва');
		const searched = await database.db
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.where(eq(auditEvents.action, 'catalog.searched'));
		expect(searched).toHaveLength(0);
	});
});
