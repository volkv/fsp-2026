// The legal representative of a candidate aged 14–17 without an account (docs/domain.md 6.3, 6.4, 7.3, 13.6): after the
// operator verified the authority a letter brings a one-time link to the consents of the profile; the ward's profile is
// then shown for an internship open to minors; an acceptance of an invitation waits for the representative, whose
// consent by the link of another letter hands the contacts over. The links work once and not after their term; a
// refusal of the representative, a revision, the deadline and the ward's own cancellation close the answer. After 18 the
// candidate signs the processing consent again.
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { AuthDeps } from '$lib/server/auth/context';
import { currentDocument } from '$lib/server/auth/documents';
import { grantProfileConsent } from '$lib/server/auth/onboarding';
import { grantCatalogVisibility } from '$lib/server/candidates/consents';
import { createSession } from '$lib/server/auth/sessions';
import { effectiveConsentOf } from '$lib/server/consent/effective';
import { processingAllowed } from '$lib/server/consent/processing';
import {
	representativeConsentForm,
	representativeOverview,
	requestConsentLetterByRepresentative,
	resendConsentLetter,
	revokeConsentsByRepresentative,
	sendConsentLetter,
	signConsentsByRepresentative,
	type RepresentativeDeps
} from '$lib/server/consent/representative';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidates,
	consentEvents,
	demoSessions,
	disclosures,
	documentAcceptances,
	emailTokens,
	invitationResponses,
	invitations,
	jobs,
	legalRepresentatives,
	matchRulesets,
	notifications,
	productPolicies,
	representations,
	users
} from '$lib/server/db/schema';
import type { InvitationDeps, RequestMeta } from '$lib/server/invitations/deps';
import {
	declineDisclosureByRepresentative,
	grantDisclosureByRepresentative,
	recipientContacts,
	representativeDisclosureRequest,
	resendDisclosureLetter,
	revokeDisclosureConsent,
	sendDisclosureLetter
} from '$lib/server/invitations/disclosure';
import { Refusal } from '$lib/server/invitations/errors';
import { getInvitation, listInvitations } from '$lib/server/invitations/read';
import { respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation, reviseInvitation } from '$lib/server/invitations/send';
import type { MailMessage, Mailer } from '$lib/server/mail/mailer';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import { openNotification } from '$lib/server/notifications/inbox';
import { decideAuthority } from '$lib/server/operator/representatives';
import type { Redis } from '$lib/server/redis';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser
} from '../helpers/factories';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EPOCH = new Date(Date.now() - 400 * DAY);
const APP_ORIGIN = 'http://app.test';

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 3)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 4)
});

/** A mailbox of the letters the product sends: the links are read back as a representative would. */
class Outbox implements Mailer {
	readonly letters: MailMessage[] = [];

	send(message: MailMessage) {
		this.letters.push(message);
		return Promise.resolve({ ok: true as const, value: { messageId: `letter-${this.letters.length}` } });
	}

	/** The token of the newest letter to the address whose link leads to `path`. */
	token(to: string, path: string): string {
		const letter = this.letters.findLast((l) => l.to === to && l.text.includes(path));
		const token = letter ? new RegExp(`${path}\\?token=([^\\s&]+)`).exec(letter.text)?.[1] : undefined;
		if (token === undefined) throw new Error(`no letter to ${to} with a link to ${path}`);
		return decodeURIComponent(token);
	}

	count(to: string): number {
		return this.letters.filter((l) => l.to === to).length;
	}
}

let database: TestDatabase;
let redis: Redis;
let taxonomyVersionId: string;
let minorTermsId: string;
let clock = new Date();
const outbox = new Outbox();
let invitationDeps: InvitationDeps;
let letterDeps: RepresentativeDeps;
const meta: RequestMeta & { ip: string; userAgent: string } = {
	requestId: 'test-request',
	ip: '127.0.0.1',
	userAgent: 'vitest'
};

beforeAll(async () => {
	database = await createTestDatabase();
	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();
	const { db } = database;
	invitationDeps = { db, crypto, now: () => clock };
	letterDeps = { db, crypto, mailer: outbox, appOrigin: APP_ORIGIN, now: () => clock };
	taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	await db.insert(matchRulesets).values({
		version: shippedMatchRuleset.version,
		taxonomyVersionId,
		params: matchRulesetParamsSchema.parse(shippedMatchRuleset.params)
	});
	const published = { publishedAt: EPOCH };
	for (const kind of ['pd_processing', 'catalog_visibility', 'fsp_import', 'contact_disclosure'] as const) {
		await createPublishedDocument(db, kind, published);
	}
	minorTermsId = (await createPublishedDocument(db, 'minor_employment_terms', published)).id;
	await db.insert(productPolicies).values([
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
			effectiveFrom: EPOCH
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
			effectiveFrom: EPOCH
		},
		{
			kind: 'notification_policy',
			version: 1,
			params: { response_due_reminder_hours: [24] },
			effectiveFrom: EPOCH
		},
		{
			kind: 'minor_policy',
			version: 1,
			params: { enabled: true, authority_methods: ['in_person', 'document_presented'] },
			effectiveFrom: EPOCH
		}
	]);
});

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

// --- Fixtures -------------------------------------------------------------------------------------------------------

async function documentId(kind: 'pd_processing' | 'catalog_visibility' | 'fsp_import' | 'contact_disclosure') {
	const document = await currentDocument(database.db, kind, clock);
	if (!document) throw new Error(`${kind} is not published`);
	return document.id;
}

