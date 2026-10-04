// `hiringState(process, at)` (docs/domain.md, section 13.7): the stage and the outcome of a hiring process derived from
// the append-only reports of both sides. Silence is never an outcome: without reports the process is pending until its
// due date and then unknown once the reminders are exhausted. Pure functions.
import { HIRING_STAGES, type PolicyParams } from '$lib/server/consent/kinds';

const DAY = 86_400_000;

export type Party = 'company' | 'candidate';
export type Stage = (typeof HIRING_STAGES)[number];
export const OUTCOMES = ['hired', 'not_hired', 'candidate_withdrew', 'company_stopped', 'no_contact'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface ReportFacts {
	id: string;
	party: Party;
	kind: 'stage' | 'outcome';
	stage: Stage | null;
	outcome: Outcome | null;
	startDate: string | null;
	reasonCode: string | null;
	supersedesReportId: string | null;
	reportedAt: Date;
}

export type OutcomeStatus = 'pending' | 'single_party' | 'confirmed' | 'diverged' | 'unknown';

export interface HiringState {
	/** The furthest stage reported by at least one side, with the sides that reported it. */
	stage: { stage: Stage; reportedBy: Party[] } | null;
	outcome: OutcomeStatus;
	/** Pending after the due date: reminders are still being sent. */
	overdue: boolean;
	/** The report in force of each side. */
	reports: Record<Party, ReportFacts | null>;
	/** The agreed result of a `confirmed` process. */
	result: 'hired' | 'not_hired' | null;
	/** The moment of the second agreeing report; `confirmed_at − opened_at` is the time to confirmation. */
	confirmedAt: Date | null;
}

type HiringPolicy = PolicyParams<'hiring_policy'>;

/** Reports not corrected by a later report of the same side. */
export function reportsInForce(reports: readonly ReportFacts[]): ReportFacts[] {
	const superseded = new Set(reports.flatMap((r) => (r.supersedesReportId ? [r.supersedesReportId] : [])));
	return reports.filter((report) => !superseded.has(report.id));
}

/** Days between reminder `n − 1` and reminder `n` (n ≥ 1): the last interval repeats. */
function intervalDays(policy: HiringPolicy, n: number): number | null {
	const intervals = policy.reminder_intervals_days;
	if (intervals.length === 0) return null;
	return intervals[Math.min(n - 1, intervals.length - 1)] ?? null;
}

/**
 * When outcome request `n` is sent: `0` at the due date, then after each interval of the policy. `null` — the policy
 * has no reminder `n`.
 */
export function outcomeRequestAt(outcomeDueAt: Date, policy: HiringPolicy, n: number): Date | null {
	if (n === 0) return outcomeDueAt;
	if (n > policy.max_reminders) return null;
	let at = outcomeDueAt.getTime();
	for (let i = 1; i <= n; i++) {
		const days = intervalDays(policy, i);
		if (days === null) return null;
		at += days * DAY;
	}
	return new Date(at);
}

/**
 * The moment the reminders are exhausted: one interval after the last reminder, so the last request still has time to
 * be answered; the due date itself when the policy has no reminders.
 */
export function outcomeUnknownAt(outcomeDueAt: Date, policy: HiringPolicy): Date {
	let at = outcomeDueAt.getTime();
	for (let i = 1; i <= policy.max_reminders + 1; i++) {
		const days = intervalDays(policy, i);
		if (days === null) break;
		at += days * DAY;
	}
	return new Date(at);
}

/** Both `hired`, or both from the «not hired» group (every other outcome): any two of those agree. */
const agree = (a: Outcome, b: Outcome) => (a === 'hired') === (b === 'hired');

function latest(reports: readonly ReportFacts[]): ReportFacts | null {
	return reports.reduce<ReportFacts | null>(
		(last, report) => (last === null || report.reportedAt >= last.reportedAt ? report : last),
		null
	);
}

export function hiringState(
	process: { openedAt: Date; outcomeDueAt: Date },
	reports: readonly ReportFacts[],
	policy: HiringPolicy,
	at: Date
): HiringState {
	const current = reportsInForce(reports.filter((r) => r.reportedAt <= at));

	const stageReports = current.filter((r) => r.kind === 'stage' && r.stage !== null);
	const top = stageReports.reduce<Stage | null>((best, report) => {
		const stage = report.stage as Stage;
		return best === null || HIRING_STAGES.indexOf(stage) > HIRING_STAGES.indexOf(best) ? stage : best;
	}, null);
	const stage =
		top === null
			? null
			: { stage: top, reportedBy: [...new Set(stageReports.filter((r) => r.stage === top).map((r) => r.party))] };

	const outcomeOf = (party: Party) => latest(current.filter((r) => r.kind === 'outcome' && r.party === party));
	const company = outcomeOf('company');
	const candidate = outcomeOf('candidate');
	const base = { stage, reports: { company, candidate }, overdue: false, result: null, confirmedAt: null };

	if (company?.outcome && candidate?.outcome) {
		if (!agree(company.outcome, candidate.outcome)) return { ...base, outcome: 'diverged' };
		const confirmedAt = company.reportedAt > candidate.reportedAt ? company.reportedAt : candidate.reportedAt;
		return {
			...base,
			outcome: 'confirmed',
			result: company.outcome === 'hired' ? 'hired' : 'not_hired',
			confirmedAt
		};
	}
	if (company || candidate) return { ...base, outcome: 'single_party' };
	if (at < process.outcomeDueAt) return { ...base, outcome: 'pending' };
	if (at < outcomeUnknownAt(process.outcomeDueAt, policy)) return { ...base, outcome: 'pending', overdue: true };
	return { ...base, outcome: 'unknown' };
}
