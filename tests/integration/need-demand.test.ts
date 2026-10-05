// «Спрос» for the candidate (CONCEPT 4): the active needs of companies within reach that match the candidate's category —
// the specialization and the grade inside the range of the need — counted with the small-count threshold, the median
// range of their salaries by tax base and the skills they require; a need of another category, a closed one, one of a
// suspended company or of another demo session is not counted.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { needDemand } from '$lib/server/candidates/need-demand';
import { demoSessions, hiringNeeds, productPolicies } from '$lib/server/db/schema';
import type { NeedForm } from '$lib/server/needs/form';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCompany, createMember } from '../helpers/factories';
import { DAY, contactWorld, employer, person, type ContactWorld } from '../helpers/contact';

let database: TestDatabase;
let world: ContactWorld;

beforeAll(async () => {
	database = await createTestDatabase();
	world = await contactWorld(database, ['backend']);
	await database.db.insert(productPolicies).values({
		kind: 'market_policy',
		version: 1,
		params: { window_days: 30, min_sample: 5 },
		effectiveFrom: new Date(Date.now() - 30 * DAY)
	});
});

afterAll(async () => {
	await database.drop();
});

async function need(companyId: string, memberId: string, form: NeedForm, status: 'active' | 'closed' = 'active') {
	await database.db.insert(hiringNeeds).values({
		companyId,
		createdByMemberId: memberId,
		form,
		textCheck: { validator_version: 'test', result: 'clean', phrases: [], warnings_confirmed: null, moderation: null },
		status
	});
}

const salary = (min: number, max: number, taxBase: 'gross' | 'net' = 'gross') => ({
	min,
	max,
	currency: 'RUB' as const,
	period: 'month' as const,
	tax_base: taxBase
});

describe('the demand of the candidate’s category', () => {
	it('counts the matching needs with a threshold, the median range and the skills', async () => {
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		expect((await needDemand(database.db, candidate.subject, new Date())).status).toBe('available');

		const { company, member } = await employer(database.db);
		const base = { skill_keys: ['go', 'postgresql'], nice_skill_keys: [] };
		await need(company.id, member.id, {
			...base,
			specialization: 'backend',
			grade: { min: 'middle', max: 'middle' },
			salary: salary(200_000, 260_000)
		});
		await need(company.id, member.id, {
			...base,
			specialization: 'backend',
			grade: { min: 'junior', max: 'senior' },
			salary: salary(220_000, 300_000)
		});
		await need(company.id, member.id, { ...base, specialization: 'backend', salary: salary(250_000, 320_000) });
		// Not the category: another grade range, another specialization, a closed need.
		await need(company.id, member.id, { ...base, specialization: 'backend', grade: { min: 'senior', max: 'senior' } });
		await need(company.id, member.id, { ...base, specialization: 'frontend', grade: { min: 'middle', max: 'middle' } });
		await need(company.id, member.id, { ...base, specialization: 'backend' }, 'closed');
		// A suspended company and a company of a demo session are out of reach.
		const suspended = await createCompany(database.db, { status: 'suspended' });
		const suspendedMember = await createMember(database.db, suspended.id);
		await need(suspended.id, suspendedMember.id, { ...base, specialization: 'backend' });
		const [session] = await database.db
			.insert(demoSessions)
			.values({
				joinTokenSha256: randomBytes(32).toString('hex'),
				seedBatchId: 'test',
				expiresAt: new Date(Date.now() + DAY)
			})
			.returning();
		if (!session) throw new Error('no session');
		const sessionCompany = await employer(database.db, { demoSessionId: session.id });
		await need(sessionCompany.company.id, sessionCompany.member.id, { ...base, specialization: 'backend' });

		const few = await needDemand(database.db, candidate.subject, new Date());
		if (few.status !== 'available') throw new Error('demand expected');
		// Three needs: below the threshold of five — no figure that would name a need.
		expect(few.needs).toEqual({ below: 5 });
		expect(few.salary).toEqual({ gross: null, net: null });
		expect(few.skills).toEqual([]);

		await need(company.id, member.id, {
			skill_keys: ['sql', 'kafka'],
			nice_skill_keys: [],
			grade: { min: 'middle', max: 'senior' },
			salary: salary(240_000, 280_000)
		});
		await need(company.id, member.id, { ...base, specialization: 'backend', salary: salary(260_000, 340_000) });
		const enough = await needDemand(database.db, candidate.subject, new Date());
		if (enough.status !== 'available') throw new Error('demand expected');
		expect(enough.needs).toEqual({ value: 5 });
		expect(enough.salary.gross).toEqual({ needs: 5, min: 240_000, max: 300_000 });
		expect(enough.salary.net).toBeNull();
		// A need without a specialization counts by its skills the blocks of the category confirm (`sql`).
		expect(enough.skills.slice(0, 2)).toEqual([
			{ skillKey: 'go', needs: 4, share: 0.8 },
			{ skillKey: 'postgresql', needs: 4, share: 0.8 }
		]);
		expect(enough.skills).toContainEqual({ skillKey: 'kafka', needs: 1, share: 0.2 });
	});

	it('is not computed without a category', async () => {
		const candidate = await person(database.db, world, {});
		expect(await needDemand(database.db, candidate.subject, new Date())).toEqual({ status: 'no_category' });
	});
});
