// The queue of skill mentions the taxonomy does not know (docs/domain.md, section 11: `unknown_skill_mentions`). It is
// filled from the texts of vacancies only — the tags of external postings the normalization could not resolve — and
// never from resumes: a mention of a candidate is personal data, a tag of a posting is not. One row per spelling in
// the canonical form of skill normalization; `count` is the number of postings the spelling was found in. A posting
// counts once per spelling: normalizing it again adds only the spellings its previous normalization did not have, so a
// new taxonomy version or a retried job never inflates the counter. Each spelling keeps the latest fetched posting
// that brought it and when, so the queue shows where it was last seen without reading the postings. The administrator
// marks a spelling as added to the dictionary or rejected; which taxonomy versions know it is read from their aliases,
// not stored here.
import { eq, inArray, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '$lib/server/db';
import { unknownSkillMentions } from '$lib/server/db/schema';
import { normalizeSkillText } from './normalize';

export type UnknownSkillReviewStatus = (typeof unknownSkillMentions.$inferSelect)['reviewStatus'];

export const UNKNOWN_SKILL_REVIEW_STATUSES = [
	'pending',
	'added',
	'rejected'
] as const satisfies readonly UnknownSkillReviewStatus[];

/**
 * Longer mentions are phrases of a requirement, not names of a skill: they stay in the posting and do not enter the
 * queue (the key is also a primary key, and a text of any length does not belong in its index).
 */
const UNKNOWN_SKILL_MAX_LENGTH = 80;

/** The spellings of the queue a list of mentions stands for: canonical, distinct, of a skill name's length. */
function unknownSkillKeys(mentions: readonly string[]): Set<string> {
	const keys = new Set<string>();
	for (const mention of mentions) {
		const key = normalizeSkillText(mention);
		if (key !== '' && Array.from(key).length <= UNKNOWN_SKILL_MAX_LENGTH) keys.add(key);
	}
	return keys;
}

/**
 * Records the unknown mentions of one posting after its normalization, in the transaction that stores it: `before` —
 * what its previous normalization left unknown (empty for a posting normalized for the first time), `after` — what
 * this one did. Only the spellings new to the posting are counted; every spelling it carries remembers the posting
 * as where it was last seen, unless a posting fetched later already holds that place.
 */
export async function recordUnknownSkillMentions(
	tx: Transaction,
	posting: { id: string; fetchedAt: Date },
	before: readonly string[],
	after: readonly string[],
	now: Date
): Promise<void> {
	const carried = [...unknownSkillKeys(after)].sort();
	if (carried.length === 0) return;
	const known = unknownSkillKeys(before);
	const fresh = carried.filter((key) => !known.has(key));
	const incoming = sql`excluded.last_seen_at >= coalesce(${unknownSkillMentions.lastSeenAt}, '-infinity')`;
	await tx
		.insert(unknownSkillMentions)
		.values(
			carried.map((rawNormalized) => ({
				rawNormalized,
				count: 1,
				firstSeenAt: now,
				lastSeenAt: posting.fetchedAt,
				lastPostingId: posting.id,
				createdAt: now,
				updatedAt: now
			}))
		)
		.onConflictDoUpdate({
			target: unknownSkillMentions.rawNormalized,
			set: {
				count: sql`${unknownSkillMentions.count} + case when ${inArray(sql`excluded.raw_normalized`, fresh)} then 1 else 0 end`,
				lastSeenAt: sql`case when ${incoming} then excluded.last_seen_at else ${unknownSkillMentions.lastSeenAt} end`,
				lastPostingId: sql`case when ${incoming} then excluded.last_posting_id else ${unknownSkillMentions.lastPostingId} end`,
				updatedAt: now
			}
		});
}

/** Sets the review mark of a spelling of the queue; `false` — the queue has no such spelling. */
export async function markUnknownSkill(
	executor: Executor,
	key: string,
	status: UnknownSkillReviewStatus
): Promise<boolean> {
	const rows = await executor
		.update(unknownSkillMentions)
		.set({ reviewStatus: status })
		.where(eq(unknownSkillMentions.rawNormalized, key))
		.returning({ key: unknownSkillMentions.rawNormalized });
	return rows.length > 0;
}