const birthDateAged = (years: number, daysAfterBirthday = 30) => {
	const date = new Date(Date.now() - daysAfterBirthday * DAY);
	date.setUTCFullYear(date.getUTCFullYear() - years);
	return date.toISOString().slice(0, 10);
};

async function newRepresentative(email: string): Promise<{ id: string }> {
	const [representative] = await database.db
		.insert(legalRepresentatives)
		.values({
			fullNameEnc: crypto.encrypt('Захарова Елена Викторовна', 'legal_representatives.full_name'),
			emailEnc: crypto.encrypt(email, 'legal_representatives.email'),
			emailHmac: crypto.lookupHmac('email', email)
		})
		.returning();
	if (!representative) throw new Error('representative not inserted');
	return representative;
}

/**
 * A candidate aged 16 who signed the processing consent at registration and named a representative who confirmed the
 * address: the state the operator's queue holds.
 */
async function teenager(
	options: {
		birthDate?: string;
		signedAt?: Date;
		/** The candidate is a clone of this demo session. */
		demoSession?: string;
		/** The person of the representative already known: a clone's representation names the same person. */
		representative?: { id: string; email: string };
	} = {}
) {
	const { db } = database;
	const email = `teen-${randomBytes(4).toString('hex')}@example.org`;
	const [user] = await db
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			displayName: 'Алиса',
			demoSessionId: options.demoSession ?? null
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	const [candidate] = await db
		.insert(candidates)
		.values({
			userId: user.id,
			demoSessionId: options.demoSession ?? null,
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			birthDate: options.birthDate ?? birthDateAged(16),
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified',
			lastNameEnc: crypto.encrypt('Захарова', 'candidates.last_name'),
			firstNameEnc: crypto.encrypt('Алиса', 'candidates.first_name')
		})
		.returning();
	if (!candidate) throw new Error('candidate not inserted');
	await db.insert(consentEvents).values({
		subjectCandidateId: candidate.id,
		kind: 'pd_processing',
		documentId: await documentId('pd_processing'),
		action: 'grant',
		signerKind: 'subject',
		signerUserId: user.id,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: options.signedAt ?? new Date(Date.now() - DAY)
	});
	const representativeEmail = options.representative?.email ?? `parent-${randomBytes(4).toString('hex')}@example.org`;
	const representative = options.representative ?? (await newRepresentative(representativeEmail));
	const [representation] = await db
		.insert(representations)
		.values({
			candidateId: candidate.id,
			representativeId: representative.id,
			relation: 'parent',
			status: 'contact_confirmed',
			invitedAt: EPOCH,
			contactConfirmedAt: EPOCH
		})
		.returning();
	if (!representation) throw new Error('representation not inserted');
	const subject: AccessSubject = {
		userId: user.id,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return {
		id: candidate.id,
		userId: user.id,
		email,
		representativeId: representative.id,
		representativeEmail,
		representationId: representation.id,
		subject
	};
}

type Teen = Awaited<ReturnType<typeof teenager>>;

async function operator(): Promise<AccessSubject> {
	const user = await createUser(database.db);
	return {
		userId: user.id,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: true, admin: false, extraPermissions: [] }
	};
}

/** The operator verifies the authority; the representative gets the letter with the consents, as the cabinet sends it. */
async function verify(teen: Teen): Promise<void> {
	const staff = await operator();
	await decideAuthority(
		database.db,
		staff,
		meta,
		teen.representationId,
		{ result: 'verified', method: 'in_person', basisKind: 'birth_certificate', basisNote: 'Свидетельство', note: '' },
		clock
	);
	if (staff.userId === null) throw new Error('operator without user');
	expect(
		await sendConsentLetter(letterDeps, meta, { kind: 'user', userId: staff.userId }, teen.representationId)
	).toEqual({ ok: true });
}

async function signAll(teen: Teen, kinds: ('pd_processing' | 'catalog_visibility' | 'fsp_import')[]) {
	const chosen: Record<string, string> = {};
	for (const kind of kinds) chosen[kind] = await documentId(kind);
	return signConsentsByRepresentative(
		letterDeps,
		meta,
		outbox.token(teen.representativeEmail, '/representative/consent'),
		chosen
	);
}

