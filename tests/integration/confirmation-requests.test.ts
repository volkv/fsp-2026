// Requests of a missing confirmation (docs/domain.md, 13.11): the employer asks a candidate it sees to confirm a block
// × grade pair of the candidate's specialization that the category does not cover; a repeated request returns the open
// one; the candidate takes the block test of their own will — four clusters of the block, reserve classes — and its
// result is evidence of its own with the area of the block, never a change of the category; a result closes the
// requests of other companies without a new test when the candidate shares it; the result becomes a point of «why you»
// of an offer, and an annulled attempt takes the result with it.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ItemInstance } from '$lib/server/assessments/contract/bank';
import { blockTestPairs } from '$lib/server/assessments/contract/bank';
import { CATALOG, gradeDefinition } from '$lib/server/assessments/contract/catalog';
import { annulAttemptIn } from '$lib/server/assessments/annul';
import { answerItem } from '$lib/server/assessments/engine';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import {
	acceptRequest,
	candidateConfirmations,
	declineRequest,
	requestConfirmation,
	setResultVisibility,
	type ConfirmationDeps
} from '$lib/server/confirmations/requests';
import {
	blockConfirmations,
	candidateCategories,
	candidateCompanyBlocks,
	confirmationRequests,
	gradeDecisions,
	notifications,
	sourceFacts,
	testAttempts,
	testItems
} from '$lib/server/db/schema';
import { getInvitation } from '$lib/server/invitations/read';
import { createInvitation } from '$lib/server/invitations/send';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { offerTerms } from '../helpers/factories';
import { contactWorld, detailCode, employer, person, refusal, testCrypto, type ContactWorld } from '../helpers/contact';

const meta = { requestId: 'test-confirmations', ip: '127.0.0.1', userAgent: 'vitest' };
let database: TestDatabase;
let world: ContactWorld;

const deps = (): ConfirmationDeps => {
	const bank = world.banks.get('backend');
	if (!bank) throw new Error('no backend bank');
	return { db: database.db, crypto: testCrypto, now: () => new Date(), modules: bank.modules };
};
const invitationDeps = () => ({ db: database.db, crypto: testCrypto, now: () => new Date() });

/** Backend Middle: the defining blocks are confirmed; a testable other block, and one without a block test. */
const MIDDLE = gradeDefinition('backend', 'middle');
const TESTABLE = blockTestPairs('backend').find((p) => p.grade === 'middle' && !MIDDLE.defining.includes(p.block));
const NOT_TESTABLE = CATALOG.blocks.find(
	(b) =>
		b.specialization === 'backend' &&
		!b.practice &&
		!MIDDLE.defining.includes(b.code) &&
		!blockTestPairs('backend').some((p) => p.grade === 'middle' && p.block === b.code)
);

beforeAll(async () => {
	database = await createTestDatabase();
	world = await contactWorld(database, ['backend']);
});

afterAll(async () => {
	await database.drop();
});

/** Answers every served cluster of the block test right (or wrong) until it ends. */
async function takeBlockTest(subject: Parameters<typeof answerItem>[2], attemptId: string, correct: boolean) {
	const bank = world.banks.get('backend');
	if (!bank) throw new Error('no backend bank');
	for (let guard = 0; guard < 10; guard += 1) {
		const [item] = await database.db
			.select()
			.from(testItems)
			.where(and(eq(testItems.attemptId, attemptId), eq(testItems.status, 'served')));
		if (!item) return;
		const instance = item.instance as ItemInstance;
		const key = instance.answer?.kind === 'exact' ? instance.answer.value : '';
		await answerItem(
			database.db,
			{ standing: OWNER_STANDING, modules: bank.modules },
			subject,
			{ attemptId, seq: item.seq, payload: { kind: 'answer', answer: correct ? key : `${key}0` }, signals: null },
			{ now: new Date(), requestId: 'test-block' }
		);
	}
	throw new Error('the block test did not end');
}

