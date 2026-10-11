// The candidate's own application (docs/domain.md, 6.5, 13.5, 13.6): only to a published vacancy of a company of the
// platform within reach; it carries the match of the pair and discloses the chosen
// contacts to that company by a consent scoped to the application (`disclosures.application_id`); the company sees the
// applications to its vacancies by pseudonym with the contacts while the consent holds, a withdrawn application closes
// the access; an offer to the applicant marks the application `invited`.
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	applyToVacancy,
	companyApplications,
	disclosingApplication,
	disclosingApplicationOfInvitation,
	getApplication,
	myApplications,
	rejectApplication,
	showcaseVacancyFor,
	withdrawApplication,
	type ApplicationDeps
} from '$lib/server/applications/service';
import {
	applications,
	candidateCompanyBlocks,
	candidates,
	consentEvents,
	demoSessions,
	disclosures,
	embeddings,
	embeddingSpaces,
	notifications,
	searchSettings,
	users,
	vacancies
} from '$lib/server/db/schema';
import { createInvitation } from '$lib/server/invitations/send';
import { recommendVacancies } from '$lib/server/matching/recommendations';
import { CONTACT_MASK } from '$lib/server/visibility/contact-mask';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createOwnVacancy, offerTerms } from '../helpers/factories';
import {
	DAY,
	contactWorld,
	detailCode,
	employer,
	person,
	refusal,
	testCrypto,
	type ContactWorld
} from '../helpers/contact';

const meta = { requestId: 'test-applications', ip: '127.0.0.1', userAgent: 'vitest', sessionHash: null };
let database: TestDatabase;
let world: ContactWorld;

const deps = (): ApplicationDeps => ({ db: database.db, crypto: testCrypto, now: () => new Date() });

beforeAll(async () => {
	database = await createTestDatabase();
	world = await contactWorld(database, ['backend']);
});

afterAll(async () => {
	await database.drop();
});

async function vacancyOf(company: Awaited<ReturnType<typeof employer>>, overrides = {}) {
	return createOwnVacancy(
		database.db,
		{ companyId: company.company.id, memberId: company.member.id, taxonomyVersionId: world.taxonomyVersionId },
		overrides
	);
}

const apply = (candidate: Awaited<ReturnType<typeof person>>, vacancyId: string, fields = ['full_name', 'email']) =>
	applyToVacancy(deps(), candidate.subject, meta, {
		vacancyId,
		message: 'Работал с платежами три года',
		discloseFields: fields,
		disclosureDocumentId: world.disclosureDocumentId
	});

describe('the showcase of the platform', () => {
	it('holds only the published vacancies of the companies of the platform', async () => {
		const company = await employer(database.db);
		const published = await vacancyOf(company);
		const paused = await vacancyOf(company, { status: 'paused' });
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		const page = await recommendVacancies({ db: database.db }, candidate.subject, {});
		const ids = page.items.map((item) => item.vacancyId);
		expect(ids).toContain(published.id);
		expect(ids).not.toContain(paused.id);
		// A vacancy out of the showcase takes no application.
		expect((await refusal(apply(candidate, paused.id))).code).toBe('conflict');
	});

	it('does not show a vacancy of another demo session, nor take an application to it', async () => {
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
		const foreign = await vacancyOf(sessionCompany);
		const candidate = await person(database.db, world, {});
		const page = await recommendVacancies({ db: database.db }, candidate.subject, {});
		expect(page.items.map((item) => item.vacancyId)).not.toContain(foreign.id);
		expect((await refusal(apply(candidate, foreign.id))).code).toBe('not_found');
	});
});

