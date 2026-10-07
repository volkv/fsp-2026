// «Новый кандидат в этой сессии» on a demonstration stand (docs/domain.md, 19.3): one press writes a fresh candidate into
// the visitor's live demo session — confirmed, the user agreement accepted, in onboarding, without a profile — and from
// there the candidate goes the whole way by the services of the product: the consent, the survey, the declared grade,
// a test with its practice through the sandbox job, the category; an employer of the same session with a need of its
// own finds the candidate in the shortlist, sends an offer, the candidate accepts it and the company receives the
// contacts chosen. Inside the session the grade policy lets the same grade be retaken at once. A session that is over
// takes no new candidate.
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { startAttempt, type EngineDeps } from '$lib/server/assessments/engine';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import type { AuthDeps } from '$lib/server/auth/context';
import { grantProfileConsent, onboardingState } from '$lib/server/auth/onboarding';
import { createSession, sessionRef } from '$lib/server/auth/sessions';
import { grantCatalogVisibility } from '$lib/server/candidates/consents';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidateCategories,
	candidates,
	demoSessions,
	documentAcceptances,
	productPolicies,
	users
} from '$lib/server/db/schema';
import { createdInSession, createNewcomer, DemoSessionEnded } from '$lib/server/demo/newcomer';
import { declareGrade } from '$lib/server/grades/declarations';
import { gradeSources } from '$lib/server/grades/sources';
import { submitSurvey } from '$lib/server/grades/surveys';
import { recipientContacts } from '$lib/server/invitations/disclosure';
import type { InvitationDeps } from '$lib/server/invitations/deps';
import { respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation } from '$lib/server/invitations/send';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { fail } from '$lib/server/ml/result';
import { createNeed } from '$lib/server/needs/service';
import type { Redis } from '$lib/server/redis';
import { createShortlist, openShortlist, type ShortlistDeps } from '$lib/server/shortlists/service';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { attemptRunner, FakeSandbox } from '../helpers/attempts';
import { releaseFixtureBank, type FixtureBank } from '../helpers/bank';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createPublishedDocument,
	createUser,
	offerTerms,
	randomSha256
} from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;
const meta = { requestId: 'test-demo-newcomer', ip: '127.0.0.1', userAgent: 'vitest' };

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 3)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 4)
});

const modelsOff = {
	embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' })),
	extract: () => Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' }))
};

let database: TestDatabase;
let redis: Redis;
let bank: FixtureBank;
let documents: Record<'pd' | 'catalog' | 'disclosure', string>;
const sandbox = new FakeSandbox();
const engineDeps = (): EngineDeps => ({ standing: OWNER_STANDING, modules: bank.modules });
const { takeAttempt } = attemptRunner({
	db: () => database.db,
	sandbox,
	deps: engineDeps,
	requestId: 'test-demo-newcomer'
});

const authDeps = (): AuthDeps => ({
	db: database.db,
	redis,
	crypto,
	mailer: { send: () => Promise.reject(new Error('a demo account gets no letters')) },
	appOrigin: 'http://localhost',
	now: () => new Date()
});
const shortlistDeps = (): ShortlistDeps & MatchingDeps => ({
	db: database.db,
	models: modelsOff,
	pseudonym: (candidateId, companyId) =>
		createHash('sha256').update(`${candidateId}:${companyId}`).digest('hex').slice(0, 20),
	now: () => new Date(),
	testResults: GRADE_DECISION_RESULTS
});
const invitationDeps = (): InvitationDeps => ({ db: database.db, crypto, now: () => new Date() });