describe('a request of a missing confirmation', () => {
	it('has a block to ask for and one without a block test', () => {
		expect(TESTABLE).toBeDefined();
		expect(NOT_TESTABLE).toBeDefined();
	});

	it('is not duplicated, refuses what the category covers and what has no block test', async () => {
		if (!TESTABLE || !NOT_TESTABLE) throw new Error('no blocks to ask for');
		const { subject } = await employer(database.db);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });

		const first = await requestConfirmation(deps(), subject, meta, {
			candidateId: candidate.id,
			block: TESTABLE.block
		});
		const again = await requestConfirmation(deps(), subject, meta, {
			candidateId: candidate.id,
			block: TESTABLE.block
		});
		expect(first).toMatchObject({ kind: 'request', created: true });
		expect(again).toMatchObject({ kind: 'request', created: false });
		if (first.kind !== 'request' || again.kind !== 'request') throw new Error('requests expected');
		expect(again.request.id).toBe(first.request.id);
		expect(first.request).toMatchObject({ grade: 'middle', specialization: 'backend', status: 'requested' });
		const rows = await database.db
			.select()
			.from(confirmationRequests)
			.where(eq(confirmationRequests.candidateId, candidate.id));
		expect(rows).toHaveLength(1);
		const told = await database.db
			.select({ type: notifications.type })
			.from(notifications)
			.where(eq(notifications.userId, candidate.userId));
		expect(told.map((n) => n.type).filter((type) => type.startsWith('confirmation.'))).toEqual([
			'confirmation.requested'
		]);

		const defining = await refusal(
			requestConfirmation(deps(), subject, meta, { candidateId: candidate.id, block: MIDDLE.defining[0] ?? '' })
		);
		expect([defining.code, detailCode(defining)]).toEqual(['policy_violation', 'confirmation_block_confirmed']);
		const untestable = await refusal(
			requestConfirmation(deps(), subject, meta, { candidateId: candidate.id, block: NOT_TESTABLE.code })
		);
		expect([untestable.code, detailCode(untestable)]).toEqual(['policy_violation', 'block_not_testable']);
	});

	it('refuses a candidate the company does not see and another candidate’s request', async () => {
		if (!TESTABLE) throw new Error('no block to ask for');
		const { company, subject } = await employer(database.db);
		const blocked = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		await database.db.insert(candidateCompanyBlocks).values({ candidateId: blocked.id, companyId: company.id });
		const hidden = await refusal(
			requestConfirmation(deps(), subject, meta, { candidateId: blocked.id, block: TESTABLE.block })
		);
		expect(hidden.code).toBe('not_found');

		const addressee = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		const stranger = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		const sent = await requestConfirmation(deps(), subject, meta, { candidateId: addressee.id, block: TESTABLE.block });
		if (sent.kind !== 'request') throw new Error('a request expected');
		expect((await refusal(acceptRequest(deps(), stranger.subject, meta, sent.request.id))).code).toBe('not_found');
		expect((await refusal(declineRequest(deps(), stranger.subject, meta, sent.request.id))).code).toBe('not_found');
		expect((await candidateConfirmations(deps(), stranger.subject)).requests).toHaveLength(0);
	});

	it('is taken of the candidate’s will: the block test gives evidence, the category does not change', async () => {
		if (!TESTABLE) throw new Error('no block to ask for');
		const first = await employer(database.db);
		const second = await employer(database.db);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		const [categoryBefore] = await database.db
			.select()
			.from(candidateCategories)
			.where(and(eq(candidateCategories.candidateId, candidate.id), eq(candidateCategories.status, 'active')));
		const decisionsBefore = await database.db
			.select({ id: gradeDecisions.id })
			.from(gradeDecisions)
			.where(eq(gradeDecisions.candidateId, candidate.id));

		const sent = await requestConfirmation(deps(), first.subject, meta, {
			candidateId: candidate.id,
			block: TESTABLE.block
		});
		if (sent.kind !== 'request') throw new Error('a request expected');
		const accepted = await acceptRequest(deps(), candidate.subject, meta, sent.request.id);
		if (accepted.kind !== 'started') throw new Error('the block test should start');
		expect((await refusal(acceptRequest(deps(), candidate.subject, meta, sent.request.id))).code).toBe('conflict');
		const [attempt] = await database.db.select().from(testAttempts).where(eq(testAttempts.id, accepted.attemptId));
		expect(attempt).toMatchObject({
			purpose: 'vacancy_block',
			confirmationRequestId: sent.request.id,
			grade: 'middle',
			form: null
		});
		await takeBlockTest(candidate.subject, accepted.attemptId, true);

		const served = await database.db.select().from(testItems).where(eq(testItems.attemptId, accepted.attemptId));
		expect(served).toHaveLength(4);
		expect(new Set(served.map((item) => item.block))).toEqual(new Set([TESTABLE.block]));
		expect(new Set(served.map((item) => item.familyKey)).size).toBe(4);
		expect(served.every((item) => !item.practice)).toBe(true);

		const [result] = await database.db
			.select()
			.from(blockConfirmations)
			.where(eq(blockConfirmations.attemptId, accepted.attemptId));
		expect(result).toMatchObject({
			block: TESTABLE.block,
			grade: 'middle',
			verdict: 'confirmed',
			status: 'valid',
			visibility: 'requester'
		});
		if (!result) throw new Error('no result');
		const [completed] = await database.db
			.select()
			.from(confirmationRequests)
			.where(eq(confirmationRequests.id, sent.request.id));
		expect(completed).toMatchObject({ status: 'completed', confirmationId: result.id });

		// The category and the decisions on the grade are exactly as before.
		const [categoryAfter] = await database.db
			.select()
			.from(candidateCategories)
			.where(and(eq(candidateCategories.candidateId, candidate.id), eq(candidateCategories.status, 'active')));
		expect(categoryAfter).toEqual(categoryBefore);
		const decisionsAfter = await database.db
			.select({ id: gradeDecisions.id })
			.from(gradeDecisions)
			.where(eq(gradeDecisions.candidateId, candidate.id));
		expect(decisionsAfter).toEqual(decisionsBefore);
		const companyTold = await database.db
			.select({ type: notifications.type, payload: notifications.payload })
			.from(notifications)
			.where(eq(notifications.userId, first.member.userId ?? ''));
		expect(companyTold).toHaveLength(1);
		expect(companyTold[0]).toMatchObject({ type: 'confirmation.completed', payload: { verdict: 'confirmed' } });

		// The result with the area it covers, to the candidate.
		const own = await candidateConfirmations(deps(), candidate.subject);
		expect(own.results).toEqual([
			expect.objectContaining({
				id: result.id,
				skillKeys: CATALOG.blocks.find((b) => b.code === TESTABLE.block)?.skillKeys
			})
		]);

		// Another company does not see the result: it asks and gets a request; the candidate shares the result instead of
		// a new test, and the request closes by it.
		const otherSent = await requestConfirmation(deps(), second.subject, meta, {
			candidateId: candidate.id,
			block: TESTABLE.block
		});
		if (otherSent.kind !== 'request') throw new Error('a request expected for a company that does not see the result');
		const shared = await acceptRequest(deps(), candidate.subject, meta, otherSent.request.id);
		expect(shared).toEqual({ kind: 'completed', confirmationId: result.id });
		const attempts = await database.db
			.select({ id: testAttempts.id })
			.from(testAttempts)
			.where(and(eq(testAttempts.candidateId, candidate.id), eq(testAttempts.purpose, 'vacancy_block')));
		expect(attempts).toHaveLength(1);
		// Asked again, the company gets the result it sees, not a new request.
		expect(
			await requestConfirmation(deps(), first.subject, meta, { candidateId: candidate.id, block: TESTABLE.block })
		).toMatchObject({ kind: 'result', result: { id: result.id } });

		// The result is a point of «why you» of the company that sees it, and of no other.
		const sentOffer = await createInvitation(invitationDeps(), first.subject, meta, {
			...offerTerms({
				whyYou: [{ text: 'Подтвердил блок по нашему запросу', source: { kind: 'confirmation', ref: result.id } }]
			}),
			candidateId: candidate.id
		});
		const third = await employer(database.db);
		const foreign = await refusal(
			createInvitation(invitationDeps(), third.subject, meta, {
				...offerTerms({
					whyYou: [{ text: 'Подтвердил блок', source: { kind: 'confirmation', ref: result.id } }]
				}),
				candidateId: candidate.id
			})
		);
		expect(foreign.code).toBe('validation_failed');
		// Opened to every company, the result is theirs to name as well.
		await setResultVisibility(deps(), candidate.subject, meta, result.id, 'all_companies');
		// Opened to every company, the result is a fact of the profile with the area of the block: its skills only.
		const factsOf = () =>
			database.db
				.select()
				.from(sourceFacts)
				.where(and(eq(sourceFacts.candidateId, candidate.id), eq(sourceFacts.factType, 'test_block')));
		const [fact] = await factsOf();
		expect(fact).toMatchObject({
			source: 'platform_test',
			status: 'active',
			eventKey: `test:block:${TESTABLE.block}`,
			payload: expect.objectContaining({
				block: TESTABLE.block,
				skillKeys: CATALOG.blocks.find((b) => b.code === TESTABLE.block)?.skillKeys
			}) as unknown
		});
		await createInvitation(invitationDeps(), third.subject, meta, {
			...offerTerms({ whyYou: [{ text: 'Подтвердил блок', source: { kind: 'confirmation', ref: result.id } }] }),
			candidateId: candidate.id
		});

		// An annulled attempt takes the result with it; the sent version stays and marks the point.
		await database.db.transaction((tx) =>
			annulAttemptIn(tx, OWNER_STANDING, {
				attemptId: accepted.attemptId,
				reason: 'technical_failure',
				annulledBy: null,
				actor: { kind: 'system' },
				requestId: 'test-annul',
				ip: null,
				userAgent: null,
				now: new Date()
			})
		);
		const [annulled] = await database.db.select().from(blockConfirmations).where(eq(blockConfirmations.id, result.id));
		expect(annulled?.status).toBe('annulled');
		expect((await factsOf()).map((row) => row.status)).toEqual(['annulled']);
		const offer = await getInvitation(invitationDeps(), first.subject, sentOffer.invitationId);
		expect(offer.versions[0]?.whyYou).toEqual([expect.objectContaining({ basisAnnulled: true })]);
		const stale = await refusal(
			createInvitation(invitationDeps(), second.subject, meta, {
				...offerTerms({ whyYou: [{ text: 'Подтвердил блок', source: { kind: 'confirmation', ref: result.id } }] }),
				candidateId: candidate.id
			})
		);
		expect(stale.code).toBe('validation_failed');
	});

	it('is declined without consequence, and an expired one is not answered', async () => {
		if (!TESTABLE) throw new Error('no block to ask for');
		const { subject } = await employer(database.db);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		const sent = await requestConfirmation(deps(), subject, meta, { candidateId: candidate.id, block: TESTABLE.block });
		if (sent.kind !== 'request') throw new Error('a request expected');
		await declineRequest(deps(), candidate.subject, meta, sent.request.id);
		const [declined] = await database.db
			.select()
			.from(confirmationRequests)
			.where(eq(confirmationRequests.id, sent.request.id));
		expect(declined?.status).toBe('declined');
		// A declined request is not open: asking again makes a new one.
		const next = await requestConfirmation(deps(), subject, meta, { candidateId: candidate.id, block: TESTABLE.block });
		expect(next).toMatchObject({ kind: 'request', created: true });
		if (next.kind !== 'request') throw new Error('a request expected');
		await database.db
			.update(confirmationRequests)
			.set({ expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 20 * 86_400_000) })
			.where(eq(confirmationRequests.id, next.request.id));
		const late = await refusal(acceptRequest(deps(), candidate.subject, meta, next.request.id));
		expect([late.code, detailCode(late)]).toEqual(['conflict', 'request_expired']);
	});
});