describe('an application', () => {
	it('carries the match and discloses the chosen contacts to that company only', async () => {
		const company = await employer(database.db);
		const vacancy = await vacancyOf(company);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		await database.db
			.update(users)
			.set({ emailEnc: testCrypto.encrypt('applicant@example.ru', 'users.email') })
			.where(eq(users.id, candidate.userId));
		await database.db
			.update(candidates)
			.set({ phoneEnc: testCrypto.encrypt('+79990000000', 'candidates.phone') })
			.where(eq(candidates.id, candidate.id));
		const sent = await apply(candidate, vacancy.id, ['full_name', 'email', 'phone']);
		expect(sent).toMatchObject({ status: 'submitted', disclosedFields: ['full_name', 'email', 'phone'] });
		expect(sent.match.score).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(sent.match)).not.toContain('fact_ids');

		const [disclosed] = await database.db.select().from(disclosures).where(eq(disclosures.applicationId, sent.id));
		expect(disclosed).toMatchObject({
			candidateId: candidate.id,
			companyId: company.company.id,
			invitationId: null,
			fields: ['full_name', 'email', 'phone']
		});
		const [grant] = await database.db
			.select()
			.from(consentEvents)
			.where(and(eq(consentEvents.scopeApplicationId, sent.id), eq(consentEvents.action, 'grant')));
		expect(grant).toMatchObject({
			kind: 'contact_disclosure',
			scopeCompanyId: company.company.id,
			scopeInvitationId: null
		});
		const told = await database.db
			.select({ type: notifications.type })
			.from(notifications)
			.where(eq(notifications.userId, company.member.userId ?? ''));
		expect(told.map((n) => n.type)).toContain('application.received');

		// The company sees it by pseudonym, with the contacts; the first opening marks it viewed.
		const listed = await companyApplications(deps(), company.subject);
		expect(listed).toEqual([
			expect.objectContaining({
				id: sent.id,
				candidatePseudonym: testCrypto.pseudonym(candidate.id, company.company.id)
			})
		]);
		const opened = await getApplication(deps(), company.subject, meta, sent.id);
		expect(opened.application.status).toBe('viewed');
		expect(opened.contacts?.fields).toEqual(['full_name', 'email', 'phone']);
		expect(opened.contacts).toMatchObject({ email: 'applicant@example.ru', phone: '+79990000000' });
		// The card of the candidate tells the company it holds the contacts by this application.
		const pair = { candidateId: candidate.id, companyId: company.company.id };
		expect(await disclosingApplication(database.db, pair, new Date())).toEqual({
			id: sent.id,
			vacancyTitle: vacancy.title
		});

		// Another company sees nothing of it.
		const other = await employer(database.db);
		expect(await companyApplications(deps(), other.subject)).toEqual([]);
		expect((await refusal(getApplication(deps(), other.subject, meta, sent.id))).code).toBe('not_found');
		expect((await refusal(rejectApplication(deps(), other.subject, meta, sent.id))).code).toBe('not_found');
		// Another candidate cannot withdraw it.
		const stranger = await person(database.db, world, {});
		expect((await refusal(withdrawApplication(deps(), stranger.subject, meta, sent.id))).code).toBe('not_found');

		// One application per vacancy.
		const twice = await refusal(apply(candidate, vacancy.id));
		expect(detailCode(twice)).toBe('already_applied');

		// Withdrawn: the consent is revoked, the company keeps the application without further contacts.
		const withdrawn = await withdrawApplication(deps(), candidate.subject, meta, sent.id);
		expect(withdrawn).toMatchObject({ status: 'withdrawn', disclosedFields: [] });
		const reopened = await getApplication(deps(), company.subject, meta, sent.id);
		expect(reopened.contacts).toBeNull();
		expect(await disclosingApplication(database.db, pair, new Date())).toBeNull();
		const revoked = await database.db
			.select({ action: consentEvents.action })
			.from(consentEvents)
			.where(eq(consentEvents.scopeApplicationId, sent.id));
		expect(revoked.map((row) => row.action).sort()).toEqual(['grant', 'revoke']);
	});

	it('shows its message to the company as written while the contacts are disclosed, masked once withdrawn', async () => {
		const company = await employer(database.db);
		const vacancy = await vacancyOf(company);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		const message = 'Три года платежей на Go 1.22. Связь: @ivan_dev, ivan@mail.ru';
		const sent = await applyToVacancy(deps(), candidate.subject, meta, {
			vacancyId: vacancy.id,
			message,
			discloseFields: ['full_name', 'email'],
			disclosureDocumentId: world.disclosureDocumentId
		});
		const companyMessage = async () =>
			(await companyApplications(deps(), company.subject)).find((application) => application.id === sent.id)?.message;
		expect(await companyMessage()).toBe(message);

		await withdrawApplication(deps(), candidate.subject, meta, sent.id);
		const masked = `Три года платежей на Go 1.22. Связь: ${CONTACT_MASK}, ${CONTACT_MASK}`;
		expect(await companyMessage()).toBe(masked);
		expect((await getApplication(deps(), company.subject, meta, sent.id)).application.message).toBe(masked);
		const own = await myApplications(deps(), candidate.subject);
		expect(own.find((application) => application.id === sent.id)?.message).toBe(message);
	});

	it('shows its status to the candidate: an offer marks it invited, a refusal rejected', async () => {
		const company = await employer(database.db);
		const first = await vacancyOf(company);
		const second = await vacancyOf(company, { title: 'Backend-разработчик на Python' });
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		const one = await apply(candidate, first.id);
		await rejectApplication(deps(), company.subject, meta, one.id);
		const two = await apply(candidate, second.id);
		const offer = await createInvitation(
			{ db: database.db, crypto: testCrypto, now: () => new Date() },
			company.subject,
			meta,
			{
				...offerTerms(),
				candidateId: candidate.id
			}
		);
		const mine = await myApplications(deps(), candidate.subject);
		expect(mine.map((row) => [row.id, row.status, row.invitationId])).toEqual(
			expect.arrayContaining([
				[one.id, 'rejected', null],
				[two.id, 'invited', offer.invitationId]
			])
		);
		// The page of the offer tells the company it holds the contacts by the newest application.
		expect(await disclosingApplicationOfInvitation(database.db, offer.invitationId, new Date())).toEqual({
			id: two.id,
			vacancyTitle: 'Backend-разработчик на Python'
		});
		const decisions = await database.db
			.select({ payload: notifications.payload })
			.from(notifications)
			.where(and(eq(notifications.userId, candidate.userId), eq(notifications.type, 'application.decided')));
		expect(decisions.map((row) => (row.payload as { decision: string }).decision).sort()).toEqual([
			'invited',
			'rejected'
		]);
	});

	it('lets the company it was sent to offer even to a profile hidden from the catalog, and no other', async () => {
		const company = await employer(database.db);
		const vacancy = await vacancyOf(company);
		const hidden = await person(database.db, world, {
			category: { specialization: 'backend', grade: 'middle' },
			visibility: 'hidden'
		});
		const deps = { db: database.db, crypto: testCrypto, now: () => new Date() };
		const offer = () => ({ ...offerTerms(), candidateId: hidden.id });
		// Hidden and without an application: the company does not see the candidate.
		expect((await refusal(createInvitation(deps, company.subject, meta, offer()))).code).toBe('not_found');
		const sent = await apply(hidden, vacancy.id);
		// Another company: the application is not a consent to contact with it.
		const other = await employer(database.db);
		expect((await refusal(createInvitation(deps, other.subject, meta, offer()))).code).toBe('not_found');
		// A block of the company by the candidate stands, application or not.
		await database.db.insert(candidateCompanyBlocks).values({ candidateId: hidden.id, companyId: company.company.id });
		expect((await refusal(createInvitation(deps, company.subject, meta, offer()))).code).toBe('not_found');
		await database.db
			.delete(candidateCompanyBlocks)
			.where(
				and(eq(candidateCompanyBlocks.candidateId, hidden.id), eq(candidateCompanyBlocks.companyId, company.company.id))
			);
		const invited = await createInvitation(deps, company.subject, meta, offer());
		const [row] = await database.db.select().from(applications).where(eq(applications.id, sent.id));
		expect(row).toMatchObject({ status: 'invited', invitationId: invited.invitationId });

		// Withdrawn, the application no longer opens contact: a new company line is refused again.
		const later = await employer(database.db);
		const laterVacancy = await vacancyOf(later);
		const second = await apply(hidden, laterVacancy.id);
		await withdrawApplication(deps, hidden.subject, meta, second.id);
		expect((await refusal(createInvitation(deps, later.subject, meta, offer()))).code).toBe('not_found');
	});

	it('is open to adults: a candidate aged 14–17 is reached by the company', async () => {
		const company = await employer(database.db);
		const vacancy = await vacancyOf(company);
		const year = new Date().getUTCFullYear() - 16;
		const minor = await person(database.db, world, { birthDate: `${year}-01-15` });
		const refused = await refusal(apply(minor, vacancy.id));
		expect([refused.code, detailCode(refused)]).toEqual(['policy_violation', 'application_adult_only']);
		const closed = await vacancyOf(company, { status: 'closed', closedAt: new Date() });
		const adult = await person(database.db, world, {});
		const late = await refusal(apply(adult, closed.id));
		expect([late.code, detailCode(late)]).toEqual(['conflict', 'vacancy_closed']);
		expect(await database.db.select().from(applications).where(eq(applications.candidateId, minor.id))).toEqual([]);
	});
});

