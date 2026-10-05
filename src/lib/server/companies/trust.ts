// Facts of trust in a company (docs/domain.md, section 5.6): what the company did with the offers it sent over the last
// year, each fact as «so many of so many» with its number of observations. A fact with fewer observations than the
// threshold says «no data» without numbers — a count of one or two would tell about a particular candidate, and says
// nothing about the company. There is no overall index: every fact is read on its own, as it is computed.
//
// Facts are counted from the rows of the company itself (a clone company of a demo session has its own rows) and are
// never stored: a purged account leaves the counts with its rows.
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import {
	hiringProcesses,
	hiringReports,
	invitationComplaints,
	invitations,
	invitationTerms
} from '$lib/server/db/schema';
import { applicationAnswerCounts } from '$lib/server/applications/service';
import { reportsInForce, type ReportFacts } from '$lib/server/hiring/state';

/** A fact is shown from this many observations; below it — «no data». A product decision. */
export const TRUST_MIN_OBSERVATIONS = 3;
/** Facts look at the offers of the last year: what the company does now, not what it did long ago. */
export const TRUST_WINDOW_DAYS = 365;
/** The first step of hiring the company reports after an acceptance counts when it comes within these days. */
export const FIRST_STEP_DAYS = 7;

const DAY = 86_400_000;

/**
 * Keys in the order of the interface: the answers to candidates' applications, what the company did after the candidate
 * said yes, then how it treated its terms.
 */
export const TRUST_FACT_KEYS = [
	'applications_answered',
	'first_step_in_time',
	'outcome_reported',
	'outcome_agreed',
	'salary_lowered',
	'offers_withdrawn',
	'complaints_upheld'
] as const;

export type TrustFactKey = (typeof TRUST_FACT_KEYS)[number];

export type TrustFact =
	{ key: TrustFactKey; status: 'shown'; count: number; of: number } | { key: TrustFactKey; status: 'no_data' };

export interface CompanyTrust {
	windowDays: number;
	minObservations: number;
	facts: TrustFact[];
}

function fact(key: TrustFactKey, matched: number, observed: number): TrustFact {
	return observed < TRUST_MIN_OBSERVATIONS
		? { key, status: 'no_data' }
		: { key, status: 'shown', count: matched, of: observed };
}

const isHired = (outcome: string | null) => outcome === 'hired';

/** What the company did after acceptances: the first step in time, the outcome reported, agreed with the candidate. */
async function processFacts(executor: Executor, companyId: string, since: Date, now: Date): Promise<TrustFact[]> {
	const processes = await executor
		.select({ id: hiringProcesses.id, openedAt: hiringProcesses.openedAt, outcomeDueAt: hiringProcesses.outcomeDueAt })
		.from(hiringProcesses)
		.where(and(eq(hiringProcesses.companyId, companyId), gte(hiringProcesses.openedAt, since)));
	const reports =
		processes.length === 0
			? []
			: await executor
					.select()
					.from(hiringReports)
					.where(
						inArray(
							hiringReports.processId,
							processes.map((process) => process.id)
						)
					);
	const byProcess = new Map<string, ReportFacts[]>();
	for (const report of reports) {
		const list = byProcess.get(report.processId) ?? [];
		list.push(report);
		byProcess.set(report.processId, list);
	}
	const firstStep = { matched: 0, observed: 0 };
	const reported = { matched: 0, observed: 0 };
	const agreed = { matched: 0, observed: 0 };
	for (const process of processes) {
		const all = byProcess.get(process.id) ?? [];
		const company = all.filter((report) => report.party === 'company');
		const stepDue = process.openedAt.getTime() + FIRST_STEP_DAYS * DAY;
		const inTime = company.some((report) => report.reportedAt.getTime() <= stepDue);
		// A process counts once its window is over, or earlier when the company already made its step.
		if (inTime || stepDue <= now.getTime()) {
			firstStep.observed++;
			if (inTime) firstStep.matched++;
		}
		const inForce = reportsInForce(all).filter((report) => report.kind === 'outcome');
		const companyOutcome = inForce.find((report) => report.party === 'company');
		const candidateOutcome = inForce.find((report) => report.party === 'candidate');
		if (companyOutcome || process.outcomeDueAt <= now) {
			reported.observed++;
			if (companyOutcome) reported.matched++;
		}
		if (companyOutcome && candidateOutcome) {
			agreed.observed++;
			if (isHired(companyOutcome.outcome) === isHired(candidateOutcome.outcome)) agreed.matched++;
		}
	}
	return [
		fact('first_step_in_time', firstStep.matched, firstStep.observed),
		fact('outcome_reported', reported.matched, reported.observed),
		fact('outcome_agreed', agreed.matched, agreed.observed)
	];
}

/** The facts of the company now. */
export async function companyTrust(executor: Executor, companyId: string, now: Date): Promise<CompanyTrust> {
	const since = new Date(now.getTime() - TRUST_WINDOW_DAYS * DAY);
	// Lines of offers sent within the window, tombstones of purged accounts included: they keep the status.
	const [lines] = await executor
		.select({
			total: count(),
			withdrawn: sql<number>`count(*) filter (where ${invitations.status} = 'withdrawn')`.mapWith(Number)
		})
		.from(invitations)
		.where(and(eq(invitations.companyId, companyId), gte(invitations.sentAt, since)));
	// New versions of terms: a revision or a reopening, each compared with every earlier version (domain 13.5).
	const [versions] = await executor
		.select({
			total: count(),
			lowered: sql<number>`count(*) filter (where (${invitationTerms.changes} ->> 'salary_lowered')::boolean)`.mapWith(
				Number
			)
		})
		.from(invitationTerms)
		.innerJoin(invitations, eq(invitations.id, invitationTerms.invitationId))
		.where(
			and(
				eq(invitations.companyId, companyId),
				sql`${invitationTerms.version} > 1`,
				gte(invitationTerms.createdAt, since)
			)
		);
	const [complaints] = await executor
		.select({ upheld: count() })
		.from(invitationComplaints)
		.where(
			and(
				eq(invitationComplaints.companyId, companyId),
				inArray(invitationComplaints.decision, ['warning', 'suspension']),
				gte(invitationComplaints.createdAt, since)
			)
		);
	const answers = await applicationAnswerCounts(executor, companyId, since);
	if (!lines || !versions || !complaints) throw new Error('an aggregate returned no row');
	const facts = new Map<TrustFactKey, TrustFact>(
		[
			fact('applications_answered', answers.answered, answers.received),
			...(await processFacts(executor, companyId, since, now)),
			fact('salary_lowered', versions.lowered, versions.total),
			fact('offers_withdrawn', lines.withdrawn, lines.total),
			fact('complaints_upheld', complaints.upheld, lines.total)
		].map((item) => [item.key, item])
	);
	return {
		windowDays: TRUST_WINDOW_DAYS,
		minObservations: TRUST_MIN_OBSERVATIONS,
		facts: TRUST_FACT_KEYS.map((key) => {
			const item = facts.get(key);
			if (!item) throw new Error(`trust fact ${key} was not computed`);
			return item;
		})
	};
}