beforeAll(async () => {
	database = await createTestDatabase();
	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const effectiveFrom = new Date(Date.now() - 10 * DAY);
	const published = { publishedAt: effectiveFrom };
	await createPublishedDocument(database.db, 'user_agreement', published);
	documents = {
		pd: (await createPublishedDocument(database.db, 'pd_processing', published)).id,
		catalog: (await createPublishedDocument(database.db, 'catalog_visibility', published)).id,
		disclosure: (await createPublishedDocument(database.db, 'contact_disclosure', published)).id
	};
	await database.db.insert(productPolicies).values([
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom },
		{ kind: 'assessment_policy', version: 1, params: { artifact_retention_days: 1 }, effectiveFrom },
		{
			kind: 'invitation_policy',
			version: 1,
			params: {
				response_window_hours: 72,
				decline_reason_codes: ['salary', 'other'],
				reason_required: true,
				max_open_per_company_per_day: 50,
				reopen_cooldown_days: 14,
				max_reopens: 2
			},
			effectiveFrom
		},
		{
			kind: 'hiring_policy',
			version: 1,
			params: {
				outcome_due_days: 30,
				reminder_intervals_days: [7],
				max_reminders: 2,
				stages: ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'],
				outcome_reason_codes: ['salary', 'other']
			},
			effectiveFrom
		},
		{ kind: 'notification_policy', version: 1, params: { response_due_reminder_hours: [24] }, effectiveFrom }
	]);
	bank = await releaseFixtureBank(database.db, 'backend');
});

afterAll(async () => {
	await redis.quit();
	await database.drop();
});

async function demoSession(expiresAt = new Date(Date.now() + DAY)): Promise<string> {
	const [row] = await database.db
		.insert(demoSessions)
		.values({
			joinTokenSha256: randomSha256(),
			seedBatchId: 'demo-1',
			createdAt: new Date(expiresAt.getTime() - DAY),
			expiresAt
		})
		.returning({ id: demoSessions.id });
	if (!row) throw new Error('demo session not inserted');
	return row.id;
}