describe('the match of a pair', () => {
	it('is one number in the list, on the page of the vacancy and in the application: the semantic component included', async () => {
		const space = 'test-space/3';
		await database.db.insert(embeddingSpaces).values({
			id: space,
			modelName: 'test-embedder',
			modelRevision: 'r1',
			dimension: 3,
			queryPrefix: '',
			documentPrefix: '',
			pooling: 'mean',
			normalization: 'l2',
			maxInputTokens: 512,
			chunkingVersion: 'v1',
			status: 'active',
			activatedAt: new Date()
		});
		await database.db.update(searchSettings).set({ activeEmbeddingSpaceId: space });
		const company = await employer(database.db);
		const vacancy = await vacancyOf(company);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		const [revision] = await database.db
			.select({ value: vacancies.revision })
			.from(vacancies)
			.where(eq(vacancies.id, vacancy.id));
		const [floor] = await database.db
			.select({ value: candidates.evidenceFloorRevision })
			.from(candidates)
			.where(eq(candidates.id, candidate.id));
		if (!revision || !floor) throw new Error('no vacancy or candidate');
		await database.db.insert(embeddings).values([
			{
				ownerType: 'vacancy',
				ownerId: vacancy.id,
				inputSha256: randomBytes(32).toString('hex'),
				inputVersion: String(revision.value),
				spaceId: space,
				vector: [1, 0, 0]
			},
			{
				ownerType: 'candidate_section',
				ownerId: candidate.id,
				section: 'skills',
				inputSha256: randomBytes(32).toString('hex'),
				inputVersion: String(floor.value),
				spaceId: space,
				vector: [0.6, 0.8, 0]
			}
		]);

		const listed = (await recommendVacancies({ db: database.db }, candidate.subject, { limit: 100 })).items.find(
			(item) => item.vacancyId === vacancy.id
		);
		if (!listed) throw new Error('the vacancy is not in the list');
		expect(listed.match.components.semantic.status).toBe('computed');
		const page = await showcaseVacancyFor(deps(), candidate.subject, vacancy.id);
		expect(page.match.components.semantic.status).toBe('computed');
		expect(page.match.score).toBe(listed.match.score);
		const sent = await apply(candidate, vacancy.id);
		expect(sent.match.components.semantic?.status).toBe('computed');
		expect(sent.match.score).toBe(listed.match.score);
	});
});
