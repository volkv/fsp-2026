// A visitor's own resume in a demo session (docs/domain.md, section 19.3): uploaded only into an adult candidate clone,
// only after the separate consent `demo_resume_upload`; the profile leaves the employers' catalog, and the demo session
// then lives no longer than the resume may — its removal takes the file, the text and every result derived from it.
import { and, desc, eq } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { stillCurrent } from '$lib/server/auth/documents';
import { revokeCatalogVisibility } from '$lib/server/candidates/consents';
import { candidates, consentEvents } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { selfCandidate, type ResumeDeps } from '$lib/server/resumes/deps';
import { uploadResume, type UploadedResume } from '$lib/server/resumes/upload';
import { ageBand } from '$lib/server/visibility/age';
import { shortenForOwnResume, type DemoTerms } from './visit';

export interface OwnResumeInput {
	/** The demo session the visitor's browser belongs to. */
	sessionId: string;
	/** The version of the consent text the form showed. */
	documentId: string;
	bytes: Uint8Array<ArrayBuffer>;
	declaredName: string;
}

export interface OwnResumeResult {
	resume: UploadedResume;
	expiresAt: Date;
}

/**
 * Records the consent, takes the profile out of the catalog, brings the end of the demo session forward and uploads
 * the file through the product's own upload.
 */
export async function uploadOwnResume(
	deps: ResumeDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	input: OwnResumeInput,
	terms: DemoTerms
): Promise<OwnResumeResult> {
	const { candidateId, userId } = selfCandidate(subject);
	const now = deps.now();
	const [profile] = await deps.db
		.select({
			session: candidates.demoSessionId,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!profile || profile.session !== input.sessionId) {
		throw new ApiError('forbidden', { message: 'Своё резюме загружается только в профиль героя своей демо-сессии' });
	}
	if (
		ageBand({ birthDate: profile.birthDate, precision: profile.precision, status: profile.status }, now) !== 'adult'
	) {
		throw new ApiError('policy_violation', {
			message: 'Своё резюме загружается в профиль взрослого героя: выберите другого кандидата сценария'
		});
	}
	const document = await stillCurrent(deps.db, 'demo_resume_upload', input.documentId, now);
	if (!document) {
		throw new ApiError('conflict', { message: 'Текст согласия обновился: прочитайте новую редакцию и повторите' });
	}

	await deps.db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind: 'demo_resume_upload',
		documentId: document.id,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: userId,
		method: 'separate_screen_button',
		evidence: {
			ip: meta.ip ?? null,
			user_agent: meta.userAgent ?? null,
			session_hash: meta.sessionHash ?? null,
			document_sha256: document.bodySha256
		},
		occurredAt: now
	});
	const [catalog] = await deps.db
		.select({ action: consentEvents.action })
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, candidateId),
				eq(consentEvents.kind, 'catalog_visibility'),
				eq(consentEvents.signerKind, 'subject')
			)
		)
		.orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
		.limit(1);
	if (catalog?.action === 'grant') {
		await revokeCatalogVisibility(deps.db, subject, meta, 'Загружено своё резюме в демо-сессии');
	}
	const expiresAt = await shortenForOwnResume(deps.db, input.sessionId, terms, now);
	const resume = await uploadResume(deps, subject, { bytes: input.bytes, declaredName: input.declaredName }, meta);
	return { resume, expiresAt };
}
