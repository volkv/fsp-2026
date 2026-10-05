// The fact of a block test (docs/domain.md, 13.11): a confirmed valid block result opened to every company is evidence
// of the profile — a `source_facts` row (`platform_test`, `test_block`, `event_key = test:block:{block}`) with the area
// of the block, so the skills of the block enter the inferences of the profile, and every company that sees the
// candidate sees them. A result visible to the requesting company only stays with that company (it reads the result
// itself); an annulled result annuls its fact. The category never changes.
import { and, eq, sql } from 'drizzle-orm';
import { blockDefinition } from '$lib/server/assessments/contract/catalog';
import { sha256Hex } from '$lib/server/assessments/families';
import type { Transaction } from '$lib/server/db';
import { blockConfirmations, candidates, sourceFacts } from '$lib/server/db/schema';
import { enqueueJob, type JobCreator } from '$lib/server/jobs/queue';
import { canonicalJson } from '$lib/server/json/canonical';

const recordRef = (confirmationId: string) => `test:block:${confirmationId}`;

/** Brings the fact of the result to the result: active while it is valid, confirmed and open to every company. */
export async function syncBlockFact(tx: Transaction, confirmationId: string, createdBy: JobCreator): Promise<void> {
	const [result] = await tx.select().from(blockConfirmations).where(eq(blockConfirmations.id, confirmationId));
	if (!result) throw new Error(`block result ${confirmationId} is missing`);
	const wanted = result.status === 'valid' && result.verdict === 'confirmed' && result.visibility === 'all_companies';
	const [current] = await tx
		.select({ id: sourceFacts.id })
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.candidateId, result.candidateId),
				eq(sourceFacts.sourceRecordRef, recordRef(result.id)),
				eq(sourceFacts.status, 'active')
			)
		);
	if (wanted === (current !== undefined)) return;
	if (current) {
		await tx
			.update(sourceFacts)
			.set(
				result.status === 'annulled'
					? { status: 'annulled', statusReason: 'attempt_annulled' }
					: { status: 'withdrawn', statusReason: 'visibility_requester' }
			)
			.where(eq(sourceFacts.id, current.id));
	} else {
		const decidedOn = result.decidedAt.toISOString().slice(0, 10);
		const payload = {
			confirmationId: result.id,
			attemptId: result.attemptId,
			specialization: result.specialization,
			block: result.block,
			grade: result.grade,
			skillKeys: [...blockDefinition(result.block).skillKeys],
			bankReleaseId: result.bankReleaseId,
			decidedOn
		};
		const now = new Date();
		await tx.insert(sourceFacts).values({
			candidateId: result.candidateId,
			source: 'platform_test',
			factType: 'test_block',
			sourceRecordRef: recordRef(result.id),
			eventKey: `test:block:${result.block}`,
			trustLevel: 'platform_verified',
			ownershipBasis: 'own_attempt',
			ownershipRef: result.attemptId,
			payload,
			payloadSha256: sha256Hex(canonicalJson(payload)),
			observedAt: now,
			lastVerifiedAt: now,
			occurredOn: decidedOn,
			status: 'active'
		});
	}
	// A change of the evidence is a change of the profile: the inferences and the matches are computed again.
	const [row] = await tx
		.update(candidates)
		.set({ profileRevision: sql`${candidates.profileRevision} + 1` })
		.where(eq(candidates.id, result.candidateId))
		.returning({ revision: candidates.profileRevision });
	if (!row) throw new Error(`candidate ${result.candidateId} is missing`);
	const inputVersion = String(row.revision);
	await enqueueJob(tx, 'evidence.compute', { candidate_id: result.candidateId }, { inputVersion, createdBy });
	await enqueueJob(
		tx,
		'match.refresh',
		{ scope: 'candidate', candidate_id: result.candidateId },
		{ inputVersion, createdBy }
	);
}
