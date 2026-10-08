// Stored files against a real object storage: an upload is checked by content before anything is stored, and a file is handed
// out only to its owner, to a company that received the resume by an accepted invitation or by an application to its
// vacancy, to an operator within a
// case (a company verification, a representative's authority), to an administrator for the report of an
// evaluation run and to the FSP operator for the source file of a results batch — every attempt in the journal, every
// refusal answered as «not found».
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	applications,
	auditEvents,
	authorityChecks,
	companyVerifications,
	consentEvents,
	evalRuns,
	files,
	invitations,
	invitationTerms,
	legalRepresentatives,
	productPolicies,
	representations,
	resumeDocuments
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { uuidv7 } from '$lib/server/ids';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { revokeDisclosureConsent } from '$lib/server/invitations/disclosure';
import { uploadResume } from '$lib/server/resumes/upload';
import { openFile, type FileAccessContext } from '$lib/server/storage/access';
import { S3ObjectStore, type ObjectStore } from '$lib/server/storage/object-store';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser,
	offerTermsRow
} from '../helpers/factories';
import { testCrypto } from '../helpers/contact';
import { startStorage } from '../helpers/storage';

let storage: StartedTestContainer;
let database: TestDatabase;
let store: ObjectStore;
const meta: RequestMeta = { requestId: 'test-request', ip: '127.0.0.1', userAgent: 'vitest' };
const now = () => new Date();

const NO_STAFF = { operator: false, admin: false, extraPermissions: [] };

function candidateSubject(candidate: { id: string; userId: string }): AccessSubject {
	return {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: NO_STAFF
	};
}

function memberSubject(member: { id: string; userId: string; companyId: string }): AccessSubject {
	return {
		userId: member.userId,
		via: 'session',
		candidate: null,
		membership: {
			memberId: member.id,
			companyId: member.companyId,
			role: 'owner',
			status: 'active',
			companyStatus: 'verified'
		},
		staff: NO_STAFF
	};
}

const text = (value: string) => new Uint8Array(new TextEncoder().encode(value));

function staffSubject(userId: string, role: 'operator' | 'admin'): AccessSubject {
	return {
		userId,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: role === 'operator', admin: role === 'admin', extraPermissions: [] }
	};
}

/** A ready file of the purpose stored in the bucket, as the upload paths leave it. */
async function storedFile(
	ownerUserId: string,
	purpose: 'company_authority_evidence' | 'authority_evidence' | 'export' | 'source_batch',
	content: string
): Promise<string> {
	const id = uuidv7();
	const bytes = text(content);
	const storageKey = `${purpose}/${id}`;
	await store.put(storageKey, bytes, 'text/plain; charset=utf-8');
	await database.db.insert(files).values({
		id,
		ownerUserId,
		purpose,
		storageKey,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		sizeBytes: bytes.byteLength,
		declaredName: `${purpose}.txt`,
		detectedMime: 'text/plain; charset=utf-8',
		status: 'ready'
	});
	return id;
}

async function caseAccessOf(fileId: string) {
	return database.db
		.select({ details: auditEvents.details, subject: auditEvents.subjectCandidateId })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'operator.case_access'), eq(auditEvents.objectId, fileId)));
}

async function read(subject: AccessSubject, fileId: string, context: FileAccessContext): Promise<string> {
	const download = await openFile({ db: database.db, store, now }, subject, fileId, context, meta);
	return new Response(download.body).text();
}

async function expectRefused(subject: AccessSubject, fileId: string, context: FileAccessContext, reason: string) {
	const refusal = await openFile({ db: database.db, store, now }, subject, fileId, context, meta).then(
		() => null,
		(error: unknown) => error
	);
	expect(refusal).toBeInstanceOf(ApiError);
	expect((refusal as ApiError).code).toBe('not_found');
	// The journal entry of this very attempt: earlier refusals of the same file must not stand in for it.
	const [latest] = await database.db
		.select({ outcome: auditEvents.outcome, details: auditEvents.details })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'file.downloaded'), eq(auditEvents.objectId, fileId)))
		.orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
		.limit(1);
	expect(latest).toEqual({ outcome: 'denied', details: expect.objectContaining({ reason }) as unknown });
}

let candidate: Awaited<ReturnType<typeof createCandidate>>;
let resumeFileId: string;
let documents: Record<'pd' | 'disclosure', { id: string }>;
let policyId: string;

/**
 * An invitation of a new company to the candidate — accepted, with the disclosure consent listing `fields`, or still
 * awaiting the answer, with no consent.
 */
