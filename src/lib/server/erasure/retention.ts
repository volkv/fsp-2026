// Retention periods of `retention_policy` that `retention.sweep` applies besides the journal (docs/domain.md, sections
// 6.5, 7.1, 13.8, 19.2):
// - `disclosure_retention_months`: a disclosure is kept as proof of a lawful transfer for this long, then removed; the
//   consent events of a deleted profile that no disclosure refers to any longer go with it;
// - `inactive_candidate_purge_days`: a profile whose account has not signed in for this long is told that it will be
//   removed (`purge_after`, `inactivity_notice_days` ahead) and then deleted like an account deleted by its person,
//   unless the person signed in meanwhile. Both terms are stated from version 3 of the policy.
import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';
import type { PolicyParams } from '$lib/server/consent/kinds';
import type { Transaction } from '$lib/server/db';
import { candidates, consentEvents, disclosures, users } from '$lib/server/db/schema';
import { notify } from '$lib/server/notifications/notify';
import { beginAccountDeletion } from './request';

/** Profiles handled by one sweep at most in each step; the rest wait for the next day. */
export const SWEEP_LIMIT = 500;

type RetentionPolicy = PolicyParams<'retention_policy'>;

/** A `retention_policy` that states the notice before the removal for inactivity (version 3 and later). */
export type InactivityTerms = Extract<RetentionPolicy, { inactivity_notice_days: number }>;

/** The terms of the removal for inactivity, if the policy states them; `null` — an earlier version without the notice. */
export function inactivityTerms(policy: RetentionPolicy): InactivityTerms | null {
	return 'inactivity_notice_days' in policy ? policy : null;
}

const utcDate = (at: Date) => at.toISOString().slice(0, 10);

