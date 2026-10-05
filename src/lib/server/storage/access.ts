// Handing out a stored file (docs/domain.md, sections 14, 15.1): only through the application, after an access check,
// and every attempt is a journal event. Who may read a file:
// - its owner;
// - a company that received the resume by an accepted invitation: `canShow` in the invitation context gives the
//   recipient projection and the disclosure consent of that invitation lists `resume`;
// - an operator within a case in its reach (a clone operator of a demo session — a case of its session only, domain
//   19.3), recorded as case access: the authority document of a company's verification request, the copy of a
//   representative's authority document;
// - an administrator: the report file of an evaluation run;
// - a holder of `fsp.import` (the FSP operator): the source file of an imported batch of FSP results loaded by an
//   account in its reach — a clone of a demo session loads no batch, so it reads none.
// The file is streamed from the bucket through the application: a presigned link would outlive a revoked consent and
// would expose the storage, which is reachable from the internal network only.
import { and, eq } from 'drizzle-orm';
import { StaffReach } from '$lib/server/access/demo-actor';
import { can, rolesOf, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Executor } from '$lib/server/db';
import {
	authorityChecks,
	candidates,
	companies,
	companyVerifications,
	evalRuns,
	invitations,
	representations,
	resumeDocuments,
	users
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { loadVacancy } from '$lib/server/invitations/records';
import { showInInvitationContext } from '$lib/server/invitations/visibility';
import { fileById, type FileRow } from './files';
import type { ObjectStore } from './object-store';

/** On what grounds the file is asked for. */
export type FileAccessContext =
	| { kind: 'owner' }
	| { kind: 'invitation'; invitationId: string }
	/**
	 * A case of the FSP operator: `moderation` — a company verification request, `authority` — a representation whose
	 * authority is checked.
	 */
	| { kind: 'case'; caseType: CaseType; caseId: string }
	/** An evaluation run whose report the administrator reads. */
	| { kind: 'eval_report'; runId: string }
	/** The source file of an FSP results batch (an export or a protocol), read by whoever may import batches. */
	| { kind: 'source_batch' };

type CaseType = 'moderation' | 'authority';

export interface FileAccessDeps {
	db: Database;
	store: ObjectStore;
	now: () => Date;
}

export interface FileDownload {
	fileId: string;
	body: ReadableStream<Uint8Array>;
	sizeBytes: number;
	/** Type detected from the content at upload, not the one the browser sent. */
	contentType: string;
	/** The original file name; the route puts it into `Content-Disposition`. */
	declaredName: string;
}

export type FileDenyReason =
	| 'file_missing'
	| 'not_owner'
	| 'not_resume'
	| 'invitation_missing'
	| 'not_current_resume'
	| 'not_recipient'
	| 'resume_not_disclosed'
	| 'no_case_access'
	| 'not_case_file'
	| 'not_admin'
	| 'not_eval_report'
	| 'no_import_right'
	| 'not_source_batch';

type Decision =
	| { allowed: true; candidateId: string | null; caseAccess: { caseType: CaseType; caseId: string } | null }
	| { allowed: false; reason: FileDenyReason; candidateId: string | null };

const deny = (reason: FileDenyReason, candidateId: string | null = null): Decision => ({
	allowed: false,
	reason,
	candidateId
});

/** The candidate whose resume the file is; `null` — the file is not a resume. */
async function resumeOwner(
	executor: Executor,
	fileId: string
): Promise<{ candidateId: string; isCurrent: boolean } | null> {
	const [row] = await executor
		.select({ candidateId: resumeDocuments.candidateId, isCurrent: resumeDocuments.isCurrent })
		.from(resumeDocuments)
		.where(eq(resumeDocuments.fileId, fileId));
	return row ?? null;
}

async function decide(
	deps: FileAccessDeps,
	subject: AccessSubject,
	file: FileRow,
	context: FileAccessContext
): Promise<Decision> {
	const resume = file.purpose === 'resume' ? await resumeOwner(deps.db, file.id) : null;
	const candidateId = resume?.candidateId ?? null;

	switch (context.kind) {
		case 'owner':
			return subject.via === 'session' && subject.userId === file.ownerUserId
				? { allowed: true, candidateId, caseAccess: null }
				: deny('not_owner', candidateId);

		case 'invitation': {
			if (!resume) return deny('not_resume');
			const [invitation] = await deps.db.select().from(invitations).where(eq(invitations.id, context.invitationId));
			if (!invitation || invitation.purgedAt !== null || invitation.candidateId !== resume.candidateId) {
				return deny('invitation_missing', candidateId);
			}
			// The recipient receives the resume the candidate has now, as the recipient card shows it.
			if (!resume.isCurrent) return deny('not_current_resume', candidateId);
			const vacancy = await loadVacancy(deps.db, invitation.vacancyId);
			if (!vacancy) throw new Error(`vacancy of invitation ${invitation.id} does not exist`);
			const { decision, disclosure } = await showInInvitationContext(deps.db, subject, invitation, vacancy, deps.now());
			if (!can(subject, 'candidate.card.read', { show: decision }).allowed) return deny('not_recipient', candidateId);
			if (!decision.allowed || decision.projection !== 'recipient') return deny('not_recipient', candidateId);
			if (!disclosure?.fields.includes('resume')) return deny('resume_not_disclosed', candidateId);
			return { allowed: true, candidateId, caseAccess: null };
		}

		case 'case':
			if (subject.via !== 'session' || !rolesOf(subject).has('operator')) return deny('no_case_access', candidateId);
			return decideCase(deps, await StaffReach.of(deps.db, subject), file, context);

		case 'eval_report': {
			if (subject.via !== 'session' || !rolesOf(subject).has('admin')) return deny('not_admin');
			const [run] = await deps.db
				.select({ id: evalRuns.id })
				.from(evalRuns)
				.where(and(eq(evalRuns.id, context.runId), eq(evalRuns.reportFileId, file.id)));
			if (!run) return deny('not_eval_report');
			return { allowed: true, candidateId: null, caseAccess: null };
		}

		case 'source_batch':
			if (subject.via !== 'session' || !can(subject, 'fsp.import', null).allowed) return deny('no_import_right');
			if (file.purpose !== 'source_batch') return deny('not_source_batch');
			if (!(await ownerInReach(deps.db, await StaffReach.of(deps.db, subject), file))) return deny('no_import_right');
			return { allowed: true, candidateId: null, caseAccess: null };
	}
}

/** Whether the account that stored the file is in the reach of the reader. */
async function ownerInReach(executor: Executor, reach: StaffReach, file: FileRow): Promise<boolean> {
	const [owner] = await executor
		.select({ session: users.demoSessionId })
		.from(users)
		.where(eq(users.id, file.ownerUserId));
	if (!owner) throw new Error(`owner of file ${file.id} is missing`);
	return reach.includes(owner.session);
}

/** The operator's case access: the case must be in the operator's reach and the file the one the case holds. */
async function decideCase(
	deps: FileAccessDeps,
	reach: StaffReach,
	file: FileRow,
	context: Extract<FileAccessContext, { kind: 'case' }>
): Promise<Decision> {
	const granted = (candidateId: string | null): Decision => ({
		allowed: true,
		candidateId,
		caseAccess: { caseType: context.caseType, caseId: context.caseId }
	});
	switch (context.caseType) {
		case 'moderation': {
			if (file.purpose !== 'company_authority_evidence') return deny('not_case_file');
			const [verification] = await deps.db
				.select({ id: companyVerifications.id })
				.from(companyVerifications)
				.innerJoin(companies, eq(companies.id, companyVerifications.companyId))
				.where(
					and(
						eq(companyVerifications.id, context.caseId),
						eq(companyVerifications.authorityEvidenceFileId, file.id),
						reach.rows(companies.demoSessionId)
					)
				);
			return verification ? granted(null) : deny('no_case_access');
		}
		case 'authority': {
			if (file.purpose !== 'authority_evidence') return deny('not_case_file');
			const [check] = await deps.db
				.select({ candidateId: representations.candidateId })
				.from(authorityChecks)
				.innerJoin(representations, eq(representations.id, authorityChecks.representationId))
				.innerJoin(candidates, eq(candidates.id, representations.candidateId))
				.where(
					and(
						eq(authorityChecks.representationId, context.caseId),
						eq(authorityChecks.evidenceFileId, file.id),
						reach.rows(candidates.demoSessionId)
					)
				);
			return check ? granted(check.candidateId) : deny('no_case_access');
		}
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A company member reads a file for the company; anyone else reads it in their own name. */
const sideOf = (context: FileAccessContext) => (context.kind === 'invitation' ? 'company' : 'candidate');

/**
 * Opens a stored file for the subject. A refusal is `not_found` whatever the reason — an outside viewer does not learn
 * whether the file exists — and the reason goes to the journal.
 */
export async function openFile(
	deps: FileAccessDeps,
	subject: AccessSubject,
	fileId: string,
	context: FileAccessContext,
	meta: RequestMeta
): Promise<FileDownload> {
	const file = UUID.test(fileId) ? await fileById(deps.db, fileId) : null;
	const decision: Decision =
		!file || file.status === 'deleted' ? deny('file_missing') : await decide(deps, subject, file, context);
	const journal = {
		actor: auditActor(subject, meta, sideOf(context)),
		object: { type: 'file', id: fileId },
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		occurredAt: deps.now(),
		...(decision.candidateId === null ? {} : { subjectCandidateId: decision.candidateId })
	};
	if (!decision.allowed) {
		await recordAuditEvent(deps.db, {
			...journal,
			action: 'file.downloaded',
			outcome: 'denied',
			details: { reason: decision.reason, context: context.kind }
		});
		throw new ApiError('not_found');
	}
	if (!file) throw new Error('an allowed decision without a file');

	const object = await deps.store.get(file.storageKey);
	if (!object) throw new Error(`object of file ${file.id} is missing from the storage`);
	if (object.sizeBytes !== file.sizeBytes) {
		await object.body.cancel();
		throw new Error(`object of file ${file.id} has ${object.sizeBytes} bytes, the record says ${file.sizeBytes}`);
	}
	await deps.db.transaction(async (tx) => {
		if (decision.caseAccess) {
			await recordAuditEvent(tx, {
				...journal,
				action: 'operator.case_access',
				outcome: 'success',
				details: { case_type: decision.caseAccess.caseType, case_id: decision.caseAccess.caseId }
			});
		}
		await recordAuditEvent(tx, {
			...journal,
			action: 'file.downloaded',
			outcome: 'success',
			details: { context: context.kind, purpose: file.purpose }
		});
	});
	return {
		fileId: file.id,
		body: object.body,
		sizeBytes: file.sizeBytes,
		contentType: file.detectedMime,
		declaredName: file.declaredName
	};
}