async function recipient(fields: string[], status: 'accepted' | 'sent' = 'accepted') {
	const company = await createCompany(database.db);
	const member = await createMember(database.db, company.id);
	const invitationId = uuidv7();
	const termsId = uuidv7();
	const sentAt = new Date(Date.now() - 3_600_000);
	await database.db.transaction(async (tx) => {
		await tx.insert(invitations).values({
			id: invitationId,
			companyId: company.id,
			candidateId: candidate.id,
			sentByMemberId: member.id,
			status,
			currentTermsId: termsId,
			acceptedTermsId: status === 'accepted' ? termsId : null,
			policyId,
			sentAt
		});
		await tx.insert(invitationTerms).values({
			id: termsId,
			invitationId,
			version: 1,
			...offerTermsRow(),
			salaryMin: 250_000,
			salaryMax: 350_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			responseDueAt: new Date(Date.now() + 72 * 3_600_000),
			createdByMemberId: member.id,
			createdAt: sentAt
		});
		if (status !== 'accepted') return;
		await tx.insert(consentEvents).values({
			subjectCandidateId: candidate.id,
			kind: 'contact_disclosure',
			documentId: documents.disclosure.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: candidate.userId,
			scopeCompanyId: company.id,
			scopeInvitationId: invitationId,
			scopeFields: fields,
			method: 'separate_screen_button',
			evidence: { ip: '127.0.0.1' },
			occurredAt: new Date(Date.now() - 60_000)
		});
	});
	if (member.userId === null) throw new Error('member without a user');
	return { subject: memberSubject({ id: member.id, userId: member.userId, companyId: company.id }), invitationId };
}

/** An application of the candidate to a vacancy of a new company, with the disclosure consent listing `fields`. */
async function applicant(fields: string[]) {
	const company = await createCompany(database.db);
	const member = await createMember(database.db, company.id);
	const taxonomy = await createTaxonomyVersion(database.db);
	const vacancy = await createOwnVacancy(database.db, {
		companyId: company.id,
		memberId: member.id,
		taxonomyVersionId: taxonomy.id
	});
	const applicationId = uuidv7();
	await database.db.transaction(async (tx) => {
		await tx.insert(applications).values({
			id: applicationId,
			candidateId: candidate.id,
			companyId: company.id,
			vacancyId: vacancy.id,
			match: {},
			status: 'submitted',
			submittedAt: new Date(Date.now() - 120_000)
		});
		await tx.insert(consentEvents).values({
			subjectCandidateId: candidate.id,
			kind: 'contact_disclosure',
			documentId: documents.disclosure.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: candidate.userId,
			scopeCompanyId: company.id,
			scopeApplicationId: applicationId,
			scopeFields: fields,
			method: 'separate_screen_button',
			evidence: { ip: '127.0.0.1' },
			occurredAt: new Date(Date.now() - 60_000)
		});
	});
	if (member.userId === null) throw new Error('member without a user');
	return { subject: memberSubject({ id: member.id, userId: member.userId, companyId: company.id }), applicationId };
}

beforeAll(async () => {
	const [started, created] = await Promise.all([startStorage(), createTestDatabase()]);
	storage = started.container;
	database = created;
	store = new S3ObjectStore(started.settings);
	const { db } = database;
	const published = { publishedAt: new Date(Date.now() - 86_400_000) };
	documents = {
		pd: await createPublishedDocument(db, 'pd_processing', published),
		disclosure: await createPublishedDocument(db, 'contact_disclosure', published)
	};
	const [policy] = await db
		.insert(productPolicies)
		.values({
			kind: 'invitation_policy',
			version: 1,
			params: {
				response_window_hours: 72,
				decline_reason_codes: ['other'],
				reason_required: false,
				max_open_per_company_per_day: 50,
				reopen_cooldown_days: 14,
				max_reopens: 2
			},
			effectiveFrom: new Date(Date.now() - 86_400_000)
		})
		.returning();
	if (!policy) throw new Error('policy not inserted');
	policyId = policy.id;

	candidate = await createCandidate(db);
	await db.insert(consentEvents).values({
		subjectCandidateId: candidate.id,
		kind: 'pd_processing',
		documentId: documents.pd.id,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: candidate.userId,
		method: 'separate_screen_button',
		evidence: { ip: '127.0.0.1' },
		occurredAt: new Date(Date.now() - 3_600_000)
	});
	const uploaded = await uploadResume(
		{ db, store, now },
		candidateSubject(candidate),
		{ bytes: text('Резюме: Go, PostgreSQL, Kubernetes'), declaredName: 'C:\\Users\\me\\резюме.txt' },
		meta
	);
	resumeFileId = uploaded.fileId;
}, 180_000);

