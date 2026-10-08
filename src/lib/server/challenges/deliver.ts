// Regular delivery of the calls of companies (docs/domain.md, 13.12, 17.2): an hourly job runs every active call on its
// own clock (the shifted clock of a demo session for the calls of its companies) and, once in `period_hours` of the
// challenge policy, offers the call to new candidates — of an active category of its specialization and grades, seen
// by the company in the catalog (`canShow`, the block list), without a delivery of this call and without a delivery of
// any call within `candidate_interval_days`; at most `per_run_per_challenge` per run, those longest without a call
// first. The pair «call × candidate» is unique, so a repeated run or a repeated job delivers nothing twice. A delivery
// not opened within three days is reminded once, never again; after the end of the call the unopened ones expire.
// The interval and the order count the deliveries of the calls of the same place only — of companies of the same demo
// session, or of companies outside sessions: a candidate outside sessions is shared by every session, and a call of one
// session must not hold them back from another session or from the companies of the platform. A delivery keeps two
// moments: `delivered_at`, the real one the candidate sees, and `clock_at`, the moment on the clock of the call, which
// the interval and the reminder count — «промотать неделю» moves the clock of its session, never the real time.
import { and, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { companyAdmission } from '$lib/server/access/permissions';
import { GRADE_KEYS, type GradeKey } from '$lib/server/assessments/contract/catalog';
import { recordAuditEvent } from '$lib/server/audit/record';
import { categoryPredicate } from '$lib/server/categories/read';
import { minorTermsAcceptance } from '$lib/server/companies/profile';
import type { Database, Executor, Transaction } from '$lib/server/db';
import { candidateAt, listedInCatalog } from '$lib/server/db/conditions';
import {
	candidates,
	challengeDeliveries,
	companies,
	companyChallenges,
	companyMembers,
	demoSessions,
	users
} from '$lib/server/db/schema';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { auditActor } from '$lib/server/invitations/deps';
import { refuse } from '$lib/server/invitations/errors';
import { requiredPolicy, type PolicyVersion } from '$lib/server/invitations/policies';
import { defineHandler, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { notify } from '$lib/server/notifications/notify';
import { canShow, type Viewer } from '$lib/server/visibility/can-show';
import { companyClockOffsets } from './clock';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A delivery not opened within this time is reminded once (domain 13.12). */
export const REMIND_AFTER_MS = 3 * DAY;
/** «Промотать неделю» of a demo session. */
export const DEMO_CLOCK_STEP_SECONDS = 7 * 86_400;

type ChallengeRow = typeof companyChallenges.$inferSelect;

export interface ChallengeRun {
	challengeId: string;
	/** The moment of the run on the clock of the call. */
	at: Date;
	delivered: number;
	reminded: number;
	expired: number;
	closed: boolean;
}

/**
 * The company as `canShow` sees it for its call: the member who wrote the call, acting in the session of the company.
 * `null` — the company may not act now (the admission policy closed it) or the author left: the call is not delivered.
 */
async function companyViewer(
	executor: Executor,
	challenge: ChallengeRow,
	now: Date
): Promise<{ viewer: Extract<Viewer, { kind: 'member' }>; minorTermsAccepted: boolean } | null> {
	const [row] = await executor
		.select({
			userId: companyMembers.userId,
			memberStatus: companyMembers.status,
			companyStatus: companies.status,
			demoSessionId: companies.demoSessionId
		})
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(eq(companyMembers.id, challenge.createdByMemberId));
	if (!row || row.userId === null || row.memberStatus !== 'active' || !companyAdmission(row.companyStatus).admitted) {
		return null;
	}
	return {
		viewer: {
			kind: 'member',
			userId: row.userId,
			memberId: challenge.createdByMemberId,
			companyId: challenge.companyId,
			via: 'session',
			demoSessionId: row.demoSessionId
		},
		minorTermsAccepted: (await minorTermsAcceptance(executor, challenge.companyId, now)) !== null
	};
}

/**
 * The deliveries to the candidate `c` of the calls of companies in the place `demoSessionId` (`null` — outside
 * sessions): what the interval and the order of a call of that place count.
 */
function deliveriesInPlace(demoSessionId: string | null): SQL {
	return sql`${challengeDeliveries} d
		join ${companyChallenges} dc on dc.id = d.challenge_id
		join ${companies} dco on dco.id = dc.company_id
		where d.candidate_id = c.id and dco.demo_session_id is not distinct from ${demoSessionId}::uuid`;
}

/** Candidates the run may offer the call to, the longest without a call of its place first, then by id. */
async function eligibleCandidates(
	executor: Executor,
	challenge: ChallengeRow,
	demoSessionId: string | null,
	at: Date,
	intervalDays: number
): Promise<string[]> {
	const c = candidateAt('c');
	const since = new Date(at.getTime() - intervalDays * DAY);
	const rows = await executor.execute<{ id: string }>(sql`
		select c.id from ${candidates} c
		where ${listedInCatalog(c)}
			and ${categoryPredicate(sql`c.id`, { specializations: [challenge.specialization], grades: challenge.grades.filter(isGrade) })}
			and not exists (select 1 from ${challengeDeliveries} d where d.challenge_id = ${challenge.id} and d.candidate_id = c.id)
			and not exists (select 1 from ${deliveriesInPlace(demoSessionId)} and d.clock_at > ${since.toISOString()}::timestamptz)
		order by (select max(d.clock_at) from ${deliveriesInPlace(demoSessionId)}) asc nulls first, c.id
	`);
	return rows.map((row) => row.id);
}

const isGrade = (value: string): value is GradeKey => (GRADE_KEYS as readonly string[]).includes(value);

async function userOf(executor: Executor, candidateId: string): Promise<string> {
	const [row] = await executor
		.select({ userId: candidates.userId })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} does not exist`);
	return row.userId;
}

/**
 * One run of one call at `at`, the moment on its clock; `realNow` — the clock of the application, for `canShow` and
 * for the moments recorded; `demoSessionId` — the place of the company of the call.
 */
async function runChallenge(
	tx: Transaction,
	challenge: ChallengeRow,
	demoSessionId: string | null,
	policy: PolicyVersion<'challenge_policy'>,
	at: Date,
	realNow: Date
): Promise<ChallengeRun> {
	const run: ChallengeRun = { challengeId: challenge.id, at, delivered: 0, reminded: 0, expired: 0, closed: false };
	if (challenge.startsAt !== null && at < challenge.startsAt) return run;
	if (at >= challenge.endsAt) {
		const expired = await tx
			.update(challengeDeliveries)
			.set({ status: 'expired' })
			.where(and(eq(challengeDeliveries.challengeId, challenge.id), eq(challengeDeliveries.status, 'delivered')))
			.returning({ id: challengeDeliveries.id });
		await tx.update(companyChallenges).set({ status: 'closed' }).where(eq(companyChallenges.id, challenge.id));
		return { ...run, expired: expired.length, closed: true };
	}

	const due = await tx
		.update(challengeDeliveries)
		.set({ remindedAt: realNow })
		.where(
			and(
				eq(challengeDeliveries.challengeId, challenge.id),
				eq(challengeDeliveries.status, 'delivered'),
				isNull(challengeDeliveries.openedAt),
				isNull(challengeDeliveries.remindedAt),
				lte(challengeDeliveries.clockAt, new Date(at.getTime() - REMIND_AFTER_MS))
			)
		)
		.returning({ id: challengeDeliveries.id, candidateId: challengeDeliveries.candidateId });
	for (const delivery of due) {
		await notify(tx, {
			userId: await userOf(tx, delivery.candidateId),
			type: 'challenge.reminder',
			objectId: delivery.id,
			payload: { delivery_id: delivery.id }
		});
	}
	run.reminded = due.length;

	const period = policy.params.period_hours * HOUR;
	if (challenge.lastDeliveryRunAt !== null && at.getTime() - challenge.lastDeliveryRunAt.getTime() < period) return run;
	const company = await companyViewer(tx, challenge, realNow);
	await tx.update(companyChallenges).set({ lastDeliveryRunAt: at }).where(eq(companyChallenges.id, challenge.id));
	if (!company) return run;
	const eligible = await eligibleCandidates(tx, challenge, demoSessionId, at, policy.params.candidate_interval_days);
	const facts = await loadVisibilityFacts(tx, eligible, {
		now: realNow,
		policy: await loadVisibilityPolicy(tx, realNow),
		viewerCompanyId: challenge.companyId,
		viewerCompany: {
			membershipActive: true,
			companyAdmitted: true,
			hasCardReadPermission: true,
			minorTermsAccepted: company.minorTermsAccepted
		}
	});
	const chosen = eligible
		.filter((id) => {
			const candidate = facts.get(id);
			return candidate !== undefined && canShow(candidate, company.viewer, { kind: 'catalog' }).allowed;
		})
		.slice(0, policy.params.per_run_per_challenge);
	for (const candidateId of chosen) {
		const [delivery] = await tx
			.insert(challengeDeliveries)
			.values({ challengeId: challenge.id, candidateId, deliveredAt: realNow, clockAt: at, status: 'delivered' })
			.onConflictDoNothing({ target: [challengeDeliveries.challengeId, challengeDeliveries.candidateId] })
			.returning({ id: challengeDeliveries.id });
		if (!delivery) continue;
		run.delivered += 1;
		await notify(tx, {
			userId: await userOf(tx, candidateId),
			type: 'challenge.delivered',
			objectId: delivery.id,
			payload: { delivery_id: delivery.id }
		});
	}
	return run;
}

/**
 * Runs the active calls — all of them, or those of the companies of one demo session — each at `now` shifted by the
 * clock of its company. Returns what each run did.
 */
export async function deliverChallenges(
	tx: Transaction,
	now: Date,
	scope: { demoSessionId: string } | 'all',
	requestId: string
): Promise<ChallengeRun[]> {
	const challenges = await tx
		.select({ challenge: companyChallenges, demoSessionId: companies.demoSessionId })
		.from(companyChallenges)
		.innerJoin(companies, eq(companies.id, companyChallenges.companyId))
		.where(
			and(
				eq(companyChallenges.status, 'active'),
				scope === 'all' ? undefined : eq(companies.demoSessionId, scope.demoSessionId)
			)
		)
		.orderBy(companyChallenges.createdAt)
		.for('update', { of: companyChallenges, skipLocked: true });
	if (challenges.length === 0) return [];
	const policy = await requiredPolicy(tx, 'challenge_policy', now);
	const offsets = await companyClockOffsets(
		tx,
		challenges.map((row) => row.challenge.companyId)
	);
	const runs: ChallengeRun[] = [];
	for (const { challenge, demoSessionId } of challenges) {
		const at = new Date(now.getTime() + (offsets.get(challenge.companyId) ?? 0));
		const run = await runChallenge(tx, challenge, demoSessionId, policy, at, now);
		runs.push(run);
		if (run.delivered > 0 || run.reminded > 0 || run.expired > 0) {
			await recordAuditEvent(tx, {
				action: 'challenge.delivered',
				outcome: 'success',
				actor: { kind: 'system' },
				object: { type: 'company_challenge', id: challenge.id },
				requestId,
				details: { delivered: run.delivered, reminded: run.reminded, expired: run.expired },
				occurredAt: now
			});
		}
		if (run.closed) {
			await recordAuditEvent(tx, {
				action: 'challenge.closed',
				outcome: 'success',
				actor: { kind: 'system' },
				object: { type: 'company_challenge', id: challenge.id },
				requestId,
				details: { reason: 'ended' },
				occurredAt: now
			});
		}
	}
	return runs;
}

/** `challenge.deliver`: the hourly run over every active call. */
export function createChallengeDeliverHandler(clock: { now: () => Date }): JobHandler<'challenge.deliver'> {
	return defineHandler({
		type: 'challenge.deliver',
		concurrency: 1,
		run({ requestId }): Promise<JobResult> {
			let runs: ChallengeRun[] = [];
			return Promise.resolve({
				// The run reads the calls under their row locks in the write transaction: nothing goes stale.
				isCurrent: () => Promise.resolve(true),
				write: async (tx) => {
					runs = await deliverChallenges(tx, clock.now(), 'all', requestId);
				},
				describe: () => ({
					challenges: runs.length,
					delivered: runs.reduce((sum, run) => sum + run.delivered, 0),
					reminded: runs.reduce((sum, run) => sum + run.reminded, 0)
				})
			});
		}
	});
}

export const challengeDeliver = createChallengeDeliverHandler({ now: () => new Date() });

/**
 * «Промотать неделю» (domain 13.12, 19.3): the clock of the visitor's demo session moves a week on, and the calls of the
 * session's companies run at once on the new clock — the next cycle of delivery without waiting. Other sessions and the
 * rows outside sessions are not touched. Only an account of a demo session may.
 */
export async function advanceDemoClock(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	now: Date
): Promise<{ clockOffsetSeconds: number; runs: ChallengeRun[] }> {
	if (subject.userId === null) throw refuse('unauthenticated', 'unauthenticated');
	const userId = subject.userId;
	return db.transaction(async (tx) => {
		const [user] = await tx.select({ session: users.demoSessionId }).from(users).where(eq(users.id, userId));
		if (!user?.session) throw refuse('forbidden', 'not_in_demo_session');
		const [session] = await tx
			.update(demoSessions)
			.set({ clockOffsetSeconds: sql`${demoSessions.clockOffsetSeconds} + ${DEMO_CLOCK_STEP_SECONDS}` })
			.where(eq(demoSessions.id, user.session))
			.returning({ offset: demoSessions.clockOffsetSeconds });
		if (!session) throw refuse('not_found', 'demo_session_gone');
		await recordAuditEvent(tx, {
			action: 'demo.clock_advanced',
			outcome: 'success',
			actor: auditActor(subject, meta, subject.membership ? 'company' : 'candidate'),
			requestId: meta.requestId,
			details: { clock_offset_seconds: session.offset },
			occurredAt: now
		});
		const runs = await deliverChallenges(tx, now, { demoSessionId: user.session }, meta.requestId);
		return { clockOffsetSeconds: session.offset, runs };
	});
}

/** The shift of the clock of the session of the account, in seconds; `null` — the account is outside demo sessions. */
export async function demoClockOf(executor: Executor, userId: string): Promise<number | null> {
	const [row] = await executor
		.select({ offset: demoSessions.clockOffsetSeconds })
		.from(users)
		.innerJoin(demoSessions, eq(demoSessions.id, users.demoSessionId))
		.where(eq(users.id, userId));
	return row?.offset ?? null;
}
