// The public check of a confirmation of a category (docs/domain.md, section 12.9; contracts 9.3): its status is
// computed at the moment of the request from the assignment it speaks of, read through the category module like every
// other reader of categories — `valid` while the assignment is in force, `superseded` once another assignment of the
// specialization replaced it (a past result, not the category in force, which is named) or a new confirmation of the
// same assignment replaced it after the holder changed their name, `annulled` once the decision was annulled or the
// category revoked after an objection. Nothing about the person is returned; a confirmation of a
// removed account is gone with it.
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { GradeKey } from '$lib/server/assessments/contract/catalog';
import { activeCategories, categoryHistory, type CategoryRecord } from '$lib/server/categories/read';
import { fromBase32 } from '$lib/server/crypto/encoding';
import type { Executor } from '$lib/server/db';
import { categoryAttestations } from '$lib/server/db/schema';
import { normalizeNameText } from '$lib/server/profile/contacts';
import { attestationStatementSchema, holderCommitment } from './statement';

/** 128 random bits in base32 without padding. */
export const ATTESTATION_HANDLE = /^[a-z2-7]{26}$/u;

export type AttestationStatus = 'valid' | 'superseded' | 'annulled';

export interface VerifiedAttestation {
	status: AttestationStatus;
	statement: unknown;
	signature: string;
	signingKeyId: string;
	/** When the assignment stopped being in force: superseded or annulled. */
	endedAt: Date | null;
	/** Why an annulled assignment stopped: the decision annulled, or an objection upheld against it. */
	annulReason: CategoryRecord['revokeReason'];
	/** The grade in force now in the same specialization, when the assignment was superseded; `null` — none. */
	currentGrade: { grade: GradeKey; assignedOn: string } | null;
	/**
	 * `superseded` with the assignment still in force: a new confirmation of it replaced this one after the holder
	 * changed their name (domain 12.9).
	 */
	reissued: boolean;
}

function statusOf(record: CategoryRecord): AttestationStatus {
	switch (record.status) {
		case 'active':
			return 'valid';
		case 'superseded':
			return 'superseded';
		case 'revoked':
			return 'annulled';
	}
}

/** A confirmation by its handle with its status now; `null` — no such confirmation. */
export async function verifyAttestation(executor: Executor, handle: string): Promise<VerifiedAttestation | null> {
	const [row] = await executor
		.select({
			candidateId: categoryAttestations.candidateId,
			categoryId: categoryAttestations.categoryId,
			statement: categoryAttestations.statement,
			signature: categoryAttestations.signature,
			signingKeyId: categoryAttestations.signingKeyId,
			supersededAt: categoryAttestations.supersededAt
		})
		.from(categoryAttestations)
		.where(eq(categoryAttestations.handle, handle));
	if (!row) return null;
	const history = await categoryHistory(executor, row.candidateId);
	const record = history.find((category) => category.id === row.categoryId);
	if (!record) throw new Error(`confirmation ${handle} speaks of category ${row.categoryId}, which is missing`);
	// The assignment in force, its confirmation replaced by a new one for the changed name of the holder: `superseded`
	// from that moment, the same grade named as the one in force.
	const reissued = record.status === 'active' && row.supersededAt !== null;
	const status = reissued ? 'superseded' : statusOf(record);
	let currentGrade: VerifiedAttestation['currentGrade'] = null;
	if (status === 'superseded') {
		const inForce = (await activeCategories(executor, [row.candidateId])).get(row.candidateId) ?? [];
		const current = inForce.find((category) => category.specialization === record.specialization);
		currentGrade = current ? { grade: current.grade, assignedOn: current.assignedAt.toISOString().slice(0, 10) } : null;
	}
	return {
		status,
		statement: row.statement,
		signature: row.signature,
		signingKeyId: row.signingKeyId,
		endedAt: reissued ? row.supersededAt : record.endedAt,
		annulReason: record.revokeReason,
		currentGrade,
		reissued
	};
}

/**
 * Whether the name and the holder code given by the person presenting the confirmation make its commitment; `null` —
 * no such confirmation. Neither the name nor the code is stored or journaled.
 */
export async function checkHolder(
	executor: Executor,
	handle: string,
	input: { fullName: string; holderCode: string }
): Promise<boolean | null> {
	const [row] = await executor
		.select({ statement: categoryAttestations.statement })
		.from(categoryAttestations)
		.where(eq(categoryAttestations.handle, handle));
	if (!row) return null;
	const nonce = fromBase32(input.holderCode.trim());
	if (nonce === null || nonce.length !== 32) return false;
	const expected = Buffer.from(attestationStatementSchema.parse(row.statement).holder_commitment, 'hex');
	const given = Buffer.from(holderCommitment(normalizeNameText(input.fullName), nonce), 'hex');
	return expected.length === given.length && timingSafeEqual(expected, given);
}