afterAll(async () => {
	await database.drop();
	await storage.stop();
});

describe('upload', () => {
	it('stores the object under an application key with the hash and the detected type', async () => {
		const [file] = await database.db.select().from(files).where(eq(files.id, resumeFileId));
		expect(file).toMatchObject({
			purpose: 'resume',
			storageKey: `resume/${resumeFileId}`,
			declaredName: 'резюме.txt',
			detectedMime: 'text/plain; charset=utf-8',
			status: 'uploaded'
		});
		expect(await store.exists(`resume/${resumeFileId}`)).toBe(true);
	});

	it('refuses content the parser cannot read and an oversize file before storing anything', async () => {
		const subject = candidateSubject(await createCandidate(database.db));
		const deps = { db: database.db, store, now };
		const binary = uploadResume(deps, subject, { bytes: Uint8Array.of(0, 1, 2, 0xfe), declaredName: 'cv.pdf' }, meta);
		await expect(binary).rejects.toMatchObject({ code: 'validation_failed' });
		const huge = new Uint8Array(10 * 1024 * 1024 + 1).fill(0x41);
		await expect(uploadResume(deps, subject, { bytes: huge, declaredName: 'cv.txt' }, meta)).rejects.toMatchObject({
			code: 'validation_failed'
		});
		const rows = await database.db
			.select()
			.from(files)
			.where(eq(files.ownerUserId, subject.userId ?? ''));
		expect(rows).toEqual([]);
	});
});

describe('handing out a file', () => {
	it('gives the resume to the company of an accepted invitation whose consent lists it and records the download', async () => {
		const { subject, invitationId } = await recipient(['full_name', 'email', 'resume']);
		expect(await read(subject, resumeFileId, { kind: 'invitation', invitationId })).toBe(
			'Резюме: Go, PostgreSQL, Kubernetes'
		);
		const events = await database.db
			.select({ outcome: auditEvents.outcome, subject: auditEvents.subjectCandidateId })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'file.downloaded'), eq(auditEvents.objectId, resumeFileId)));
		expect(events).toContainEqual({ outcome: 'success', subject: candidate.id });
	});

	it('does not give the resume when the consent leaves it out or the invitation is someone else’s', async () => {
		const withoutResume = await recipient(['full_name', 'email']);
		await expectRefused(
			withoutResume.subject,
			resumeFileId,
			{ kind: 'invitation', invitationId: withoutResume.invitationId },
			'resume_not_disclosed'
		);
		const other = await recipient(['full_name', 'email', 'resume']);
		await expectRefused(
			withoutResume.subject,
			resumeFileId,
			{ kind: 'invitation', invitationId: other.invitationId },
			'not_recipient'
		);
	});

	it('does not give the resume by an invitation the candidate has not accepted', async () => {
		const { subject, invitationId } = await recipient([], 'sent');
		await expectRefused(subject, resumeFileId, { kind: 'invitation', invitationId }, 'not_recipient');
	});

	it('stops giving the resume once the candidate revokes the disclosure consent of the invitation', async () => {
		const { subject, invitationId } = await recipient(['full_name', 'email', 'resume']);
		expect(await read(subject, resumeFileId, { kind: 'invitation', invitationId })).toContain('PostgreSQL');
		await revokeDisclosureConsent(
			{ db: database.db, crypto: testCrypto, now },
			candidateSubject(candidate),
			meta,
			invitationId
		);
		await expectRefused(subject, resumeFileId, { kind: 'invitation', invitationId }, 'not_recipient');
	});

	it('gives the resume to the company of an application whose consent lists it', async () => {
		const { subject, applicationId } = await applicant(['full_name', 'email', 'resume']);
		expect(await read(subject, resumeFileId, { kind: 'application', applicationId })).toContain('PostgreSQL');
	});

	it('does not give the resume by an application when the consent leaves it out, it is withdrawn or someone else’s', async () => {
		const withoutResume = await applicant(['full_name', 'email']);
		await expectRefused(
			withoutResume.subject,
			resumeFileId,
			{ kind: 'application', applicationId: withoutResume.applicationId },
			'resume_not_disclosed'
		);
		const other = await applicant(['full_name', 'email', 'resume']);
		await expectRefused(
			withoutResume.subject,
			resumeFileId,
			{ kind: 'application', applicationId: other.applicationId },
			'not_recipient'
		);
		const now = new Date();
		await database.db
			.update(applications)
			.set({ status: 'withdrawn', closedAt: now })
			.where(eq(applications.id, other.applicationId));
		await expectRefused(
			other.subject,
			resumeFileId,
			{ kind: 'application', applicationId: other.applicationId },
			'application_missing'
		);
	});

	it('stops giving an archived resume to the recipient once a new one is current', async () => {
		const { subject, invitationId } = await recipient(['full_name', 'email', 'resume']);
		await uploadResume(
			{ db: database.db, store, now },
			candidateSubject(candidate),
			{ bytes: text('Новое резюме: Rust'), declaredName: 'new.txt' },
			meta
		);
		const [old] = await database.db
			.select({ isCurrent: resumeDocuments.isCurrent })
			.from(resumeDocuments)
			.where(eq(resumeDocuments.fileId, resumeFileId));
		expect(old?.isCurrent).toBe(false);
		await expectRefused(subject, resumeFileId, { kind: 'invitation', invitationId }, 'not_current_resume');
	});
});

