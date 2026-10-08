// The conversation of an accepted offer (docs/domain.md, section 13.15): it opens with the acceptance, only the two
// sides read and write it, the other side is told without the text once per run of unread messages, and the revoked
// disclosure, the suspended company or another demo session close it.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { auditEvents, companies, demoSessions, invitationMessages, notifications, users } from '$lib/server/db/schema';
import { Refusal } from '$lib/server/invitations/errors';
import { revokeDisclosureConsent } from '$lib/server/invitations/disclosure';
import { getConversation, markConversationRead, sendMessage } from '$lib/server/messages/conversation';
import { blockCompany, unblockCompany } from '$lib/server/profile/company-blocks';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createUser } from '../helpers/factories';
import { createOfferWorld, testMeta, type Employer, type OfferWorld } from '../helpers/offers';

let database: TestDatabase;
let world: OfferWorld;

beforeAll(async () => {
	database = await createTestDatabase();
	world = await createOfferWorld(database);
});

afterAll(async () => {
	await database.drop();
});

async function refusal(operation: Promise<unknown>): Promise<Refusal> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof Refusal) return error;
		throw error;
	}
	throw new Error('the operation was expected to be refused');
}

const messageNotices = (userId: string) =>
	database.db
		.select({ payload: notifications.payload })
		.from(notifications)
		.where(and(eq(notifications.userId, userId), eq(notifications.type, 'invitation.message')));

async function demoSession(): Promise<string> {
	const [session] = await database.db
		.insert(demoSessions)
		.values({
			joinTokenSha256: Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64),
			seedBatchId: 'demo-test',
			expiresAt: new Date(Date.now() + 86_400_000)
		})
		.returning({ id: demoSessions.id });
	if (!session) throw new Error('session not inserted');
	return session.id;
}

const suspended = (employer: Employer): AccessSubject => {
	const membership = employer.subject.membership;
	if (!membership) throw new Error('employer without membership');
	return { ...employer.subject, membership: { ...membership, companyStatus: 'suspended' } };
};

