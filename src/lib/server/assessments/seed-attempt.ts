// A seeded attempt (docs/domain.md, 23.3): the real path of the product — the grade policy, the choice of items from the
// release, the procedure, the decision, the fact and the owner of the category — with the scores of the clusters given
// by the deterministic verdict of the seed instead of the sandbox. Its artifacts say `seeded: true` and carry no code;
// the attempt is marked `seeded` and shown as synthetic.
import { eq } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import { testItems } from '$lib/server/db/schema';
import type { ItemInstance } from './contract/bank';
import type { GradeKey, SpecializationKey } from './contract/catalog';
import { advance, appendArtifacts, itemFamily, startAttemptIn, type AdvanceOutcome, type EngineDeps } from './engine';
import { seededClusterScore } from './seeded';

export interface SeededAttemptInput {
	candidateId: string;
	specialization: SpecializationKey;
	grade: GradeKey;
	/** The candidate's true share: the chance of every cluster (and of every group and mutant). */
	trueShare: number;
	candidateSeed: string;
	/** The seed of the attempt: the choice of form and items, the same the demo seed foresaw the trajectory with. */
	attemptSeed: string;
	now: Date;
	requestId: string;
}

/**
 * The detail of a seeded cluster: a practice program is taken as written in the first language of the cluster, as the
 * owner of the category reads the language of a practice from its detail; nothing else is claimed.
 */
function seededDetail(instance: ItemInstance): { seeded: true; language?: string } {
	if (instance.format !== 'practice_code') return { seeded: true };
	const language = instance.practice?.languages[0];
	if (!language) throw new Error(`practice instance ${instance.family}/${instance.seed} has no language`);
	return { seeded: true, language };
}

/** Runs a seeded attempt to its end in the caller's transaction; returns the attempt and how it ended. */
export async function runSeededAttempt(
	tx: Transaction,
	deps: EngineDeps,
	input: SeededAttemptInput
): Promise<{ attemptId: string; outcome: Extract<AdvanceOutcome, { kind: 'decided' | 'expired' }> }> {
	const context = { now: input.now, requestId: input.requestId, createdBy: { kind: 'system' as const } };
	const started = await startAttemptIn(
		tx,
		deps,
		input.candidateId,
		{ specialization: input.specialization, grade: input.grade },
		{ now: input.now, requestId: input.requestId, userId: undefined, seeded: true, attemptSeed: input.attemptSeed }
	);
	const { attempt } = started;
	let outcome = started.outcome;
	while (outcome.kind === 'next' || outcome.kind === 'waiting_candidate') {
		const item = outcome.item;
		const instance = item.instance as ItemInstance;
		const family = await itemFamily(tx, attempt, item);
		const score = seededClusterScore({
			candidateSeed: input.candidateSeed,
			trueShare: input.trueShare,
			seq: item.seq,
			instance,
			family
		});
		await appendArtifacts(
			tx,
			attempt.id,
			item.id,
			[{ kind: 'answer', content: { seq: item.seq, seeded: true } }],
			input.now
		);
		await tx
			.update(testItems)
			.set({ status: 'scored', score, scoreDetail: seededDetail(instance), answeredAt: input.now })
			.where(eq(testItems.id, item.id));
		outcome = await advance(tx, deps, attempt, context);
	}
	if (outcome.kind === 'waiting_sandbox') throw new Error(`seeded attempt ${attempt.id} waits for the sandbox`);
	if (outcome.kind === 'block_decided') throw new Error(`seeded attempt ${attempt.id} is a block test`);
	return { attemptId: attempt.id, outcome };
}