const daysAfter = (date: string, days: number) => {
	const day = new Date(`${date}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() + days);
	return utcDate(day);
};

export interface DisclosureSweep {
	disclosuresRemoved: number;
	consentEventsRemoved: number;
}

/** Disclosures past `disclosure_retention_months`, and the consent events of deleted profiles nothing proves any more. */
export async function sweepDisclosures(tx: Transaction, policy: RetentionPolicy, at: Date): Promise<DisclosureSweep> {
	const expired = await tx
		.select({ id: disclosures.id })
		.from(disclosures)
		.where(
			sql`${disclosures.disclosedAt} < ${at.toISOString()}::timestamptz - make_interval(months => ${policy.disclosure_retention_months})`
		);
	const orphaned = await tx
		.select({ id: consentEvents.id })
		.from(consentEvents)
		.innerJoin(candidates, eq(candidates.id, consentEvents.subjectCandidateId))
		.where(
			and(
				eq(candidates.status, 'deleted'),
				notInArray(
					consentEvents.id,
					tx
						.select({ id: disclosures.consentEventId })
						.from(disclosures)
						.where(
							notInArray(
								disclosures.id,
								expired.map((row) => row.id)
							)
						)
				)
			)
		);
	if (expired.length === 0 && orphaned.length === 0) return { disclosuresRemoved: 0, consentEventsRemoved: 0 };
	// Both tables are append-only: only the retention role deletes, and only by identifiers (migration 0002).
	await tx.execute(sql`set local role fsp_retention`);
	const removedDisclosures =
		expired.length === 0
			? []
			: await tx
					.delete(disclosures)
					.where(
						inArray(
							disclosures.id,
							expired.map((row) => row.id)
						)
					)
					.returning({ id: disclosures.id });
	const removedEvents =
		orphaned.length === 0
			? []
			: await tx
					.delete(consentEvents)
					.where(
						inArray(
							consentEvents.id,
							orphaned.map((row) => row.id)
						)
					)
					.returning({ id: consentEvents.id });
	await tx.execute(sql`reset role`);
	return { disclosuresRemoved: removedDisclosures.length, consentEventsRemoved: removedEvents.length };
}

export interface InactivitySweep {
	/** Profiles told of their coming removal. */
	noticed: number;
	/** Profiles whose person signed in after the notice: the removal is called off. */
	kept: number;
	/** Profiles whose deletion began. */
	deleted: number;
}

/** When the account last showed up: its last sign-in, or its creation if it never signed in. */
const lastSeen = sql`coalesce(${users.lastLoginAt}, ${users.createdAt})`;

const LIVE_PROFILE = ['onboarding', 'active', 'ineligible_age'] as const;

/**
 * The account can be deleted for inactivity: `beginAccountDeletion` would not refuse it for a staff role (domain 4.1)
 * or for the last active owner of a company (domain 5.3). Such a profile is neither told of a removal that will not
 * happen nor taken into a sweep again every day.
 */
const deletable = sql`not exists (select 1 from staff_roles held_role
		where held_role.user_id = ${users.id} and held_role.revoked_at is null)
	and not exists (select 1 from company_members owned
		where owned.user_id = ${users.id} and owned.status = 'active' and owned.role = 'owner'
			and not exists (select 1 from company_members co_owner
				where co_owner.company_id = owned.company_id and co_owner.status = 'active' and co_owner.role = 'owner'
					and co_owner.id <> owned.id))`;

export async function sweepInactiveCandidates(
	tx: Transaction,
	policy: InactivityTerms,
	at: Date,
	requestId: string
): Promise<InactivitySweep> {
	const today = utcDate(at);
	const inactiveSince = sql`${at.toISOString()}::timestamptz - make_interval(days => ${policy.inactive_candidate_purge_days})`;

	// A sign-in after the notice keeps the profile.
	const noticedAt = sql`(${candidates.purgeAfter} - ${policy.inactivity_notice_days}::int)::timestamptz`;
	const returned = await tx
		.update(candidates)
		.set({ purgeAfter: null })
		.from(users)
		.where(
			and(
				eq(users.id, candidates.userId),
				inArray(candidates.status, [...LIVE_PROFILE]),
				isNotNull(candidates.purgeAfter),
				sql`${lastSeen} >= ${noticedAt}`
			)
		)
		.returning({ id: candidates.id });

	const due = await tx
		.select({ userId: candidates.userId })
		.from(candidates)
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(
			and(
				inArray(candidates.status, [...LIVE_PROFILE]),
				inArray(users.status, ['active', 'pending_email', 'suspended']),
				lte(candidates.purgeAfter, today),
				deletable
			)
		)
		.orderBy(asc(candidates.purgeAfter), asc(candidates.id))
		.limit(SWEEP_LIMIT);
	let deleted = 0;
	for (const { userId } of due) {
		const refusal = await beginAccountDeletion(tx, {
			userId,
			cause: 'inactive',
			actor: { kind: 'system' },
			requestId,
			at
		});
		if (refusal === null) deleted += 1;
	}

	const inactive = await tx
		.select({ id: candidates.id, userId: candidates.userId })
		.from(candidates)
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(
			and(
				inArray(candidates.status, [...LIVE_PROFILE]),
				inArray(users.status, ['active', 'pending_email', 'suspended']),
				isNull(candidates.purgeAfter),
				sql`${lastSeen} < ${inactiveSince}`,
				deletable
			)
		)
		.orderBy(asc(lastSeen), asc(candidates.id))
		.limit(SWEEP_LIMIT);
	const purgeOn = daysAfter(today, policy.inactivity_notice_days);
	for (const profile of inactive) {
		await tx.update(candidates).set({ purgeAfter: purgeOn }).where(eq(candidates.id, profile.id));
		await notify(tx, {
			userId: profile.userId,
			type: 'candidate.inactive_purge_scheduled',
			objectId: profile.id,
			stage: purgeOn,
			payload: { candidate_id: profile.id, purge_on: purgeOn }
		});
	}
	return { noticed: inactive.length, kept: returned.length, deleted };
}
