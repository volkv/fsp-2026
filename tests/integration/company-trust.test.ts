import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applications } from '$lib/server/db/schema';
import { companyTrust, TRUST_MIN_OBSERVATIONS, type TrustFact } from '$lib/server/companies/trust';
import { reportHiring } from '$lib/server/hiring/process';
import { getInvitation } from '$lib/server/invitations/read';
import { withdrawInvitation } from '$lib/server/invitations/send';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createOfferWorld, testMeta, type OfferWorld } from '../helpers/offers';

const DAY = 86_400_000;

let database: TestDatabase;
let world: OfferWorld;

beforeAll(async () => {
	database = await createTestDatabase();
	world = await createOfferWorld(database);
});

afterAll(async () => {
	await database.drop();
});

const factOf = (facts: TrustFact[], key: TrustFact['key']) => facts.find((fact) => fact.key === key);

describe('facts of trust in a company', () => {
	it('say «no data» without numbers below the threshold', async () => {
		world.clock.now = new Date();
		const company = await world.employer();
		const trust = await companyTrust(database.db, company.company.id, world.clock.now);
		expect(trust.minObservations).toBe(TRUST_MIN_OBSERVATIONS);
		expect(trust.facts.map((fact) => fact.status)).toEqual(trust.facts.map(() => 'no_data'));
		expect(trust.facts.every((fact) => !('count' in fact))).toBe(true);

		// Two offers, one withdrawn: two observations are fewer than three — still no numbers.
		const first = await world.sentOffer(company, await world.candidate());
		await world.sentOffer(company, await world.candidate());
		await withdrawInvitation(world.deps, company.subject, testMeta, first.invitationId);
		const two = await companyTrust(database.db, company.company.id, world.clock.now);
		expect(factOf(two.facts, 'offers_withdrawn')).toEqual({ key: 'offers_withdrawn', status: 'no_data' });

		await world.sentOffer(company, await world.candidate());
		const three = await companyTrust(database.db, company.company.id, world.clock.now);
		expect(factOf(three.facts, 'offers_withdrawn')).toEqual({
			key: 'offers_withdrawn',
			status: 'shown',
			count: 1,
			of: 3
		});
		expect(factOf(three.facts, 'complaints_upheld')).toEqual({
			key: 'complaints_upheld',
			status: 'shown',
			count: 0,
			of: 3
		});
	});

	it('count the first step, the reported outcome and the agreement with candidates after acceptances', async () => {
		const start = new Date();
		world.clock.now = start;
		const company = await world.employer();
		const people = [await world.candidate(), await world.candidate(), await world.candidate()];
		const offers = [];
		for (const person of people) offers.push(await world.acceptedOffer(company, person));
		const [a, b, c] = offers;
		if (!a || !b || !c) throw new Error('three offers expected');

		// Within a week the company reports a stage of two processes; the third waits.
		world.clock.now = new Date(start.getTime() + 2 * DAY);
		for (const offer of [a, b]) {
			await reportHiring(world.deps, company.subject, testMeta, offer.processId, {
				party: 'company',
				kind: 'stage',
				stage: 'interview_scheduled'
			});
		}
		const early = await companyTrust(database.db, company.company.id, world.clock.now);
		// The third process is not observed until its week is over: two observations — no data yet.
		expect(factOf(early.facts, 'first_step_in_time')).toEqual({ key: 'first_step_in_time', status: 'no_data' });

		world.clock.now = new Date(start.getTime() + 8 * DAY);
		const week = await companyTrust(database.db, company.company.id, world.clock.now);
		expect(factOf(week.facts, 'first_step_in_time')).toEqual({
			key: 'first_step_in_time',
			status: 'shown',
			count: 2,
			of: 3
		});
		// No process reached its outcome date and the company reported none: not observed yet.
		expect(factOf(week.facts, 'outcome_reported')).toEqual({ key: 'outcome_reported', status: 'no_data' });

		// After the outcome date the company reported one outcome; the candidate of that process agreed.
		world.clock.now = new Date(start.getTime() + 31 * DAY);
		await reportHiring(world.deps, company.subject, testMeta, a.processId, {
			party: 'company',
			kind: 'outcome',
			outcome: 'hired',
			startDate: '2026-12-01'
		});
		const [personA] = people;
		if (!personA) throw new Error('candidate expected');
		await reportHiring(world.deps, personA.subject, testMeta, a.processId, {
			party: 'candidate',
			kind: 'outcome',
			outcome: 'hired'
		});
		const month = await companyTrust(database.db, company.company.id, world.clock.now);
		expect(factOf(month.facts, 'outcome_reported')).toEqual({
			key: 'outcome_reported',
			status: 'shown',
			count: 1,
			of: 3
		});
		// One process where both sides reported is one observation: no number about a single candidate.
		expect(factOf(month.facts, 'outcome_agreed')).toEqual({ key: 'outcome_agreed', status: 'no_data' });

		// The candidate reads the same facts in the offer.
		const view = await getInvitation(world.deps, personA.subject, a.invitationId);
		expect(view.companyTrust).toEqual(month);
	});

	it('look at the last year only', async () => {
		const start = new Date();
		world.clock.now = start;
		const company = await world.employer();
		for (let i = 0; i < 3; i++) await world.sentOffer(company, await world.candidate());
		const now = await companyTrust(database.db, company.company.id, start);
		expect(factOf(now.facts, 'offers_withdrawn')).toMatchObject({ status: 'shown', of: 3 });
		const later = await companyTrust(database.db, company.company.id, new Date(start.getTime() + 366 * DAY));
		expect(factOf(later.facts, 'offers_withdrawn')).toEqual({ key: 'offers_withdrawn', status: 'no_data' });
	});

	it('count the answers to applications, without those withdrawn before an answer', async () => {
		const now = new Date();
		const company = await world.employer();
		const row = async (status: 'submitted' | 'rejected' | 'withdrawn', decided: boolean) => {
			const person = await world.candidate();
			await database.db.insert(applications).values({
				candidateId: person.id,
				companyId: company.company.id,
				vacancyId: company.vacancy.id,
				match: {},
				status,
				submittedAt: now,
				decidedAt: decided ? now : null,
				closedAt: status === 'submitted' ? null : now
			});
		};
		await row('rejected', true);
		await row('rejected', true);
		await row('submitted', false);
		await row('withdrawn', false);
		const trust = await companyTrust(database.db, company.company.id, now);
		expect(factOf(trust.facts, 'applications_answered')).toEqual({
			key: 'applications_answered',
			status: 'shown',
			count: 2,
			of: 3
		});
	});
});
