// A small world of offers for the tests of what happens around them — trust in companies, complaints, outgoing events:
// policies and legal texts in force, a company with a member and a published vacancy, a visible adult candidate, an
// offer sent or accepted through the real services, and a runner of job handlers on a movable clock.
import type { AccessSubject } from '$lib/server/access/permissions';
import { createFieldCrypto, type FieldCrypto } from '$lib/server/crypto/fields';
import { consentEvents, matchRulesets, productPolicies } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import type { InvitationDeps, RequestMeta } from '$lib/server/invitations/deps';
import { respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation, type OfferInput } from '$lib/server/invitations/send';
import type { JobHandler } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import type { JobPayload, JobType } from '$lib/server/jobs/registry';
import { matchRulesetParamsSchema } from '$lib/server/matching/params';
import shippedMatchRuleset from '../../taxonomy/match-ruleset.json';
import type { TestDatabase } from './database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser,
	offerTerms
} from './factories';

const DAY = 86_400_000;

export const testCrypto: FieldCrypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 9)
});

export const testMeta: RequestMeta = { requestId: 'test-request' };

export interface Employer {
	company: Awaited<ReturnType<typeof createCompany>>;
	member: Awaited<ReturnType<typeof createMember>>;
	vacancy: Awaited<ReturnType<typeof createOwnVacancy>>;
	subject: AccessSubject;
	userId: string;
}

export interface Person {
	id: string;
	userId: string;
	email: string;
	subject: AccessSubject;
}

export interface OfferWorld {
	deps: InvitationDeps;
	/** The clock of the services; tests move it. */
	clock: { now: Date };
	disclosureDocumentId: string;
	employer(options?: { demoSessionId?: string | null }): Promise<Employer>;
	candidate(options?: { demoSessionId?: string | null }): Promise<Person>;
	/** An offer the company sent and the candidate has not answered. */
	sentOffer(
		employer: Employer,
		person: Person,
		overrides?: Partial<OfferInput>
	): Promise<{ invitationId: string; termsId: string }>;
	/** An offer the candidate accepted with full name and email disclosed: its hiring process is open. */
	acceptedOffer(
		employer: Employer,
		person: Person
	): Promise<{ invitationId: string; termsId: string; processId: string }>;
	runJob<T extends JobType>(handler: JobHandler<T>, payload: JobPayload<T>, attempt?: number): Promise<boolean>;
}

/** Publishes what offers need and returns the builders over the database of the test file. */
export async function createOfferWorld(database: TestDatabase): Promise<OfferWorld> {
	const { db } = database;
	const epoch = new Date(Date.now() - 400 * DAY);
	const clock = { now: new Date() };
	const deps: InvitationDeps = { db, crypto: testCrypto, now: () => clock.now };
	const taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	await db.insert(matchRulesets).values({
		version: shippedMatchRuleset.version,
		taxonomyVersionId,
		params: matchRulesetParamsSchema.parse(shippedMatchRuleset.params)
	});
	const pd = await createPublishedDocument(db, 'pd_processing', { publishedAt: epoch });
	const catalog = await createPublishedDocument(db, 'catalog_visibility', { publishedAt: epoch });
	const disclosure = await createPublishedDocument(db, 'contact_disclosure', { publishedAt: epoch });
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
			effectiveFrom: epoch
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
			effectiveFrom: epoch
		},
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom: epoch }
	]);

	async function employer(options: { demoSessionId?: string | null } = {}): Promise<Employer> {
		const demoSessionId = options.demoSessionId ?? null;
		const company = await createCompany(db, { demoSessionId });
		const member = await createMember(db, company.id, { userId: (await createUser(db, { demoSessionId })).id });
		if (!member.userId) throw new Error('member without user');
		const vacancy = await createOwnVacancy(db, { companyId: company.id, memberId: member.id, taxonomyVersionId });
		const subject: AccessSubject = {
			userId: member.userId,
			via: 'session',
			candidate: null,
			membership: {
				memberId: member.id,
				companyId: company.id,
				role: 'owner',
				status: 'active',
				companyStatus: company.status
			},
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
		return { company, member, vacancy, subject, userId: member.userId };
	}

	async function candidate(options: { demoSessionId?: string | null } = {}): Promise<Person> {
		const demoSessionId = options.demoSessionId ?? null;
		const email = `candidate-${uuidv7()}@example.org`;
		const user = await createUser(db, { demoSessionId, emailEnc: testCrypto.encrypt(email, 'users.email') });
		const row = await createCandidate(db, {
			userId: user.id,
			lastNameEnc: testCrypto.encrypt('Иванова', 'candidates.last_name'),
			firstNameEnc: testCrypto.encrypt('Анна', 'candidates.first_name'),
			demoSessionId,
			visibility: 'catalog',
			preferences: {}
		});
		for (const document of [pd, catalog]) {
			await db.insert(consentEvents).values({
				subjectCandidateId: row.id,
				kind: document === pd ? 'pd_processing' : 'catalog_visibility',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: row.userId,
				method: 'separate_screen_button',
				evidence: {},
				occurredAt: new Date(epoch.getTime() + DAY)
			});
		}
		const subject: AccessSubject = {
			userId: row.userId,
			via: 'session',
			candidate: { id: row.id, status: 'active' },
			membership: null,
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
		return { id: row.id, userId: row.userId, email, subject };
	}

	async function sentOffer(company: Employer, person: Person, overrides: Partial<OfferInput> = {}) {
		const sent = await createInvitation(deps, company.subject, testMeta, {
			...offerTerms({ vacancyId: company.vacancy.id, salaryMin: 260_000, salaryMax: 300_000, ...overrides }),
			candidateId: person.id
		});
		return { invitationId: sent.invitationId, termsId: sent.termsId };
	}

	async function acceptedOffer(company: Employer, person: Person) {
		const sent = await sentOffer(company, person);
		const answer = await respondToInvitation(deps, person.subject, testMeta, sent.invitationId, {
			termsId: sent.termsId,
			decision: 'accept',
			discloseFields: ['full_name', 'email'],
			disclosureDocumentId: disclosure.id
		});
		if (!answer.processId) throw new Error('the acceptance opened no process');
		return { ...sent, processId: answer.processId };
	}

	async function runJob<T extends JobType>(
		handler: JobHandler<T>,
		payload: JobPayload<T>,
		attempt = 1
	): Promise<boolean> {
		const result = await handler.run({
			job: {
				id: uuidv7(),
				type: handler.type,
				payload,
				inputVersion: 'test',
				attempt,
				maxAttempts: 8,
				leaseOwner: 'test'
			},
			db,
			signal: new AbortController().signal,
			requestId: 'job:test',
			log: createLogger({}, () => undefined)
		});
		return db.transaction(async (tx) => {
			const current = await result.isCurrent(tx);
			if (current) await result.write(tx);
			return current;
		});
	}

	return {
		deps,
		clock,
		disclosureDocumentId: disclosure.id,
		employer,
		candidate,
		sentOffer,
		acceptedOffer,
		runJob
	};
}