describe('case files and the evaluation report', () => {
	it('gives the authority document of a verification request to an operator within that request', async () => {
		const company = await createCompany(database.db, { status: 'submitted', verifiedAt: null });
		const owner = await createMember(database.db, company.id);
		if (owner.userId === null) throw new Error('member without a user');
		const evidenceId = await storedFile(owner.userId, 'company_authority_evidence', 'Приказ о назначении директора');
		const [verification] = await database.db
			.insert(companyVerifications)
			.values({
				companyId: company.id,
				applicantMemberId: owner.id,
				authorityMethod: 'director_self',
				authorityEvidenceFileId: evidenceId
			})
			.returning();
		if (!verification) throw new Error('verification not inserted');
		const other = await createCompany(database.db, { status: 'submitted', verifiedAt: null });
		const otherOwner = await createMember(database.db, other.id);
		const [otherVerification] = await database.db
			.insert(companyVerifications)
			.values({ companyId: other.id, applicantMemberId: otherOwner.id, authorityMethod: 'corporate_email_domain' })
			.returning();
		if (!otherVerification) throw new Error('verification not inserted');
		const operator = staffSubject((await createUser(database.db)).id, 'operator');
		const moderation = { kind: 'case', caseType: 'moderation', caseId: verification.id } as const;

		expect(await read(operator, evidenceId, moderation)).toBe('Приказ о назначении директора');
		expect(await caseAccessOf(evidenceId)).toEqual([
			{ details: { case_type: 'moderation', case_id: verification.id }, subject: null }
		]);

		await expectRefused(
			operator,
			evidenceId,
			{ kind: 'case', caseType: 'moderation', caseId: otherVerification.id },
			'no_case_access'
		);
		await expectRefused({ ...operator, staff: NO_STAFF }, evidenceId, moderation, 'no_case_access');
		await expectRefused(candidateSubject(candidate), evidenceId, moderation, 'no_case_access');
		// A file of another purpose is not the case's document, whatever the request.
		await expectRefused(
			operator,
			resumeFileId,
			{ kind: 'case', caseType: 'moderation', caseId: verification.id },
			'not_case_file'
		);
		expect(await caseAccessOf(evidenceId)).toHaveLength(1);
	});

	it('gives the copy of a representative’s document to an operator within that representation only', async () => {
		const ward = await createCandidate(database.db, { birthDate: '2010-03-01' });
		const operatorUser = await createUser(database.db);
		const operator = staffSubject(operatorUser.id, 'operator');
		async function representation(): Promise<string> {
			const [representative] = await database.db
				.insert(legalRepresentatives)
				.values({ fullNameEnc: randomBytes(24), emailEnc: randomBytes(24), emailHmac: randomBytes(32).toString('hex') })
				.returning();
			if (!representative) throw new Error('representative not inserted');
			const [row] = await database.db
				.insert(representations)
				.values({
					candidateId: ward.id,
					representativeId: representative.id,
					relation: 'parent',
					status: 'authority_verified',
					invitedAt: new Date(Date.now() - 86_400_000),
					contactConfirmedAt: new Date(Date.now() - 3_600_000)
				})
				.returning();
			if (!row) throw new Error('representation not inserted');
			return row.id;
		}
		const representationId = await representation();
		const otherRepresentationId = await representation();
		const copyId = await storedFile(ward.userId, 'authority_evidence', 'Свидетельство о рождении');
		await database.db.insert(authorityChecks).values({
			representationId,
			method: 'document_upload',
			basisKind: 'birth_certificate',
			evidenceFileId: copyId,
			evidenceRetentionUntil: '2027-01-01',
			checkedBy: operatorUser.id,
			checkedAt: new Date(),
			result: 'verified'
		});
		const authority = { kind: 'case', caseType: 'authority', caseId: representationId } as const;

		expect(await read(operator, copyId, authority)).toBe('Свидетельство о рождении');
		expect(await caseAccessOf(copyId)).toEqual([
			{ details: { case_type: 'authority', case_id: representationId }, subject: ward.id }
		]);

		await expectRefused(
			operator,
			copyId,
			{ kind: 'case', caseType: 'authority', caseId: otherRepresentationId },
			'no_case_access'
		);
		await expectRefused(candidateSubject(ward), copyId, authority, 'no_case_access');
		await expectRefused(staffSubject(operatorUser.id, 'admin'), copyId, authority, 'no_case_access');
		await expectRefused(
			operator,
			copyId,
			{ kind: 'case', caseType: 'moderation', caseId: representationId },
			'not_case_file'
		);
		expect(await caseAccessOf(copyId)).toHaveLength(1);
	});

	it('gives the report of an evaluation run to an administrator', async () => {
		const adminUser = await createUser(database.db);
		const reportId = await storedFile(adminUser.id, 'export', '{"f1": 0.91}');
		const run = (reportFileId: string | null) => ({
			productRevision: 'abc1234',
			datasetId: 'synthetic-v1',
			datasetSize: 10,
			datasetProvenance: 'synthetic' as const,
			split: 'holdout',
			versions: {},
			processingMode: 'model' as const,
			thresholds: {},
			metrics: {},
			reportFileId
		});
		const [withReport] = await database.db.insert(evalRuns).values(run(reportId)).returning();
		const [withoutReport] = await database.db.insert(evalRuns).values(run(null)).returning();
		if (!withReport || !withoutReport) throw new Error('evaluation runs not inserted');

		expect(
			await read(staffSubject(adminUser.id, 'admin'), reportId, { kind: 'eval_report', runId: withReport.id })
		).toBe('{"f1": 0.91}');
		await expectRefused(
			staffSubject(adminUser.id, 'admin'),
			reportId,
			{ kind: 'eval_report', runId: withoutReport.id },
			'not_eval_report'
		);
		await expectRefused(
			staffSubject((await createUser(database.db)).id, 'operator'),
			reportId,
			{ kind: 'eval_report', runId: withReport.id },
			'not_admin'
		);
		await expectRefused(
			candidateSubject(candidate),
			reportId,
			{ kind: 'eval_report', runId: withReport.id },
			'not_admin'
		);
		expect(await caseAccessOf(reportId)).toEqual([]);
	});

	it('gives the source file of an FSP results batch to any operator, not to the administrator or others', async () => {
		const uploader = await createUser(database.db);
		const batchId = await storedFile(uploader.id, 'source_batch', 'ФСП ID;Место\nFSP-000101;1\n');
		const colleague = await createUser(database.db);
		expect(await read(staffSubject(colleague.id, 'operator'), batchId, { kind: 'source_batch' })).toBe(
			'ФСП ID;Место\nFSP-000101;1\n'
		);
		const downloads = await database.db
			.select({ outcome: auditEvents.outcome, details: auditEvents.details, actor: auditEvents.actorUserId })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'file.downloaded'), eq(auditEvents.objectId, batchId)));
		expect(downloads).toEqual([
			{ outcome: 'success', details: { context: 'source_batch', purpose: 'source_batch' }, actor: colleague.id }
		]);

		const adminUser = await createUser(database.db);
		await expectRefused(staffSubject(adminUser.id, 'admin'), batchId, { kind: 'source_batch' }, 'no_import_right');
		await expectRefused(candidateSubject(candidate), batchId, { kind: 'source_batch' }, 'no_import_right');
		// The right reads batch files only: another file of the storage stays closed to the operator.
		const report = await storedFile(adminUser.id, 'export', '{"f1": 0.91}');
		await expectRefused(staffSubject(colleague.id, 'operator'), report, { kind: 'source_batch' }, 'not_source_batch');
		expect(await caseAccessOf(batchId)).toEqual([]);
	});
});
