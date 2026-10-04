// Companies against a real database: verification by an FSP operator, the gate that vacancies and invitations ask,
// the team with its last owner, API keys and competition partnerships.
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import { can } from '$lib/server/access/permissions';
import type { RequestMeta } from '$lib/server/auth/context';
import { sha256Hex } from '$lib/server/auth/secrets';
import { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey } from '$lib/server/companies/api-keys';
import type { CompanyDeps } from '$lib/server/companies/context';
import { loadCompanyGate } from '$lib/server/companies/gate';
import {
	acceptMemberInvite,
	inviteMember,
	listMembers,
	removeMember,
	setMemberRole,
	transferOwnership
} from '$lib/server/companies/members';
import { endPartnership, openPartnership, partnershipAccess } from '$lib/server/companies/partnerships';
import { companyOverview, createCompanyDraft, updateCompanyDraft } from '$lib/server/companies/profile';
import { registryNotConfigured, type CompanyRegistry, type RegistryLookup } from '$lib/server/companies/registry';
import { companyRegistryLookup } from '$lib/server/companies/registry-check';
import { loadAccessSubject } from '$lib/server/companies/subject';
import {
	decideVerification,
	reinstateCompany,
	submitForVerification,
	suspendCompany,
	verificationCase,
	verificationQueue
} from '$lib/server/companies/verification';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	apiKeys,
	auditEvents,
	companies,
	companyMembers,
	demoSessions,
	files,
	invitations,
	invitationTerms,
	jobs,
	staffRoles,
	users
} from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { ApiError } from '$lib/server/errors/api-error';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import type { MailMessage } from '$lib/server/mail/mailer';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createOwnVacancy,
	createPolicy,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser
} from '../helpers/factories';

let database: TestDatabase;
let employerTermsId: string;
const letters: MailMessage[] = [];
const clock = { now: new Date() };
const registry: CompanyRegistry = registryNotConfigured;

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});

function deps(): CompanyDeps {
	return {
		db: database.db,
		crypto,
		mailer: {
			send(message) {
				letters.push(message);
				return Promise.resolve({ ok: true, value: { messageId: randomUUID() } });
			}
		},
		registry,
		appOrigin: 'http://app.test',
		now: () => clock.now
	};
}

beforeAll(async () => {
	database = await createTestDatabase();
	employerTermsId = (
		await createPublishedDocument(database.db, 'employer_terms', {
			publishedAt: new Date(clock.now.getTime() - 86_400_000)
		})
	).id;
});

afterAll(async () => {
	await database.drop();
});

const WEIGHTS_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];

/** A random organisation ИНН with correct check digits. */
function validInn(): string {
	const digits = Array.from(randomBytes(9), (byte) => byte % 10);
	const sum = WEIGHTS_10.reduce((total, weight, index) => total + weight * (digits[index] ?? 0), 0);
	return [...digits, (sum % 11) % 10].join('');
}

function withWrongCheckDigit(inn: string): string {
	return inn.slice(0, -1) + String((Number(inn.at(-1)) + 1) % 10);
}

function meta(): RequestMeta {
	return { requestId: `test-${randomUUID()}`, ip: '10.0.0.1', userAgent: 'vitest' };
}

function session(userId: string): Actor {
	return {
		kind: 'session',
		userId,
		sessionHash: sha256Hex(userId),
		authTime: new Date(),
		authMethod: 'password',
		csrfToken: 'csrf'
	};
}

/** The context of a request by a signed-in user, with the subject read from the database now. */
async function as(userId: string) {
	return { subject: await loadAccessSubject(database.db, session(userId)), meta: meta() };
}

async function newUser(email = `person-${randomUUID()}@example.org`) {
	const user = await createUser(database.db, {
		emailEnc: crypto.encrypt(email, 'users.email'),
		emailHmac: crypto.lookupHmac('email', email),
		displayName: 'Тестовый пользователь'
	});
	return { ...user, email };
}

