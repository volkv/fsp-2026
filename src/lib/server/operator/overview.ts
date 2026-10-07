// The first screen of the operator cabinet: how many cases wait in each queue and how many are past or near their due
// time, so the operator starts with what is late. Counts only; the queues themselves are read by their pages. The
// operator counts the cases within its reach: a clone operator of a demo session — those of its session only
// (domain 19.3).
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { attemptsForReviewCount } from '$lib/server/assessments/review';
import { requirePermission } from '$lib/server/companies/context';
import { REVIEW_DUE_HOURS } from '$lib/server/companies/verification';
import type { Executor } from '$lib/server/db';
import { assessmentObjections, companies, companyVerifications, representations } from '$lib/server/db/schema';
import { ageConflictCount } from './ages';
import { pendingVacancyModeration } from './vacancies';

const OBJECTION_WARN_DAYS = 5;

export interface OperatorOverview {
	companies: { open: number; overdue: number };
	objections: { open: number; unassigned: number; overdue: number; dueSoon: number };
	representatives: { awaiting: number };
	vacancies: { pending: number };
	/** Profiles closed by a conflict of the birth date. */
	ages: { open: number };
	/**
	 * Attempts of tests that ask for a person, the whole queue: signals in the journal or a submission stuck without a
	 * result; `stuck` — the latter.
	 */
	attempts: { attention: number; stuck: number };
}

export async function operatorOverview(
	executor: Executor,
	subject: AccessSubject,
	now: Date
): Promise<OperatorOverview> {
	requirePermission(subject, 'company.review', { companyStatus: 'submitted' });
	requirePermission(subject, 'objection.manage', null);
	requirePermission(subject, 'representation.review', null);
	requirePermission(subject, 'vacancy.moderate', null);
	requirePermission(subject, 'age.review', null);
	requirePermission(subject, 'assessment.review', null);
	const reach = await StaffReach.of(executor, subject);
	const dueCutoff = new Date(now.getTime() - REVIEW_DUE_HOURS * 3600_000);
	const [verification] = await executor
		.select({
			open: count(),
			overdue: sql<number>`count(*) filter (where ${companyVerifications.createdAt} <= ${dueCutoff.toISOString()}::timestamptz)::int`
		})
		.from(companyVerifications)
		.innerJoin(companies, eq(companies.id, companyVerifications.companyId))
		.where(
			and(isNull(companyVerifications.decision), eq(companies.status, 'submitted'), reach.rows(companies.demoSessionId))
		);
	const warnAt = new Date(now.getTime() + OBJECTION_WARN_DAYS * 86_400_000);
	const [objections] = await executor
		.select({
			open: count(),
			unassigned: sql<number>`count(*) filter (where ${assessmentObjections.assigneeId} is null)::int`,
			overdue: sql<number>`count(*) filter (where ${assessmentObjections.dueAt} <= ${now.toISOString()}::timestamptz)::int`,
			dueSoon: sql<number>`count(*) filter (where ${assessmentObjections.dueAt} > ${now.toISOString()}::timestamptz and ${assessmentObjections.dueAt} <= ${warnAt.toISOString()}::timestamptz)::int`
		})
		.from(assessmentObjections)
		.where(
			and(
				inArray(assessmentObjections.status, ['open', 'in_review']),
				reach.candidate(assessmentObjections.candidateId)
			)
		);
	const [awaiting] = await executor
		.select({ n: count() })
		.from(representations)
		.where(
			and(
				inArray(representations.status, ['contact_confirmed', 'authority_pending']),
				reach.candidate(representations.candidateId)
			)
		);
	return {
		companies: { open: verification?.open ?? 0, overdue: verification?.overdue ?? 0 },
		objections: {
			open: objections?.open ?? 0,
			unassigned: objections?.unassigned ?? 0,
			overdue: objections?.overdue ?? 0,
			dueSoon: objections?.dueSoon ?? 0
		},
		representatives: { awaiting: awaiting?.n ?? 0 },
		vacancies: { pending: await pendingVacancyModeration(executor, reach) },
		ages: { open: await ageConflictCount(executor, subject) },
		attempts: await attemptsForReviewCount(executor, subject, now)
	};
}
