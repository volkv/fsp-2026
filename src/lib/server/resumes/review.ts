// The candidate checks what the resume gave (docs/domain.md, sections 9.2, 9.5, 17.3). An extracted claim is confirmed or
// rejected; its text and quote stay as extracted, so the history of what the document said is kept. An experience entry
// is confirmed, rejected, or corrected field by field: a correction marks it `edited` and keeps its original quotes.
// Every decision is a change of the categorization input; a rejection or a correction may take a ground away, so it
// also raises the evidence floor and blocks the published category until the recalculation.
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Database, Transaction } from '$lib/server/db';
import { claims, experienceEntries, sourceFacts } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { parsePeriod } from './periods';
import { lockCandidate, recordEvidenceChange } from './revision';
import { loadResumeTaxonomy } from './taxonomy';
import { selfCandidate } from './deps';

export interface ReviewDeps {
	db: Database;
	now: () => Date;
}

export type ReviewDecision = 'confirm' | 'reject';

const notFound = () => new ApiError('not_found');

async function change(
	tx: Transaction,
	subject: AccessSubject,
	meta: RequestMeta,
	candidateId: string,
	withdrawal: boolean,
	reason: string
): Promise<void> {
	await recordEvidenceChange(tx, {
		candidateId,
		withdrawal,
		reason,
		requestId: meta.requestId,
		actor: auditActor(subject, meta, 'candidate'),
		createdBy: { kind: 'user', id: selfCandidate(subject).userId }
	});
}

/** Skills applied in an entry follow its skill claims the candidate did not reject. */
async function refreshAppliedSkills(tx: Transaction, entryId: string): Promise<void> {
	const rows = await tx
		.select({ skillKey: claims.skillKey })
		.from(claims)
		.where(
			and(
				eq(claims.experienceEntryId, entryId),
				eq(claims.claimType, 'skill_mention'),
				eq(claims.polarity, 'asserted'),
				eq(claims.status, 'active'),
				ne(claims.candidateReview, 'rejected')
			)
		);
	const keys = [...new Set(rows.flatMap((row) => (row.skillKey === null ? [] : [row.skillKey])))].sort();
	await tx.update(experienceEntries).set({ appliedSkillKeys: keys }).where(eq(experienceEntries.id, entryId));
}

/** Confirms or rejects a claim extracted from the candidate's resume. */
export async function reviewResumeClaim(
	deps: ReviewDeps,
	subject: AccessSubject,
	claimId: string,
	decision: ReviewDecision,
	meta: RequestMeta
): Promise<void> {
	const { candidateId } = selfCandidate(subject);
	const review = decision === 'confirm' ? 'confirmed' : 'rejected';
	await deps.db.transaction(async (tx) => {
		if (!(await lockCandidate(tx, candidateId))) throw notFound();
		const [claim] = await tx
			.select({ review: claims.candidateReview, entryId: claims.experienceEntryId, type: claims.claimType })
			.from(claims)
			.innerJoin(sourceFacts, eq(sourceFacts.id, claims.factId))
			.where(
				and(
					eq(claims.id, claimId),
					eq(claims.candidateId, candidateId),
					eq(claims.status, 'active'),
					eq(sourceFacts.source, 'resume'),
					eq(sourceFacts.status, 'active')
				)
			);
		if (!claim) throw notFound();
		if (claim.review === review) return;
		await tx.update(claims).set({ candidateReview: review }).where(eq(claims.id, claimId));
		if (claim.entryId !== null && claim.type === 'skill_mention') await refreshAppliedSkills(tx, claim.entryId);
		await change(tx, subject, meta, candidateId, review === 'rejected', 'claim_rejected_by_candidate');
	});
}

async function lockEntry(tx: Transaction, candidateId: string, entryId: string) {
	const [entry] = await tx
		.select({ review: experienceEntries.candidateReview })
		.from(experienceEntries)
		.innerJoin(sourceFacts, eq(sourceFacts.id, experienceEntries.factId))
		.where(
			and(
				eq(experienceEntries.id, entryId),
				eq(experienceEntries.candidateId, candidateId),
				eq(experienceEntries.status, 'active'),
				eq(sourceFacts.status, 'active')
			)
		)
		.for('update', { of: experienceEntries });
	return entry ?? null;
}