async function newOperator() {
	const user = await newUser();
	await database.db.insert(staffRoles).values({ userId: user.id, role: 'operator', grantedAt: new Date() });
	return user;
}

async function evidenceFile(ownerUserId: string) {
	const [file] = await database.db
		.insert(files)
		.values({
			ownerUserId,
			purpose: 'company_authority_evidence',
			storageKey: `evidence/${randomUUID()}`,
			sha256: randomBytes(32).toString('hex'),
			sizeBytes: 1024,
			declaredName: 'доверенность.pdf',
			detectedMime: 'application/pdf',
			status: 'ready'
		})
		.returning();
	if (!file) throw new Error('file not inserted');
	return file;
}

/** An employer with a draft company, as registration leaves them. */
async function employerWithDraft(inn = validInn(), name = 'Ромашка') {
	const owner = await newUser();
	const { companyId, memberId } = await createCompanyDraft(deps(), await as(owner.id), {
		inn,
		displayName: name,
		legalName: `ООО «${name}»`,
		employerTermsId
	});
	return { owner, companyId, memberId, inn };
}

async function submit(ownerId: string, companyId: string) {
	const file = await evidenceFile(ownerId);
	return submitForVerification(deps(), await as(ownerId), companyId, {
		authorityMethod: 'power_of_attorney',
		authorityEvidenceFileId: file.id
	});
}

/** A verified company with its owner, through the real path: draft, request, operator's approval. */
async function verifiedCompany() {
	const employer = await employerWithDraft();
	const { verificationId } = await submit(employer.owner.id, employer.companyId);
	const operator = await newOperator();
	await decideVerification(deps(), await as(operator.id), verificationId, { kind: 'approve' });
	return { ...employer, operator, verificationId };
}

async function expectApiError(operation: Promise<unknown>, code: ApiError['code'], detail?: string) {
	let failure: unknown;
	try {
		await operation;
	} catch (error) {
		failure = error;
	}
	expect(failure, `expected ApiError ${code}, the operation succeeded`).toBeInstanceOf(ApiError);
	const apiError = failure as ApiError;
	expect(apiError.code).toBe(code);
	if (detail !== undefined) expect(apiError.details?.map((d) => d.code)).toContain(detail);
}

async function companyEvents(companyId: string) {
	const rows = await database.db
		.select({ action: auditEvents.action })
		.from(auditEvents)
		.where(and(eq(auditEvents.objectType, 'company'), eq(auditEvents.objectId, companyId)))
		.orderBy(auditEvents.occurredAt);
	return rows.map((row) => row.action);
}

/** The address of the recipient and the token of the last invitation letter. */
function lastInvitation() {
	const letter = letters.at(-1);
	if (!letter) throw new Error('no letter sent');
	const token = new URL(/https?:\/\/\S+/.exec(letter.text)?.[0] ?? 'http://none').searchParams.get('token');
	if (!token) throw new Error('no token in the letter');
	return { to: letter.to, token };
}

/** Runs the registry lookup job of the request as the worker would; jobs of other requests wait. */
async function runRegistryLookup(verificationId: string, lookup: RegistryLookup) {
	const { db } = database;
	await db
		.update(jobs)
		.set({ runAfter: sql`now() + interval '1 day'` })
		.where(
			and(eq(jobs.type, 'company.registry_lookup'), ne(jobs.inputVersion, verificationId), eq(jobs.status, 'queued'))
		);
	await db
		.update(jobs)
		.set({ runAfter: new Date(0) })
		.where(and(eq(jobs.inputVersion, verificationId), eq(jobs.status, 'queued')));
	const claimed = await claimJob(db, 'test-worker', ['company.registry_lookup']);
	if (claimed?.type !== 'company.registry_lookup') throw new Error('no registry lookup job to run');
	const job = claimed as ClaimedJob<'company.registry_lookup'>;
	const handler = companyRegistryLookup(() => ({ source: 'egrul', lookup: () => Promise.resolve(lookup) }));
	try {
		const result = await handler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({}, () => undefined)
		});
		return await completeJob(db, job, result);
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		return failJob(db, job, { code: error.code, retryable: error.retryable, message: error.message });
	}
}