/** A verified company that accepted the offer on the work of minors, with an internship open from 14. */
async function employer() {
	const { db } = database;
	const company = await createCompany(db, { status: 'verified' });
	const member = await createMember(db, company.id);
	if (!member.userId) throw new Error('member without user');
	const [acceptance] = await db
		.insert(documentAcceptances)
		.values({ documentId: minorTermsId, userId: member.userId, companyId: company.id, acceptedAt: EPOCH })
		.returning();
	if (!acceptance) throw new Error('acceptance not inserted');
	const vacancy = await createOwnVacancy(
		db,
		{ companyId: company.id, memberId: member.id, taxonomyVersionId },
		{ minAge: 14, minorTermsAcceptanceId: acceptance.id, salaryMin: 40_000, salaryMax: 60_000 }
	);
	const subject: AccessSubject = {
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
	return { company, member, vacancy, subject, userId: member.userId };
}

type Employer = Awaited<ReturnType<typeof employer>>;

/** The teenager with both sides of the processing and catalog consents in effect, shown for internships. */
async function shownTeenager(): Promise<Teen> {
	const teen = await teenager();
	await verify(teen);
	expect(await signAll(teen, ['pd_processing', 'catalog_visibility'])).toMatchObject({ ok: true });
	await grantCatalogVisibility(database.db, teen.subject, meta, {
		documentId: await documentId('catalog_visibility'),
		scopeFields: []
	});
	// The candidate's screen signs on the wall clock: the product's clock catches up with it.
	clock = new Date();
	return teen;
}

const invite = (company: Employer, teen: Teen) =>
	createInvitation(invitationDeps, company.subject, meta, {
		vacancyId: company.vacancy.id,
		candidateId: teen.id,
		salaryMin: 45_000,
		salaryMax: 55_000,
		message: 'Приглашаем на летнюю стажировку.'
	});

const accept = async (teen: Teen, invitationId: string, termsId: string, fields = ['full_name', 'email']) =>
	respondToInvitation(invitationDeps, teen.subject, meta, invitationId, {
		termsId,
		decision: 'accept',
		discloseFields: fields,
		disclosureDocumentId: await documentId('contact_disclosure')
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

async function notificationTypes(userId: string) {
	return (await database.db.select().from(notifications).where(eq(notifications.userId, userId))).map((n) => n.type);
}

/** The candidate accepts, and the representative is written to, as the invitation page does it. */
async function acceptAndAsk(teen: Teen, company: Employer) {
	const sent = await invite(company, teen);
	const answer = await accept(teen, sent.invitationId, sent.termsId, ['full_name', 'email']);
	expect(answer).toMatchObject({ awaitingRepresentative: true, disclosedFields: [], processId: null });
	expect(
		await sendDisclosureLetter(letterDeps, meta, { kind: 'user', userId: teen.userId }, sent.invitationId)
	).toEqual({ ok: true });
	return { ...sent, token: outbox.token(teen.representativeEmail, '/representative/disclosure') };
}

// --- Tests ----------------------------------------------------------------------------------------------------------

describe('the representative of a minor, by the links of letters', () => {
	it('signs the consents, then consents to the disclosure of one invitation: the contacts reach the company', async () => {
		clock = new Date();
		const teen = await teenager();
		const company = await employer();

		// Before the operator's check nothing is shown and no letter goes.
		expect((await refusal(invite(company, teen))).reason).toBe('no_processing_consent');
		expect(await sendConsentLetter(letterDeps, meta, { kind: 'system' }, teen.representationId)).toEqual({
			ok: false,
			reason: 'not_applicable'
		});

		await verify(teen);
		const letter = outbox.letters.at(-1);
		expect(letter?.to).toBe(teen.representativeEmail);
		expect(letter?.text).toContain('Захарова Елена Викторовна');
		expect(letter?.text).toContain('Алиса');
		const consentToken = outbox.token(teen.representativeEmail, '/representative/consent');
		const form = await representativeConsentForm(database.db, crypto, consentToken, clock);
		expect(form?.texts.map((text) => [text.kind, text.signed, text.candidateSigned])).toEqual([
			['pd_processing', false, true],
			['catalog_visibility', false, false],
			['fsp_import', false, false]
		]);
		// The candidate sees what waits for the representative.
		expect(
			(await representativeOverview(database.db, teen.id, clock)).consents.map((c) => [c.kind, c.representative])
		).toEqual([
			['pd_processing', false],
			['catalog_visibility', false],
			['fsp_import', false]
		]);
		expect(await processingAllowed(database.db, teen.id, clock)).toBe(false);

		expect(await signAll(teen, ['pd_processing', 'catalog_visibility'])).toEqual({
			ok: true,
			signed: ['pd_processing', 'catalog_visibility'],
			letterSent: true
		});
		// The representative gets what is in force now and a new link to change it.
		const changed = outbox.letters.at(-1);
		expect(changed?.to).toBe(teen.representativeEmail);
		expect(changed?.subject).toMatch(/^Согласия законного представителя изменены/u);
		expect(changed?.text).toContain('обработка персональных данных — подписано');
		expect(changed?.text).toContain('получение достижений из систем ФСП — не подписано');
		expect(outbox.token(teen.representativeEmail, '/representative/consent')).not.toBe(consentToken);
		const signed = await database.db
			.select()
			.from(consentEvents)
			.where(eq(consentEvents.representationId, teen.representationId));
		expect(signed.map((e) => [e.kind, e.action, e.signerKind, e.method])).toEqual([
			['pd_processing', 'grant', 'representative', 'email_link'],
			['catalog_visibility', 'grant', 'representative', 'email_link']
		]);
		expect(signed[0]?.evidence).toMatchObject({ ip: '127.0.0.1', user_agent: 'vitest' });
		expect(signed[0]?.evidence).toHaveProperty('email_token_id');
		expect(signed[0]?.evidence).toHaveProperty('document_sha256');
		expect(await processingAllowed(database.db, teen.id, clock)).toBe(true);
		expect(await notificationTypes(teen.userId)).toContain('representation.consents_signed');
		// The processing starts: the evidence computation catches up with the profile.
		const queued = await database.db
			.select({ type: jobs.type })
			.from(jobs)
			.where(eq(jobs.dedupKey, `evidence:${teen.id}`));
		expect(queued).toHaveLength(1);

		// The profile is shown for the internship open to minors once the candidate shows it in the catalog too.
		await grantCatalogVisibility(database.db, teen.subject, meta, {
			documentId: await documentId('catalog_visibility'),
			scopeFields: []
		});
		// The candidate's screen signs on the wall clock: the product's clock catches up with it.
		clock = new Date();
		const sent = await invite(company, teen);

		// The acceptance waits for the representative: no answer, no disclosure, the invitation stays open.
		const answer = await accept(teen, sent.invitationId, sent.termsId, ['full_name', 'email']);
		expect(answer).toEqual({ status: 'sent', processId: null, disclosedFields: [], awaitingRepresentative: true });
		expect(await database.db.select().from(disclosures).where(eq(disclosures.candidateId, teen.id))).toEqual([]);
		expect(
			await database.db
				.select()
				.from(invitationResponses)
				.where(eq(invitationResponses.invitationId, sent.invitationId))
		).toEqual([]);
		const waiting = await getInvitation(invitationDeps, teen.subject, sent.invitationId);
		expect(waiting.awaitingRepresentative).toMatchObject({ dueAt: sent.responseDueAt, fields: ['full_name', 'email'] });
		const companyView = await getInvitation(invitationDeps, company.subject, sent.invitationId);
		expect(companyView.awaitingRepresentative).toMatchObject({ dueAt: sent.responseDueAt, fields: null });
		expect((await listInvitations(invitationDeps, teen.subject, 'candidate'))[0]?.awaitingRepresentative).toBe(true);
		expect((await refusal(recipientContacts(invitationDeps, company.subject, meta, sent.invitationId))).code).toBe(
			'not_found'
		);
		// The reminders of the deadline are cancelled; the deadline itself stays.
		const termsJobs = await database.db
			.select({ type: jobs.type, status: jobs.status })
			.from(jobs)
			.where(eq(jobs.inputVersion, sent.termsId));
		expect(Object.fromEntries(termsJobs.map((job) => [job.type, job.status]))).toMatchObject({
			'invitation.expire': 'queued',
			'invitation.remind_due': 'cancelled'
		});
		// A second acceptance while waiting is refused.
		const again = await refusal(accept(teen, sent.invitationId, sent.termsId));
		expect([again.code, again.reason]).toEqual(['conflict', 'awaiting_representative']);

		expect(
			await sendDisclosureLetter(letterDeps, meta, { kind: 'user', userId: teen.userId }, sent.invitationId)
		).toEqual({ ok: true });
		const disclosureLetter = outbox.letters.at(-1);
		expect(disclosureLetter?.text).toContain(company.company.displayName);
		// The amounts are grouped by the Russian locale with a no-break space.
		expect(disclosureLetter?.text.replace(/\s/gu, ' ')).toContain('от 45 000 до 55 000');
		expect(disclosureLetter?.text).toContain('фамилия, имя и отчество, адрес почты');
		const token = outbox.token(teen.representativeEmail, '/representative/disclosure');
		const [issued] = await database.db
			.select({ expiresAt: emailTokens.expiresAt })
			.from(emailTokens)
			.where(and(eq(emailTokens.purpose, 'representative_disclosure'), eq(emailTokens.targetRef, sent.termsId)));
		// Not longer than the deadline of the version: the representative answers within the window of the terms.
		expect(issued?.expiresAt).toEqual(sent.responseDueAt);

		const request = await representativeDisclosureRequest(invitationDeps, token);
		expect(request).toMatchObject({
			candidateName: 'Алиса',
			companyName: company.company.displayName,
			fields: ['full_name', 'email'],
			dueAt: sent.responseDueAt,
			salary: { min: 45_000, max: 55_000 }
		});
		if (!request) throw new Error('no request');

		const granted = await grantDisclosureByRepresentative(invitationDeps, meta, {
			token,
			documentId: request.document.id
		});
		expect(granted).toMatchObject({ status: 'accepted', disclosedFields: ['full_name', 'email'] });
		expect(granted.processId).not.toBeNull();
		const [disclosure] = await database.db
			.select()
			.from(disclosures)
			.where(eq(disclosures.invitationId, sent.invitationId));
		expect(disclosure).toMatchObject({ fields: ['full_name', 'email'], companyId: company.company.id });
		const contacts = await recipientContacts(invitationDeps, company.subject, meta, sent.invitationId);
		expect(contacts).toMatchObject({ fullName: { last: 'Захарова', first: 'Алиса' }, email: teen.email });
		expect(await notificationTypes(teen.userId)).toContain('invitation.representative_answered');
		const [answered] = await database.db
			.select({ payload: notifications.payload })
			.from(notifications)
			.where(and(eq(notifications.userId, company.userId), eq(notifications.type, 'invitation.answered')));
		expect(answered?.payload).toMatchObject({ decision: 'accept', by_representative: true });
		const grants = await database.db
			.select({ signerKind: consentEvents.signerKind, method: consentEvents.method, fields: consentEvents.scopeFields })
			.from(consentEvents)
			.where(eq(consentEvents.scopeInvitationId, sent.invitationId));
		expect(grants).toEqual([
			{ signerKind: 'subject', method: 'separate_screen_button', fields: ['full_name', 'email'] },
			{ signerKind: 'representative', method: 'email_link', fields: ['full_name', 'email'] }
		]);
		expect((await getInvitation(invitationDeps, teen.subject, sent.invitationId)).awaitingRepresentative).toBeNull();

		// The link worked once.
		const reused = await refusal(
			grantDisclosureByRepresentative(invitationDeps, meta, { token, documentId: request.document.id })
		);
		expect([reused.code, reused.reason]).toEqual(['not_found', 'invalid_link']);
		expect(await representativeDisclosureRequest(invitationDeps, token)).toBeNull();

		// The candidate revokes: the company loses the contacts at once.
		await revokeDisclosureConsent(invitationDeps, teen.subject, meta, sent.invitationId);
		expect((await refusal(recipientContacts(invitationDeps, company.subject, meta, sent.invitationId))).code).toBe(
			'not_found'
		);
	});

	it('refuses a used, a replaced and an expired consents link, and one of a representation no longer verified', async () => {
		clock = new Date();
		const teen = await teenager();
		await verify(teen);
		const first = outbox.token(teen.representativeEmail, '/representative/consent');

		// The candidate asks for the letter again: not at once, then the new link withdraws the old one.
		expect(await resendConsentLetter(letterDeps, meta, teen.subject)).toEqual({ ok: false, reason: 'too_soon' });
		clock = new Date(clock.getTime() + 6 * 60_000);
		expect(await resendConsentLetter(letterDeps, meta, teen.subject)).toEqual({ ok: true });
		const second = outbox.token(teen.representativeEmail, '/representative/consent');
		expect(second).not.toBe(first);
		expect(await representativeConsentForm(database.db, crypto, first, clock)).toBeNull();
		const pd = await documentId('pd_processing');
		expect(await signConsentsByRepresentative(letterDeps, meta, first, { pd_processing: pd })).toEqual({
			ok: false,
			reason: 'invalid_link'
		});

		// A refusal keeps the link working: nothing chosen, the processing consent missing, a text that changed.
		expect(await signConsentsByRepresentative(letterDeps, meta, second, {})).toEqual({
			ok: false,
			reason: 'nothing_chosen'
		});
		expect(
			await signConsentsByRepresentative(letterDeps, meta, second, {
				catalog_visibility: await documentId('catalog_visibility')
			})
		).toEqual({ ok: false, reason: 'processing_required' });
		expect(
			await signConsentsByRepresentative(letterDeps, meta, second, { pd_processing: await documentId('fsp_import') })
		).toEqual({ ok: false, reason: 'document_changed' });
		expect(await signConsentsByRepresentative(letterDeps, meta, second, { pd_processing: pd })).toEqual({
			ok: true,
			signed: ['pd_processing'],
			letterSent: true
		});
		// Used once.
		expect(await signConsentsByRepresentative(letterDeps, meta, second, { pd_processing: pd })).toEqual({
			ok: false,
			reason: 'invalid_link'
		});

		// Expired: a week later the link of a new letter does not work.
		clock = new Date(clock.getTime() + 6 * 60_000);
		expect(await resendConsentLetter(letterDeps, meta, teen.subject)).toEqual({ ok: true });
		const third = outbox.token(teen.representativeEmail, '/representative/consent');
		clock = new Date(clock.getTime() + 7 * DAY + 1);
		expect(await representativeConsentForm(database.db, crypto, third, clock)).toBeNull();
		expect(
			await signConsentsByRepresentative(letterDeps, meta, third, {
				catalog_visibility: await documentId('catalog_visibility')
			})
		).toEqual({ ok: false, reason: 'invalid_link' });

		// A representation that ended takes no signature by a link issued before.
		clock = new Date();
		const other = await teenager();
		await verify(other);
		const pending = outbox.token(other.representativeEmail, '/representative/consent');
		await database.db
			.update(representations)
			.set({ status: 'ended', endedAt: clock, endReason: 'operator_revoked' })
			.where(eq(representations.id, other.representationId));
		expect(await representativeConsentForm(database.db, crypto, pending, clock)).toBeNull();
		expect(await signConsentsByRepresentative(letterDeps, meta, pending, { pd_processing: pd })).toEqual({
			ok: false,
			reason: 'invalid_link'
		});

		const journal = await database.db
			.select({ action: auditEvents.action, outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(and(eq(auditEvents.subjectCandidateId, teen.id), eq(auditEvents.action, 'representation.letter_sent')));
		// The verification, the candidate's request, the letter after the signature and the candidate's request again.
		expect(journal).toEqual([
			{ action: 'representation.letter_sent', outcome: 'success' },
			{ action: 'representation.letter_sent', outcome: 'success' },
			{ action: 'representation.letter_sent', outcome: 'success' },
			{ action: 'representation.letter_sent', outcome: 'success' }
		]);
	});

	it('declines the version when the representative does not consent', async () => {
		clock = new Date();
		const teen = await shownTeenager();
		const company = await employer();
		const { invitationId, token } = await acceptAndAsk(teen, company);

		const result = await declineDisclosureByRepresentative(invitationDeps, meta, { token });
		expect(result).toMatchObject({ status: 'declined', disclosedFields: [], awaitingRepresentative: false });
		const [response] = await database.db
			.select()
			.from(invitationResponses)
			.where(eq(invitationResponses.invitationId, invitationId));
		expect(response).toMatchObject({ decision: 'decline', reasonCode: 'representative_declined' });
		expect(await database.db.select().from(disclosures).where(eq(disclosures.invitationId, invitationId))).toEqual([]);
		const [answered] = await database.db
			.select({ payload: notifications.payload })
			.from(notifications)
			.where(and(eq(notifications.userId, company.userId), eq(notifications.type, 'invitation.answered')));
		expect(answered?.payload).toMatchObject({ decision: 'decline', by_representative: true });
		expect(await notificationTypes(teen.userId)).toContain('invitation.representative_answered');
		const reused = await refusal(declineDisclosureByRepresentative(invitationDeps, meta, { token }));
		expect([reused.code, reused.reason]).toEqual(['not_found', 'invalid_link']);
	});

	it('closes the link when the candidate cancels, the company revises or the deadline passes', async () => {
		clock = new Date();
		const teen = await shownTeenager();
		const disclosure = await documentId('contact_disclosure');

		// The candidate cancels the acceptance: the representative's link stops working, a new acceptance asks again.
		const cancelled = await acceptAndAsk(teen, await employer());
		await revokeDisclosureConsent(invitationDeps, teen.subject, meta, cancelled.invitationId);
		expect(await representativeDisclosureRequest(invitationDeps, cancelled.token)).toBeNull();
		const closed = await refusal(
			grantDisclosureByRepresentative(invitationDeps, meta, { token: cancelled.token, documentId: disclosure })
		);
		expect([closed.code, closed.reason]).toEqual(['conflict', 'request_closed']);
		expect((await accept(teen, cancelled.invitationId, cancelled.termsId)).awaitingRepresentative).toBe(true);

		// The company revises the terms: the answer to the previous version is gone with it.
		const company = await employer();
		const revisedOne = await acceptAndAsk(teen, company);
		clock = new Date(clock.getTime() + HOUR);
		await reviseInvitation(invitationDeps, company.subject, meta, revisedOne.invitationId, {
			salaryMin: 50_000,
			salaryMax: 60_000
		});
		expect(await representativeDisclosureRequest(invitationDeps, revisedOne.token)).toBeNull();
		expect(
			(await getInvitation(invitationDeps, teen.subject, revisedOne.invitationId)).awaitingRepresentative
		).toBeNull();
		const revised = await refusal(
			grantDisclosureByRepresentative(invitationDeps, meta, { token: revisedOne.token, documentId: disclosure })
		);
		expect([revised.code, revised.reason]).toEqual(['conflict', 'request_closed']);

		// The deadline of the version passes: the link ends with it, it is not extended.
		clock = new Date();
		const late = await acceptAndAsk(teen, await employer());
		clock = new Date(clock.getTime() + 73 * HOUR);
		expect(await representativeDisclosureRequest(invitationDeps, late.token)).toBeNull();
		const expired = await refusal(
			grantDisclosureByRepresentative(invitationDeps, meta, { token: late.token, documentId: disclosure })
		);
		expect([expired.code, expired.reason]).toEqual(['not_found', 'invalid_link']);
		expect(await resendDisclosureLetter(letterDeps, meta, teen.subject, late.invitationId)).toEqual({
			ok: false,
			reason: 'not_applicable'
		});
		const [row] = await database.db.select().from(invitations).where(eq(invitations.id, late.invitationId));
		expect(row?.status).toBe('sent');
	});

	it('tells a minor without a verified representative what is missing instead of «not allowed»', async () => {
		clock = new Date();
		const teen = await shownTeenager();
		const company = await employer();
		const sent = await invite(company, teen);
		// The operator ends the representation after the invitation came: the acceptance cannot wait for anybody.
		await database.db
			.update(representations)
			.set({ status: 'ended', endedAt: clock, endReason: 'operator_revoked' })
			.where(eq(representations.id, teen.representationId));
		const error = await refusal(accept(teen, sent.invitationId, sent.termsId));
		expect(error.code).toBe('policy_violation');
		expect(error.details?.[0]).toMatchObject({ code: 'representative_consent_required' });
		expect(error.details?.[0]?.message).toMatch(/Нужно согласие представителя.*укажи законного представителя/u);
		expect(
			await database.db.select().from(consentEvents).where(eq(consentEvents.scopeInvitationId, sent.invitationId))
		).toEqual([]);
	});
});

describe('the representative revokes by the link', () => {
	const revokeDeps = () => ({ ...letterDeps, redis });
	const consentLink = (teen: Teen) => outbox.token(teen.representativeEmail, '/representative/consent');
	const revocations = (teen: Teen) =>
		database.db
			.select()
			.from(consentEvents)
			.where(and(eq(consentEvents.subjectCandidateId, teen.id), eq(consentEvents.action, 'revoke')));

	it('closes the catalog for both sides at once, notifies the candidate and sends a new link', async () => {
		clock = new Date();
		const teen = await shownTeenager();
		expect(await effectiveConsentOf(database.db, teen.id, 'catalog_visibility', clock)).not.toBeNull();
		const token = consentLink(teen);
		const form = await representativeConsentForm(database.db, crypto, token, clock);
		expect(form?.texts.map((text) => [text.kind, text.signed])).toEqual([
			['pd_processing', true],
			['catalog_visibility', true],
			['fsp_import', false]
		]);

		// Nothing chosen or nothing signed of what is chosen: nothing is written and the link keeps working.
		expect(await revokeConsentsByRepresentative(revokeDeps(), meta, token, [])).toEqual({
			ok: false,
			reason: 'nothing_chosen'
		});
		expect(await revokeConsentsByRepresentative(revokeDeps(), meta, token, ['fsp_import'])).toEqual({
			ok: false,
			reason: 'not_signed'
		});
		expect(await revocations(teen)).toEqual([]);

		const letters = outbox.count(teen.representativeEmail);
		expect(
			await revokeConsentsByRepresentative(revokeDeps(), meta, token, ['catalog_visibility', 'fsp_import'])
		).toEqual({ ok: true, revoked: ['catalog_visibility'], profileDeleted: false, letterSent: true });
		// The consent stops for both sides; the processing stays.
		expect(await effectiveConsentOf(database.db, teen.id, 'catalog_visibility', clock)).toBeNull();
		expect(await processingAllowed(database.db, teen.id, clock)).toBe(true);
		const [profile] = await database.db
			.select({ visibility: candidates.visibility })
			.from(candidates)
			.where(eq(candidates.id, teen.id));
		expect(profile?.visibility).toBe('hidden');
		const [revocation, ...more] = await revocations(teen);
		expect(more).toEqual([]);
		expect(revocation).toMatchObject({
			kind: 'catalog_visibility',
			signerKind: 'representative',
			representationId: teen.representationId,
			method: 'email_link',
			signerUserId: null
		});
		expect(revocation?.evidence).toMatchObject({ ip: '127.0.0.1', user_agent: 'vitest' });
		expect(revocation?.evidence).toHaveProperty('email_token_id');
		// The link of the revocation is spent, not merely replaced by the next letter.
		const [spent] = await database.db
			.select({ usedAt: emailTokens.usedAt })
			.from(emailTokens)
			.where(eq(emailTokens.id, (revocation?.evidence as { email_token_id: string }).email_token_id));
		expect(spent?.usedAt).toEqual(clock);
		const [journal] = await database.db
			.select({ actorKind: auditEvents.actorKind, details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'consent.revoked'), eq(auditEvents.subjectCandidateId, teen.id)));
		expect(journal).toMatchObject({
			actorKind: 'anonymous',
			details: { kind: 'catalog_visibility', representation_id: teen.representationId }
		});

		// The candidate is told what was revoked; the notification leads to the consents.
		const [notice] = await database.db
			.select()
			.from(notifications)
			.where(and(eq(notifications.userId, teen.userId), eq(notifications.type, 'representation.consents_revoked')));
		expect(notice).toMatchObject({
			category: 'account',
			objectType: 'representation',
			objectId: teen.representationId,
			payload: { representation_id: teen.representationId, catalog_visibility: true, fsp_import: false }
		});
		if (!notice) throw new Error('no notification');
		expect(await openNotification(database.db, teen.userId, notice.id, clock)).toMatchObject({
			target: { kind: 'candidate_consents' }
		});

		// The representative gets what is in force now with a new link.
		expect(outbox.count(teen.representativeEmail)).toBe(letters + 1);
		const changed = outbox.letters.at(-1);
		expect(changed?.subject).toMatch(/^Согласия законного представителя изменены/u);
		expect(changed?.text).toContain('показ профиля проверенным работодателям — не подписано');
		expect(changed?.text).toContain('обработка персональных данных — подписано');

		// The link worked once.
		expect(await revokeConsentsByRepresentative(revokeDeps(), meta, token, ['catalog_visibility'])).toEqual({
			ok: false,
			reason: 'invalid_link'
		});
		// A repeated revocation by the new link writes nothing and keeps the link working.
		const next = consentLink(teen);
		expect(await revokeConsentsByRepresentative(revokeDeps(), meta, next, ['catalog_visibility'])).toEqual({
			ok: false,
			reason: 'not_signed'
		});
		expect(await revocations(teen)).toHaveLength(1);
		expect(await representativeConsentForm(database.db, crypto, next, clock)).not.toBeNull();
		// After its term the link revokes nothing.
		clock = new Date(clock.getTime() + 7 * DAY + 1);
		expect(await revokeConsentsByRepresentative(revokeDeps(), meta, next, ['pd_processing'])).toEqual({
			ok: false,
			reason: 'invalid_link'
		});
		expect(await processingAllowed(database.db, teen.id, clock)).toBe(true);
		clock = new Date();
	});

	it('deletes the profile when the processing consent is revoked: without it the profile is not kept', async () => {
		clock = new Date();
		const teen = await shownTeenager();
		const { session } = await createSession(
			redis,
			{ userId: teen.userId, authMethod: 'password', authTime: clock, ip: null, ua: null },
			clock
		);
		const token = consentLink(teen);
		expect(await revokeConsentsByRepresentative(revokeDeps(), meta, token, ['pd_processing'])).toEqual({
			ok: true,
			revoked: ['pd_processing'],
			profileDeleted: true,
			letterSent: true
		});
		expect(await processingAllowed(database.db, teen.id, clock)).toBe(false);
		// The revocation is the representative's; the deletion does not add one of the candidate.
		expect((await revocations(teen)).map((e) => [e.kind, e.signerKind])).toEqual([['pd_processing', 'representative']]);
		const [candidate] = await database.db
			.select({ status: candidates.status, visibility: candidates.visibility })
			.from(candidates)
			.where(eq(candidates.id, teen.id));
		expect(candidate).toEqual({ status: 'deletion_pending', visibility: 'hidden' });
		const [user] = await database.db.select({ status: users.status }).from(users).where(eq(users.id, teen.userId));
		expect(user?.status).toBe('deletion_pending');
		const [representation] = await database.db
			.select({ status: representations.status, endReason: representations.endReason })
			.from(representations)
			.where(eq(representations.id, teen.representationId));
		expect(representation).toEqual({ status: 'ended', endReason: 'candidate_deleted' });
		const purges = await database.db
			.select({ status: jobs.status })
			.from(jobs)
			.where(and(eq(jobs.type, 'account.purge'), sql`${jobs.payload} ->> 'user_id' = ${teen.userId}`));
		expect(purges.map((job) => job.status)).toEqual(['queued']);
		const [requested] = await database.db
			.select({ actorKind: auditEvents.actorKind, details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'account.deletion_requested'), eq(auditEvents.subjectCandidateId, teen.id)));
		expect(requested).toMatchObject({ actorKind: 'anonymous', details: { cause: 'processing_revoked' } });
		expect(await redis.exists(`session:${session.hash}`)).toBe(0);
		// The candidate learns it by a letter: the purge leaves nobody to notify.
		const letter = outbox.letters.findLast((l) => l.to === teen.email);
		expect(letter?.subject).toMatch(/^Представитель отозвал согласие: профиль удаляется/u);
		// The representation ended: no link of it works any more.
		expect(await revokeConsentsByRepresentative(revokeDeps(), meta, token, ['catalog_visibility'])).toEqual({
			ok: false,
			reason: 'invalid_link'
		});
	});

	it("sends a new letter at the representative's own request, not more often than every 5 minutes", async () => {
		clock = new Date();
		const teen = await teenager();
		await verify(teen);
		const letters = outbox.count(teen.representativeEmail);
		await requestConsentLetterByRepresentative(letterDeps, meta, teen.representativeEmail, null);
		expect(outbox.count(teen.representativeEmail)).toBe(letters);
		clock = new Date(clock.getTime() + 6 * 60_000);
		const before = outbox.letters.length;
		await requestConsentLetterByRepresentative(letterDeps, meta, 'nobody@example.org', null);
		await requestConsentLetterByRepresentative(letterDeps, meta, 'not an address', null);
		expect(outbox.letters.length).toBe(before);
		await requestConsentLetterByRepresentative(letterDeps, meta, `  ${teen.representativeEmail.toUpperCase()} `, null);
		expect(outbox.count(teen.representativeEmail)).toBe(letters + 1);
		const letter = outbox.letters.at(-1);
		expect(letter?.subject).toMatch(/^Согласие законного представителя —/u);
		expect(letter?.text).toContain(`${APP_ORIGIN}/representative/letter`);
		const token = outbox.token(teen.representativeEmail, '/representative/consent');
		expect(await representativeConsentForm(database.db, crypto, token, clock)).not.toBeNull();
		clock = new Date();
	});

	it('answers the request of a demo session with the letters of its own candidates only', async () => {
		clock = new Date();
		const { db } = database;
		const session = async () => {
			const [row] = await db
				.insert(demoSessions)
				.values({
					joinTokenSha256: randomBytes(32).toString('hex'),
					seedBatchId: 'demo-1',
					expiresAt: new Date(Date.now() + DAY)
				})
				.returning();
			if (!row) throw new Error('demo session not inserted');
			return row.id;
		};
		// The hero outside sessions and its clones in two sessions: one person of the representative for all three.
		const original = await teenager();
		const representative = { id: original.representativeId, email: original.representativeEmail };
		const [first, second] = [await session(), await session()];
		const inFirst = await teenager({ demoSession: first, representative });
		const inSecond = await teenager({ demoSession: second, representative });
		const links = new Map<string, string>();
		await verify(original);
		links.set(original.id, outbox.token(representative.email, '/representative/consent'));
		// A clone copies the verified representation of its hero; the session's letter carries its own link.
		for (const teen of [inFirst, inSecond]) {
			await db
				.update(representations)
				.set({ status: 'authority_verified' })
				.where(eq(representations.id, teen.representationId));
			expect(
				await sendConsentLetter(letterDeps, meta, { kind: 'user', userId: teen.userId }, teen.representationId)
			).toEqual({ ok: true });
			links.set(teen.id, outbox.token(representative.email, '/representative/consent'));
		}
		const usable = async (teen: Teen) => {
			const link = links.get(teen.id);
			if (link === undefined) throw new Error('no link of the teen');
			return (await representativeConsentForm(db, crypto, link, clock)) !== null;
		};
		clock = new Date(clock.getTime() + 6 * 60_000);

		const letters = outbox.count(representative.email);
		await requestConsentLetterByRepresentative(letterDeps, meta, representative.email, first);
		expect(outbox.count(representative.email)).toBe(letters + 1);
		// The new letter withdrew the link of the first session only.
		expect([await usable(original), await usable(inFirst), await usable(inSecond)]).toEqual([true, false, true]);

		await requestConsentLetterByRepresentative(letterDeps, meta, representative.email, null);
		expect(outbox.count(representative.email)).toBe(letters + 2);
		expect([await usable(original), await usable(inSecond)]).toEqual([false, true]);
		clock = new Date();
	});
});

describe('after 18', () => {
	it('lets the candidate sign the processing consent again on the cabinet screen', async () => {
		clock = new Date();
		// Turned 18 a month ago; the consents were signed at 17 with the representative.
		const person = await teenager({ birthDate: birthDateAged(18), signedAt: new Date(Date.now() - 60 * DAY) });
		expect(await processingAllowed(database.db, person.id, clock)).toBe(false);
		const deps: AuthDeps = { db: database.db, redis, crypto, mailer: outbox, appOrigin: APP_ORIGIN, now: () => clock };
		const session = { hash: 'a'.repeat(64), userId: person.userId, authTime: clock };
		const pd = await documentId('pd_processing');
		expect(await grantProfileConsent(deps, meta, session, pd)).toEqual({ ok: true });
		expect(await processingAllowed(database.db, person.id, clock)).toBe(true);
		const [row] = await database.db
			.select({ status: candidates.status })
			.from(candidates)
			.where(eq(candidates.id, person.id));
		expect(row?.status).toBe('active');
		// Once in force there is nothing to sign again.
		expect(await grantProfileConsent(deps, meta, session, pd)).toEqual({ ok: false, reason: 'not_applicable' });
	});
});