/** Confirms or rejects an experience entry; a corrected entry stays `edited` when confirmed. */
export async function reviewExperienceEntry(
	deps: ReviewDeps,
	subject: AccessSubject,
	entryId: string,
	decision: ReviewDecision,
	meta: RequestMeta
): Promise<void> {
	const { candidateId } = selfCandidate(subject);
	await deps.db.transaction(async (tx) => {
		if (!(await lockCandidate(tx, candidateId))) throw notFound();
		const entry = await lockEntry(tx, candidateId, entryId);
		if (!entry) throw notFound();
		const review = decision === 'reject' ? 'rejected' : entry.review === 'edited' ? 'edited' : 'confirmed';
		if (entry.review === review) return;
		await tx.update(experienceEntries).set({ candidateReview: review }).where(eq(experienceEntries.id, entryId));
		await change(tx, subject, meta, candidateId, review === 'rejected', 'experience_rejected_by_candidate');
	});
}

const monthOrYear = z.string().regex(/^(19|20)\d{2}(-(0[1-9]|1[0-2]))?$/, 'must be YYYY or YYYY-MM');
const text = z.string().trim().min(1).max(200);

export const experienceCorrection = z
	.strictObject({
		positionTitle: text.nullable(),
		roleKey: z
			.string()
			.regex(/^[a-z][a-z0-9_]*$/)
			.nullable(),
		organizationName: text.nullable(),
		periodFrom: monthOrYear.nullable(),
		periodTo: monthOrYear.nullable(),
		isCurrent: z.boolean()
	})
	.refine((value) => !(value.isCurrent && value.periodTo !== null), {
		message: 'a current job has no end',
		path: ['periodTo']
	});

export type ExperienceCorrection = z.infer<typeof experienceCorrection>;

/** Replaces the fields of an experience entry with the candidate's version; the quotes of the document stay. */
export async function correctExperienceEntry(
	deps: ReviewDeps,
	subject: AccessSubject,
	entryId: string,
	input: unknown,
	meta: RequestMeta
): Promise<void> {
	const { candidateId } = selfCandidate(subject);
	const parsed = experienceCorrection.safeParse(input);
	if (!parsed.success) {
		throw new ApiError('validation_failed', {
			details: parsed.error.issues.map((issue) => ({
				path: issue.path.join('.'),
				code: issue.code,
				message: issue.message
			}))
		});
	}
	const correction = parsed.data;
	if (correction.roleKey !== null) {
		const taxonomy = await loadResumeTaxonomy(deps.db);
		if (!taxonomy?.roles.some((role) => role.key === correction.roleKey)) {
			throw new ApiError('validation_failed', {
				details: [{ path: 'roleKey', code: 'unknown_role', message: 'Такой роли нет в справочнике' }]
			});
		}
	}
	const period = parsePeriod(correction.periodFrom, correction.isCurrent ? 'present' : correction.periodTo, deps.now());
	await deps.db.transaction(async (tx) => {
		if (!(await lockCandidate(tx, candidateId))) throw notFound();
		if (!(await lockEntry(tx, candidateId, entryId))) throw notFound();
		await tx
			.update(experienceEntries)
			.set({
				positionTitle: correction.positionTitle,
				roleKey: correction.roleKey,
				organizationName: correction.organizationName,
				periodFrom: period.from?.date ?? null,
				periodTo: period.to?.date ?? null,
				periodFromPrecision: period.from?.precision ?? null,
				periodToPrecision: period.to?.precision ?? null,
				isCurrent: period.isCurrent,
				periodStatus: period.status,
				candidateReview: 'edited'
			})
			.where(eq(experienceEntries.id, entryId));
		await change(tx, subject, meta, candidateId, true, 'experience_corrected_by_candidate');
	});
}