describe('verification by an FSP operator', () => {
	it('goes draft → submitted → back for clarification → submitted → verified, closing and opening the gate', async () => {
		const { owner, companyId, inn } = await employerWithDraft();
		expect(await loadCompanyGate(database.db, companyId)).toEqual({ allowed: false, reason: 'company_not_verified' });

		// A document is required for a power of attorney.
		await expectApiError(
			submitForVerification(deps(), await as(owner.id), companyId, {
				authorityMethod: 'power_of_attorney',
				authorityEvidenceFileId: null
			}),
			'validation_failed',
			'required'
		);
		// A file of another user is not evidence of this applicant.
		const stranger = await newUser();
		const foreignFile = await evidenceFile(stranger.id);
		await expectApiError(
			submitForVerification(deps(), await as(owner.id), companyId, {
				authorityMethod: 'power_of_attorney',
				authorityEvidenceFileId: foreignFile.id
			}),
			'validation_failed',
			'not_found'
		);

		const first = await submit(owner.id, companyId);
		expect(await loadCompanyGate(database.db, companyId)).toEqual({ allowed: false, reason: 'company_not_verified' });
		await expectApiError(submit(owner.id, companyId), 'conflict', 'not_submittable');
		await expectApiError(
			updateCompanyDraft(deps(), await as(owner.id), companyId, { displayName: 'Другое' }),
			'conflict',
			'company_locked'
		);

		// The registry is a hint written by the job, never a decision.
		const lookup: RegistryLookup = {
			status: 'found',
			source: 'egrul',
			record: {
				inn,
				kind: 'organization',
				name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА"',
				shortName: 'ООО "РОМАШКА"',
				ogrn: null,
				kpp: null,
				registeredOn: '2015-03-01',
				endedOn: null,
				head: null,
				region: 'Г.Москва'
			}
		};
		expect(await runRegistryLookup(first.verificationId, lookup)).toBe('succeeded');
		const [afterLookup] = await database.db.select().from(companies).where(eq(companies.id, companyId));
		expect(afterLookup?.status).toBe('submitted');

		const operator = await newOperator();
		const queue = await verificationQueue(deps(), await as(operator.id), { registry: ['found'] });
		const item = queue.items.find((entry) => entry.companyId === companyId);
		expect(item).toMatchObject({
			verificationId: first.verificationId,
			authorityMethod: 'power_of_attorney',
			hasEvidence: true,
			attempt: 1,
			overdue: false,
			registryCheck: { status: 'found', active: true, name_match: true }
		});
		const onCase = await verificationCase(deps(), await as(operator.id), first.verificationId);
		expect(onCase.evidence?.declaredName).toBe('доверенность.pdf');

		await expectApiError(
			decideVerification(deps(), await as(operator.id), first.verificationId, { kind: 'request_info', reason: 'мало' }),
			'validation_failed',
			'invalid_length'
		);
		await decideVerification(deps(), await as(operator.id), first.verificationId, {
			kind: 'request_info',
			reason: 'Приложите доверенность с подписью руководителя'
		});
		const sentBack = await companyOverview(deps(), await as(owner.id), companyId);
		expect(sentBack.status).toBe('draft');
		expect(sentBack.verification).toMatchObject({
			state: 'needs_info',
			reason: 'Приложите доверенность с подписью руководителя'
		});
		await expectApiError(
			decideVerification(deps(), await as(operator.id), first.verificationId, { kind: 'approve' }),
			'conflict',
			'already_decided'
		);

		const second = await submit(owner.id, companyId);
		const again = await verificationQueue(deps(), await as(operator.id));
		expect(again.items.find((entry) => entry.companyId === companyId)?.attempt).toBe(2);
		await decideVerification(deps(), await as(operator.id), second.verificationId, {
			kind: 'approve',
			requisites: { legalName: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА"' }
		});
		expect(await loadCompanyGate(database.db, companyId)).toEqual({ allowed: true });
		const [verified] = await database.db.select().from(companies).where(eq(companies.id, companyId));
		expect(verified).toMatchObject({
			status: 'verified',
			legalName: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "РОМАШКА"'
		});
		expect(verified?.verifiedAt).toBeInstanceOf(Date);

		await suspendCompany(deps(), await as(operator.id), companyId, { reasonCode: 'complaint' });
		expect(await loadCompanyGate(database.db, companyId)).toEqual({ allowed: false, reason: 'company_suspended' });
		await reinstateCompany(deps(), await as(operator.id), companyId);
		expect(await loadCompanyGate(database.db, companyId)).toEqual({ allowed: true });

		expect(await companyEvents(companyId)).toEqual([
			'company.created',
			'company.submitted',
			'company.info_requested',
			'company.submitted',
			'company.verified',
			'company.suspended',
			'company.verified'
		]);
	});

	it('suspension withdraws sent invitations and keeps accepted ones', async () => {
		const { companyId, memberId, operator } = await verifiedCompany();
		const taxonomy = await createTaxonomyVersion(database.db);
		const vacancy = await createOwnVacancy(database.db, { companyId, memberId, taxonomyVersionId: taxonomy.id });
		const policy = await createPolicy(database.db, 'invitation_policy', Math.floor(Math.random() * 1_000_000) + 1);
		async function invitation(status: 'sent' | 'accepted') {
			const candidate = await createCandidate(database.db);
			const invitationId = uuidv7();
			const termsId = uuidv7();
			await database.db.transaction(async (tx) => {
				await tx.insert(invitations).values({
					id: invitationId,
					companyId,
					vacancyId: vacancy.id,
					candidateId: candidate.id,
					sentByMemberId: memberId,
					status,
					currentTermsId: termsId,
					policyId: policy.id,
					sentAt: new Date(),
					...(status === 'accepted' ? { acceptedTermsId: termsId, closedAt: new Date() } : {})
				});
				await tx.insert(invitationTerms).values({
					id: termsId,
					invitationId,
					version: 1,
					vacancySnapshot: { title: vacancy.title },
					salaryMin: 250_000,
					salaryMax: 350_000,
					salaryCurrency: 'RUB',
					salaryPeriod: 'month',
					salaryTaxBase: 'gross',
					responseDueAt: new Date(Date.now() + 72 * 3600_000),
					createdByMemberId: memberId
				});
			});
			return invitationId;
		}
		const sent = await invitation('sent');
		const accepted = await invitation('accepted');
		await suspendCompany(deps(), await as(operator.id), companyId, { reasonCode: 'complaint' });
		const statuses = await database.db
			.select({ id: invitations.id, status: invitations.status })
			.from(invitations)
			.where(eq(invitations.companyId, companyId));
		expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
			[sent]: 'withdrawn',
			[accepted]: 'accepted'
		});
	});

	it('rejects with a reason, frees the number, and a resubmission after it was taken conflicts', async () => {
		const { owner, companyId, inn } = await employerWithDraft();
		const { verificationId } = await submit(owner.id, companyId);
		const operator = await newOperator();
		await expectApiError(
			decideVerification(deps(), await as(operator.id), verificationId, { kind: 'reject', reason: ' ' }),
			'validation_failed'
		);
		await decideVerification(deps(), await as(operator.id), verificationId, {
			kind: 'reject',
			reason: 'Организация не связана с заявителем по документам'
		});
		expect(await loadCompanyGate(database.db, companyId)).toEqual({ allowed: false, reason: 'company_rejected' });

		const other = await employerWithDraft(inn, 'Настоящая Ромашка');
		expect(other.companyId).not.toBe(companyId);
		await expectApiError(submit(owner.id, companyId), 'conflict', 'inn_taken');
	});

	it('takes the number of a company of an account of a demo session within that session only', async () => {
		const [demo] = await database.db
			.insert(demoSessions)
			.values({
				joinTokenSha256: sha256Hex(randomUUID()),
				seedBatchId: 'demo-1',
				expiresAt: new Date(Date.now() + 86_400_000)
			})
			.returning({ id: demoSessions.id });
		if (!demo) throw new Error('demo session not inserted');
		const visitor = async () => {
			const user = await newUser();
			await database.db.update(users).set({ demoSessionId: demo.id }).where(eq(users.id, user.id));
			return user;
		};
		const draft = async (userId: string, inn: string) =>
			createCompanyDraft(deps(), await as(userId), { inn, displayName: 'Ромашка', employerTermsId });

		const outside = await employerWithDraft();
		const first = await visitor();
		const { companyId } = await draft(first.id, outside.inn);
		const [company] = await database.db
			.select({ session: companies.demoSessionId })
			.from(companies)
			.where(eq(companies.id, companyId));
		expect(company).toEqual({ session: demo.id });
		// Within the session the number is taken now; so is it by an edit of another draft of the session.
		await expectApiError(draft((await visitor()).id, outside.inn), 'conflict', 'inn_taken');
		const other = await visitor();
		const { companyId: otherId } = await draft(other.id, validInn());
		await expectApiError(
			updateCompanyDraft(deps(), await as(other.id), otherId, { inn: outside.inn }),
			'conflict',
			'inn_taken'
		);
		// A number taken within a session only is free outside sessions.
		const sessionOnly = validInn();
		await updateCompanyDraft(deps(), await as(other.id), otherId, { inn: sessionOnly });
		await updateCompanyDraft(deps(), await as(outside.owner.id), outside.companyId, { inn: sessionOnly });
		await expectApiError(
			updateCompanyDraft(deps(), await as(other.id), otherId, { inn: outside.inn }),
			'conflict',
			'inn_taken'
		);
	});

	it('keeps registry lookups retrying while the source is down and stores `unavailable` on the last attempt', async () => {
		const { owner, companyId } = await employerWithDraft();
		const { verificationId } = await submit(owner.id, companyId);
		await database.db.update(jobs).set({ maxAttempts: 2 }).where(eq(jobs.inputVersion, verificationId));
		const down: RegistryLookup = { status: 'unavailable', source: 'egrul', reason: 'captcha' };
		expect(await runRegistryLookup(verificationId, down)).toBe('queued');
		expect(await runRegistryLookup(verificationId, down)).toBe('succeeded');
		const operator = await newOperator();
		const onCase = await verificationCase(deps(), await as(operator.id), verificationId);
		expect(onCase.registryCheck).toMatchObject({ status: 'unavailable', reason: 'captcha' });
	});

	it('refuses a taxpayer number with wrong check digits', async () => {
		const owner = await newUser();
		await expectApiError(
			createCompanyDraft(deps(), await as(owner.id), {
				inn: withWrongCheckDigit(validInn()),
				displayName: 'Ромашка',
				employerTermsId
			}),
			'validation_failed',
			'invalid_inn'
		);
		const { owner: employer, companyId } = await employerWithDraft();
		await expectApiError(
			updateCompanyDraft(deps(), await as(employer.id), companyId, { inn: withWrongCheckDigit(validInn()) }),
			'validation_failed',
			'invalid_inn'
		);
	});

	it('lets no one but the owner manage a company, and no one but an operator decide', async () => {
		const { owner, companyId } = await employerWithDraft();
		const { owner: stranger } = await employerWithDraft();
		const { verificationId } = await submit(owner.id, companyId);

		await expectApiError(
			updateCompanyDraft(deps(), await as(stranger.id), companyId, { displayName: 'Захват' }),
			'not_found'
		);
		await expectApiError(submit(stranger.id, companyId), 'not_found');
		await expectApiError(companyOverview(deps(), await as(stranger.id), companyId), 'not_found');
		await expectApiError(
			inviteMember(deps(), await as(stranger.id), companyId, { email: 'x@example.org', role: 'owner' }),
			'not_found'
		);
		await expectApiError(
			decideVerification(deps(), await as(owner.id), verificationId, { kind: 'approve' }),
			'forbidden'
		);
		await expectApiError(verificationQueue(deps(), await as(stranger.id)), 'forbidden');
		const anonymous = { subject: await loadAccessSubject(database.db, { kind: 'anonymous' }), meta: meta() };
		await expectApiError(companyOverview(deps(), anonymous, companyId), 'unauthenticated');

		// An operator who is also in the company's team does not decide on it.
		const insider = await newOperator();
		await database.db
			.insert(companyMembers)
			.values({ companyId, userId: insider.id, role: 'recruiter', status: 'active', joinedAt: new Date() });
		await expectApiError(
			decideVerification(deps(), await as(insider.id), verificationId, { kind: 'approve' }),
			'forbidden'
		);
		const [still] = await database.db.select().from(companies).where(eq(companies.id, companyId));
		expect(still?.status).toBe('submitted');
	});

	it('keeps candidates and employers apart: a candidate cannot open a company', async () => {
		const candidate = await createCandidate(database.db);
		await expectApiError(
			createCompanyDraft(deps(), await as(candidate.userId), { inn: validInn(), displayName: 'Своя', employerTermsId }),
			'conflict',
			'already_candidate'
		);
		const { owner } = await employerWithDraft();
		await expectApiError(
			createCompanyDraft(deps(), await as(owner.id), { inn: validInn(), displayName: 'Вторая', employerTermsId }),
			'conflict',
			'already_employer'
		);
	});
});