describe('the conversation of an offer', () => {
	it('opens with the acceptance: before it neither side writes', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const sent = await world.sentOffer(company, person);

		for (const subject of [company.subject, person.subject]) {
			const refused = await refusal(sendMessage(world.deps, subject, testMeta, sent.invitationId, 'Здравствуйте'));
			expect(refused).toMatchObject({ code: 'conflict', reason: 'conversation_not_accepted' });
		}
		expect((await getConversation(world.deps, person.subject, sent.invitationId)).closure).toBe('not_accepted');
		expect(
			await database.db.select().from(invitationMessages).where(eq(invitationMessages.invitationId, sent.invitationId))
		).toEqual([]);
	});

	it('lets the two sides write after it, with the author, the time and what the other side read', async () => {
		const company = await world.employer();
		await database.db.update(users).set({ displayName: 'Алина Лаврова' }).where(eq(users.id, company.userId));
		const person = await world.candidate();
		const { invitationId } = await world.acceptedOffer(company, person);

		const first = await sendMessage(world.deps, company.subject, testMeta, invitationId, 'Когда удобно созвониться?');
		expect(first).toMatchObject({ side: 'company', own: true, authorName: 'Алина Лаврова', readAt: null });
		// Markup and links are kept as the text they are.
		const answer = '  Завтра после 15:00. <b>Ссылка</b>: https://example.org/cv\r\n';
		await sendMessage(world.deps, person.subject, testMeta, invitationId, answer);

		const seen = await getConversation(world.deps, person.subject, invitationId);
		expect(seen).toMatchObject({ viewer: 'candidate', closure: null, unread: 1 });
		expect(seen.messages.map((message) => [message.side, message.own, message.authorName, message.text])).toEqual([
			['company', false, 'Алина Лаврова', 'Когда удобно созвониться?'],
			['candidate', true, null, 'Завтра после 15:00. <b>Ссылка</b>: https://example.org/cv']
		]);
		// Reading marks nothing; opening the conversation reads the other side's messages only.
		expect((await getConversation(world.deps, person.subject, invitationId)).unread).toBe(1);
		expect(await markConversationRead(world.deps, person.subject, invitationId)).toBe(1);
		const after = await getConversation(world.deps, company.subject, invitationId);
		expect(after.messages.map((message) => message.readAt !== null)).toEqual([true, false]);
		expect(after.unread).toBe(1);

		const refused = await refusal(sendMessage(world.deps, person.subject, testMeta, invitationId, 'x'.repeat(2001)));
		expect(refused.code).toBe('validation_failed');
		expect((await refusal(sendMessage(world.deps, person.subject, testMeta, invitationId, '  \n '))).code).toBe(
			'validation_failed'
		);
	});

	it('keeps another company, another candidate and the FSP staff out', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const { invitationId } = await world.acceptedOffer(company, person);
		await sendMessage(world.deps, company.subject, testMeta, invitationId, 'Добрый день!');

		const stranger = await world.employer();
		const otherPerson = await world.candidate();
		const operator: AccessSubject = {
			userId: (await createUser(database.db)).id,
			via: 'session',
			candidate: null,
			membership: null,
			staff: { operator: true, admin: true, extraPermissions: ['audit.read'] }
		};
		for (const subject of [stranger.subject, otherPerson.subject, operator]) {
			expect(await refusal(getConversation(world.deps, subject, invitationId))).toMatchObject({ code: 'not_found' });
			expect(await refusal(markConversationRead(world.deps, subject, invitationId))).toMatchObject({
				code: 'not_found'
			});
			expect(await refusal(sendMessage(world.deps, subject, testMeta, invitationId, 'Чужое'))).toMatchObject({
				code: 'not_found'
			});
		}
		const stored = await database.db
			.select({ text: invitationMessages.text })
			.from(invitationMessages)
			.where(eq(invitationMessages.invitationId, invitationId));
		expect(stored).toEqual([{ text: 'Добрый день!' }]);
	});

	it('tells the other side once per run of unread messages, never with the text, and journals no text', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const { invitationId } = await world.acceptedOffer(company, person);

		await sendMessage(world.deps, company.subject, testMeta, invitationId, 'Секретная деталь номер один');
		await sendMessage(world.deps, company.subject, testMeta, invitationId, 'Секретная деталь номер два');
		const notices = await messageNotices(person.userId);
		expect(notices).toHaveLength(1);
		expect(JSON.stringify(notices)).not.toContain('Секретная');
		// After the candidate opened the conversation, the next message is a new run.
		await markConversationRead(world.deps, person.subject, invitationId);
		await sendMessage(world.deps, company.subject, testMeta, invitationId, 'Секретная деталь номер три');
		expect(await messageNotices(person.userId)).toHaveLength(2);
		// The candidate's message reaches the member who sent the offer.
		await sendMessage(world.deps, person.subject, testMeta, invitationId, 'Спасибо');
		expect(await messageNotices(company.userId)).toHaveLength(1);

		const journal = await database.db
			.select({ details: auditEvents.details, outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'invitation.message_sent'), eq(auditEvents.objectId, invitationId)));
		expect(journal).toHaveLength(4);
		expect(journal.every((row) => row.outcome === 'success')).toBe(true);
		expect(JSON.stringify(journal)).not.toContain('Секретная');
	});

	it('closes for writing when the candidate revokes the disclosure, and keeps the history readable', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const { invitationId } = await world.acceptedOffer(company, person);
		await sendMessage(world.deps, person.subject, testMeta, invitationId, 'Здравствуйте!');

		await revokeDisclosureConsent(world.deps, person.subject, testMeta, invitationId);
		for (const subject of [company.subject, person.subject]) {
			expect(await refusal(sendMessage(world.deps, subject, testMeta, invitationId, 'Ещё'))).toMatchObject({
				code: 'conflict',
				reason: 'conversation_consent_revoked'
			});
		}
		const history = await getConversation(world.deps, company.subject, invitationId);
		expect(history.closure).toBe('consent_revoked');
		expect(history.messages.map((message) => message.text)).toEqual(['Здравствуйте!']);
		const denied = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.action, 'invitation.message_sent'),
					eq(auditEvents.objectId, invitationId),
					eq(auditEvents.outcome, 'denied')
				)
			);
		expect(denied).toHaveLength(2);
	});

	it('closes for writing when the company is suspended', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const { invitationId } = await world.acceptedOffer(company, person);
		await database.db.update(companies).set({ status: 'suspended' }).where(eq(companies.id, company.company.id));

		expect(
			await refusal(sendMessage(world.deps, person.subject, testMeta, invitationId, 'Вы на связи?'))
		).toMatchObject({ code: 'conflict', reason: 'conversation_company_closed' });
		expect(
			await refusal(sendMessage(world.deps, suspended(company), testMeta, invitationId, 'Мы на связи'))
		).toMatchObject({ code: 'conflict', reason: 'conversation_company_closed' });
		expect((await getConversation(world.deps, suspended(company), invitationId)).closure).toBe('company_closed');
	});

	it('closes for writing and for the reading of the company the candidate blocked; the candidate still reads', async () => {
		const company = await world.employer();
		const person = await world.candidate();
		const { invitationId } = await world.acceptedOffer(company, person);
		await sendMessage(world.deps, company.subject, testMeta, invitationId, 'Когда удобно созвониться?');
		await sendMessage(world.deps, person.subject, testMeta, invitationId, 'Завтра после обеда');

		await blockCompany(world.deps, person.subject, testMeta, company.company.id);
		for (const subject of [company.subject, person.subject]) {
			expect(await refusal(sendMessage(world.deps, subject, testMeta, invitationId, 'Ещё'))).toMatchObject({
				code: 'conflict',
				reason: 'conversation_candidate_unavailable'
			});
		}
		const seenByCompany = await getConversation(world.deps, company.subject, invitationId);
		expect(seenByCompany).toMatchObject({ closure: 'candidate_unavailable', messages: [], unread: 0 });
		expect(await markConversationRead(world.deps, company.subject, invitationId)).toBe(0);
		const seenByCandidate = await getConversation(world.deps, person.subject, invitationId);
		expect(seenByCandidate.closure).toBe('candidate_unavailable');
		expect(seenByCandidate.messages.map((message) => message.text)).toEqual([
			'Когда удобно созвониться?',
			'Завтра после обеда'
		]);

		// The block lifted: the company reads the history again, its unread message among it, and both write.
		await unblockCompany(world.deps, person.subject, testMeta, company.company.id);
		const reopened = await getConversation(world.deps, company.subject, invitationId);
		expect(reopened).toMatchObject({ closure: null, unread: 1 });
		await sendMessage(world.deps, company.subject, testMeta, invitationId, 'Договорились');
	});

	it('keeps demo sessions apart: an offer of a company of a session is not the conversation of a candidate outside it', async () => {
		const session = await demoSession();
		const company = await world.employer({ demoSessionId: session });
		const clone = await world.candidate({ demoSessionId: session });
		const { invitationId } = await world.acceptedOffer(company, clone);
		await sendMessage(world.deps, clone.subject, testMeta, invitationId, 'Пишу из своей сессии');
		expect((await getConversation(world.deps, clone.subject, invitationId)).messages).toHaveLength(1);

		// The candidate of the stand outside sessions, addressed by the company of the session.
		const outside = await world.candidate();
		const sent = await world.sentOffer(company, outside);
		expect(await refusal(getConversation(world.deps, outside.subject, sent.invitationId))).toMatchObject({
			code: 'not_found',
			reason: 'not_in_demo_scope'
		});
		expect(
			await refusal(sendMessage(world.deps, outside.subject, testMeta, sent.invitationId, 'Привет'))
		).toMatchObject({ code: 'not_found', reason: 'not_in_demo_scope' });
		// A company of another session sees nothing of it either.
		const elsewhere = await world.employer({ demoSessionId: await demoSession() });
		expect(await refusal(getConversation(world.deps, elsewhere.subject, invitationId))).toMatchObject({
			code: 'not_found'
		});
	});
});