/** An owner of a verified company of the session. */
async function sessionEmployer(sessionId: string): Promise<AccessSubject> {
	const company = await createCompany(database.db, { status: 'verified', demoSessionId: sessionId });
	const member = await createMember(database.db, company.id, {
		userId: (await createUser(database.db, { demoSessionId: sessionId })).id
	});
	if (!member.userId) throw new Error('member without user');
	return {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: member.id,
			companyId: company.id,
			role: 'owner',
			status: 'active',
			companyStatus: 'verified'
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

describe('a new candidate of a demo session', () => {
	it('goes from the press on /demo to an accepted offer of an employer of the same session', async () => {
		const sessionId = await demoSession();
		const newcomer = await createNewcomer({ db: database.db, crypto, now: new Date() }, sessionId, meta);

		// Confirmed, in the session, the agreement accepted, a candidate in onboarding without a profile.
		const [user] = await database.db.select().from(users).where(eq(users.id, newcomer.userId));
		expect(user).toMatchObject({ status: 'active', demoSessionId: sessionId, displayName: newcomer.displayName });
		expect(user?.emailVerifiedAt).not.toBeNull();
		const [candidate] = await database.db.select().from(candidates).where(eq(candidates.id, newcomer.candidateId));
		expect(candidate).toMatchObject({ status: 'onboarding', demoSessionId: sessionId, visibility: 'hidden' });
		expect(candidate?.firstNameEnc).toBeNull();
		expect(
			await database.db.select().from(documentAcceptances).where(eq(documentAcceptances.userId, newcomer.userId))
		).toHaveLength(1);
		const [registered] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'auth.registered'), eq(auditEvents.objectId, newcomer.userId)));
		expect(registered?.details).toMatchObject({ method: 'demo_newcomer' });

		// The consent of its own screen, then the survey and the declared grade.
		const { session } = await createSession(
			redis,
			{ userId: newcomer.userId, authMethod: 'password', authTime: new Date(), ip: null, ua: null },
			new Date()
		);
		expect(await grantProfileConsent(authDeps(), meta, sessionRef(session), documents.pd)).toEqual({ ok: true });
		const subject: AccessSubject = {
			userId: newcomer.userId,
			via: 'session',
			candidate: { id: newcomer.candidateId, status: 'active' },
			membership: null,
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
		await submitSurvey(
			database.db,
			gradeSources,
			subject,
			{ direction: 'development', specialization: 'backend', declaredSkillKeys: ['go'], preferences: {} },
			meta
		);
		await declareGrade(
			database.db,
			gradeSources,
			subject,
			{ specialization: 'backend', grade: 'junior' },
			meta,
			new Date()
		);
		expect((await onboardingState(authDeps(), newcomer.userId)).complete).toBe(true);

		// The test of the declared grade with its practice through the sandbox job gives the category.
		const { attempt } = await startAttempt(
			database.db,
			engineDeps(),
			subject,
			{ specialization: 'backend', grade: 'junior' },
			{ now: new Date(), requestId: meta.requestId }
		);
		const ended = await takeAttempt(subject, attempt.id, OWNER_STANDING, 'backend', { correct: true });
		expect(ended.status).toBe('decided');
		expect(sandbox.requests.length).toBeGreaterThan(0);
		const [category] = await database.db
			.select()
			.from(candidateCategories)
			.where(and(eq(candidateCategories.candidateId, newcomer.candidateId), eq(candidateCategories.status, 'active')));
		expect(category).toMatchObject({ specialization: 'backend', grade: 'junior' });
		// Inside the session the same grade is retaken at once, on the other form.
		const retake = await startAttempt(
			database.db,
			engineDeps(),
			subject,
			{ specialization: 'backend', grade: 'junior' },
			{ now: new Date(), requestId: meta.requestId }
		);
		expect(retake.attempt.form).not.toBe(attempt.form);
		await takeAttempt(subject, retake.attempt.id, OWNER_STANDING, 'backend', { correct: true });

		// Shown in the catalog by its own consent, the candidate is in the shortlist of an employer of the session.
		await grantCatalogVisibility(database.db, subject, meta, { documentId: documents.catalog, scopeFields: [] });
		const employer = await sessionEmployer(sessionId);
		const need = await createNeed({ db: database.db, models: modelsOff, now: () => new Date() }, employer, meta, {
			form: {
				specialization: 'backend',
				grade: { min: 'junior', max: 'junior' },
				skill_keys: ['sql'],
				nice_skill_keys: []
			}
		});
		const shortlist = await createShortlist(shortlistDeps(), employer, meta, need.id, {});
		const view = await openShortlist(shortlistDeps(), employer, shortlist.id);
		expect(view.items.map((item) => item.candidateId)).toContain(newcomer.candidateId);
		// The employer tells the visitor's own candidate from a clone of the cast of the same session.
		const clone = await createCandidate(database.db, {
			userId: (await createUser(database.db, { demoSessionId: sessionId, seedBatchId: 'demo-1' })).id,
			demoSessionId: sessionId,
			seedBatchId: 'demo-1'
		});
		expect(await createdInSession(database.db, [newcomer.candidateId, clone.id])).toEqual(
			new Set([newcomer.candidateId])
		);
		// An employer outside the session does not see the candidate.
		const outside = await sessionEmployer(await demoSession());
		const foreignNeed = await createNeed({ db: database.db, models: modelsOff, now: () => new Date() }, outside, meta, {
			form: {
				specialization: 'backend',
				grade: { min: 'junior', max: 'junior' },
				skill_keys: ['sql'],
				nice_skill_keys: []
			}
		});
		const foreign = await openShortlist(
			shortlistDeps(),
			outside,
			(await createShortlist(shortlistDeps(), outside, meta, foreignNeed.id, {})).id
		);
		expect(foreign.items.map((item) => item.candidateId)).not.toContain(newcomer.candidateId);

		// The offer without a vacancy: no contacts before the acceptance, the ones chosen after it.
		const sent = await createInvitation(invitationDeps(), employer, meta, {
			...offerTerms(),
			candidateId: newcomer.candidateId
		});
		await expect(recipientContacts(invitationDeps(), employer, meta, sent.invitationId)).rejects.toMatchObject({
			reason: 'no_disclosure_consent'
		});
		const answer = await respondToInvitation(invitationDeps(), subject, meta, sent.invitationId, {
			termsId: sent.termsId,
			decision: 'accept',
			discloseFields: ['full_name', 'email'],
			disclosureDocumentId: documents.disclosure
		});
		expect(answer).toMatchObject({ status: 'accepted', disclosedFields: ['full_name', 'email'] });
		const contacts = await recipientContacts(invitationDeps(), employer, meta, sent.invitationId);
		expect(contacts.email).toMatch(new RegExp(`\\+demo-${sessionId.slice(-12)}@`));
	});

	it('is not written into a session that is over', async () => {
		const sessionId = await demoSession(new Date(Date.now() - 1000));
		await expect(
			createNewcomer({ db: database.db, crypto, now: new Date() }, sessionId, { ...meta, requestId: randomUUID() })
		).rejects.toBeInstanceOf(DemoSessionEnded);
		expect(await database.db.select().from(users).where(eq(users.demoSessionId, sessionId))).toEqual([]);
	});
});