describe('team', () => {
	it('invites by email, accepts only under that address, and one person is in one company', async () => {
		const { owner, companyId } = await verifiedCompany();
		const recruiter = await newUser();
		const { letterSent } = await inviteMember(deps(), await as(owner.id), companyId, {
			email: recruiter.email.toUpperCase(),
			role: 'recruiter'
		});
		expect(letterSent).toBe(true);
		const { to, token } = lastInvitation();
		expect(to).toBe(recruiter.email.toUpperCase());

		const wrongPerson = await newUser();
		await expectApiError(acceptMemberInvite(deps(), await as(wrongPerson.id), token), 'forbidden');
		const joined = await acceptMemberInvite(deps(), await as(recruiter.id), token);
		expect(joined).toMatchObject({ companyId, role: 'recruiter' });
		await expectApiError(acceptMemberInvite(deps(), await as(recruiter.id), token), 'not_found');

		const subject = await loadAccessSubject(database.db, session(recruiter.id));
		expect(subject.membership).toMatchObject({
			companyId,
			role: 'recruiter',
			status: 'active',
			companyStatus: 'verified'
		});
		expect(can(subject, 'catalog.search', null).allowed).toBe(true);
		// A recruiter does not manage the team.
		await expectApiError(
			inviteMember(deps(), await as(recruiter.id), companyId, { email: 'x@example.org', role: 'recruiter' }),
			'forbidden'
		);

		const { owner: otherOwner, companyId: otherCompany } = await verifiedCompany();
		await inviteMember(deps(), await as(otherOwner.id), otherCompany, { email: recruiter.email, role: 'recruiter' });
		await expectApiError(
			acceptMemberInvite(deps(), await as(recruiter.id), lastInvitation().token),
			'conflict',
			'already_employer'
		);
		const members = await listMembers(deps(), await as(owner.id), companyId);
		expect(members.map((m) => m.role).sort()).toEqual(['owner', 'recruiter']);
	});

	it('never removes or demotes the last active owner; ownership moves by transfer', async () => {
		const { owner, companyId, memberId } = await verifiedCompany();
		await expectApiError(removeMember(deps(), await as(owner.id), memberId), 'conflict', 'last_owner');
		await expectApiError(setMemberRole(deps(), await as(owner.id), memberId, 'recruiter'), 'conflict', 'last_owner');

		const second = await newUser();
		await inviteMember(deps(), await as(owner.id), companyId, { email: second.email, role: 'recruiter' });
		const { memberId: secondId } = await acceptMemberInvite(deps(), await as(second.id), lastInvitation().token);
		await transferOwnership(deps(), await as(owner.id), secondId);
		const roles = await database.db
			.select({ id: companyMembers.id, role: companyMembers.role })
			.from(companyMembers)
			.where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.status, 'active')));
		expect(Object.fromEntries(roles.map((r) => [r.id, r.role]))).toEqual({
			[memberId]: 'recruiter',
			[secondId]: 'owner'
		});
		await expectApiError(removeMember(deps(), await as(second.id), secondId), 'conflict', 'last_owner');
		await removeMember(deps(), await as(second.id), memberId);
		expect((await loadAccessSubject(database.db, session(owner.id))).membership).toBeNull();
	});

	it('of two owners removing each other at once, exactly one succeeds', async () => {
		/** Two owners of one company, each about to remove the other. */
		async function pair() {
			const { owner, companyId, memberId } = await verifiedCompany();
			const second = await newUser();
			await inviteMember(deps(), await as(owner.id), companyId, { email: second.email, role: 'owner' });
			const { memberId: secondId } = await acceptMemberInvite(deps(), await as(second.id), lastInvitation().token);
			return {
				companyId,
				first: { ctx: await as(owner.id), target: secondId },
				other: { ctx: await as(second.id), target: memberId }
			};
		}
		const pairs = [];
		for (let i = 0; i < 6; i++) pairs.push(await pair());
		// All removals start together, so without ordering by the company lock both removals of a pair would pass.
		const results = await Promise.all(
			pairs.map(({ first, other }) =>
				Promise.allSettled([
					removeMember(deps(), first.ctx, first.target),
					removeMember(deps(), other.ctx, other.target)
				])
			)
		);
		for (const [index, settled] of results.entries()) {
			expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			const owners = await database.db
				.select({ id: companyMembers.id })
				.from(companyMembers)
				.where(
					and(
						eq(companyMembers.companyId, pairs[index]?.companyId ?? ''),
						eq(companyMembers.role, 'owner'),
						eq(companyMembers.status, 'active')
					)
				);
			expect(owners).toHaveLength(1);
		}
	});
});

describe('API keys', () => {
	it('shows the secret once, stores only its hash, stops working when revoked, expired or the company closes', async () => {
		const { owner, companyId, operator } = await verifiedCompany();
		const { key, token } = await createApiKey(deps(), await as(owner.id), companyId, {
			name: 'ATS',
			permissions: ['catalog.search', 'vacancy.write'],
			expiresAt: null
		});
		// The prefix is base32; the secret is base64url and may itself contain `_`.
		const secret = /^fspk_[a-z2-7]{8}_(.+)$/.exec(token)?.[1] ?? '';
		const [stored] = await database.db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
		expect(stored?.secretHash).toBe(sha256Hex(secret));
		expect(JSON.stringify(stored)).not.toContain(secret);
		expect(JSON.stringify(await listApiKeys(deps(), await as(owner.id), companyId))).not.toContain(stored?.secretHash);

		const actor = await authenticateApiKey(database.db, token, clock.now);
		expect(actor).toMatchObject({ kind: 'api_key', apiKeyId: key.id, companyId, userId: owner.id });
		if (!actor) return;
		const [used] = await database.db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
		expect(used?.lastUsedAt).toEqual(clock.now);
		const keySubject = await loadAccessSubject(database.db, actor);
		expect(can(keySubject, 'catalog.search', null).allowed).toBe(true);
		expect(can(keySubject, 'api_key.manage', { companyId }).allowed).toBe(false);
		const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
		expect(await authenticateApiKey(database.db, tampered, clock.now)).toBeNull();

		await suspendCompany(deps(), await as(operator.id), companyId, { reasonCode: 'complaint' });
		expect(await authenticateApiKey(database.db, token, clock.now)).toBeNull();
		expect(can(await loadAccessSubject(database.db, actor), 'catalog.search', null).allowed).toBe(false);
		await reinstateCompany(deps(), await as(operator.id), companyId);
		expect(await authenticateApiKey(database.db, token, clock.now)).not.toBeNull();

		await revokeApiKey(deps(), await as(owner.id), key.id);
		expect(await authenticateApiKey(database.db, token, clock.now)).toBeNull();

		const expiring = await createApiKey(deps(), await as(owner.id), companyId, {
			name: 'short',
			permissions: ['catalog.search'],
			expiresAt: new Date(clock.now.getTime() + 60_000)
		});
		expect(await authenticateApiKey(database.db, expiring.token, clock.now)).not.toBeNull();
		expect(await authenticateApiKey(database.db, expiring.token, new Date(clock.now.getTime() + 60_000))).toBeNull();
	});

	it('grants a key only the creator’s API permissions, only to a verified company, only by its owner', async () => {
		const { owner, companyId } = await verifiedCompany();
		await expectApiError(
			createApiKey(deps(), await as(owner.id), companyId, {
				name: 'too much',
				permissions: ['api_key.manage', 'company.review'],
				expiresAt: null
			}),
			'validation_failed',
			'not_grantable'
		);
		const { owner: draftOwner, companyId: draftCompany } = await employerWithDraft();
		await expectApiError(
			createApiKey(deps(), await as(draftOwner.id), draftCompany, {
				name: 'early',
				permissions: ['catalog.search'],
				expiresAt: null
			}),
			'conflict',
			'company_not_verified'
		);
		await expectApiError(
			createApiKey(deps(), await as(draftOwner.id), companyId, {
				name: 'foreign',
				permissions: ['catalog.search'],
				expiresAt: null
			}),
			'not_found'
		);
	});

	it('revokes the keys of a removed member in the same transaction', async () => {
		const { owner, companyId } = await verifiedCompany();
		const second = await newUser();
		await inviteMember(deps(), await as(owner.id), companyId, { email: second.email, role: 'owner' });
		const { memberId: secondId } = await acceptMemberInvite(deps(), await as(second.id), lastInvitation().token);
		const created = await createApiKey(deps(), await as(second.id), companyId, {
			name: 'second',
			permissions: ['catalog.search'],
			expiresAt: null
		});
		await removeMember(deps(), await as(owner.id), secondId);
		expect(await authenticateApiKey(database.db, created.token, clock.now)).toBeNull();
		const [revoked] = await database.db.select().from(apiKeys).where(eq(apiKeys.id, created.key.id));
		expect(revoked?.revokedAt).toEqual(clock.now);
	});
});

describe('competition partnerships', () => {
	it('an operator opens it for a verified company; suspension and the end close the pool at once', async () => {
		const { owner, companyId, operator } = await verifiedCompany();
		const today = clock.now.toISOString().slice(0, 10);
		const input = {
			companyId,
			competitionRef: `cmp-${randomUUID()}`,
			kind: 'case_provider' as const,
			validFrom: today,
			validTo: null,
			basis: 'Договор о партнёрстве № 12'
		};
		await expectApiError(openPartnership(deps(), await as(owner.id), input), 'forbidden');
		const { partnershipId } = await openPartnership(deps(), await as(operator.id), input);
		await expectApiError(openPartnership(deps(), await as(operator.id), input), 'conflict', 'already_partner');
		expect(await partnershipAccess(database.db, partnershipId, clock.now)).toMatchObject({
			partnershipCompanyId: companyId,
			partnershipActive: true,
			poolRule: { min_award: 'finalist', stages: ['final'] }
		});

		await suspendCompany(deps(), await as(operator.id), companyId, { reasonCode: 'terms_violation' });
		expect((await partnershipAccess(database.db, partnershipId, clock.now))?.partnershipActive).toBe(false);
		await reinstateCompany(deps(), await as(operator.id), companyId);
		await endPartnership(deps(), await as(operator.id), partnershipId);
		expect((await partnershipAccess(database.db, partnershipId, clock.now))?.partnershipActive).toBe(false);

		const { companyId: draftCompany } = await employerWithDraft();
		await expectApiError(
			openPartnership(deps(), await as(operator.id), { ...input, companyId: draftCompany }),
			'conflict',
			'company_not_verified'
		);
	});
});
