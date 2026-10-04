// Jobs of a terms version (docs/domain.md, section 17.2): `invitation.expire` at the response deadline and
// `invitation.remind_due` at the reminder slots of `notification_policy`, enqueued in the transaction of the version.
import type { Executor, Transaction } from '$lib/server/db';
import { cancelWaitingJobs, enqueueJob } from '$lib/server/jobs/queue';
import { currentPolicy } from './policies';

const HOUR = 3_600_000;

export interface ReminderSlot {
	/** Hours before the deadline. */
	hours: number;
	at: Date;
}

/** Reminder slots of a deadline, earliest first. */
export function reminderSlots(dueAt: Date, hoursBefore: readonly number[]): ReminderSlot[] {
	return [...new Set(hoursBefore)]
		.map((hours) => ({ hours, at: new Date(dueAt.getTime() - hours * HOUR) }))
		.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The reminder hours in force; no `notification_policy` — no reminders (the schedule is a product decision). */
export async function reminderHours(executor: Executor, at: Date): Promise<number[]> {
	return (await currentPolicy(executor, 'notification_policy', at))?.params.response_due_reminder_hours ?? [];
}

/** Enqueues the reminder of the first slot after `after`; nothing when every slot has passed. */
export async function scheduleNextReminder(
	tx: Transaction,
	terms: { id: string; responseDueAt: Date },
	hoursBefore: readonly number[],
	after: Date
): Promise<void> {
	const next = reminderSlots(terms.responseDueAt, hoursBefore).find((slot) => slot.at > after);
	if (!next) return;
	await enqueueJob(
		tx,
		'invitation.remind_due',
		{ terms_id: terms.id },
		{ inputVersion: terms.id, createdBy: { kind: 'system' }, runAfter: next.at }
	);
}

export async function scheduleTermsJobs(
	tx: Transaction,
	terms: { id: string; responseDueAt: Date },
	now: Date,
	createdBy: { kind: 'user'; id: string } | { kind: 'system' }
): Promise<void> {
	await enqueueJob(
		tx,
		'invitation.expire',
		{ terms_id: terms.id },
		{ inputVersion: terms.id, createdBy, runAfter: terms.responseDueAt }
	);
	await scheduleNextReminder(tx, terms, await reminderHours(tx, now), now);
}

/** A replaced or answered version needs neither its deadline nor its reminders. */
export async function cancelTermsJobs(tx: Transaction, termsId: string): Promise<void> {
	await cancelWaitingJobs(tx, 'invitation.expire', { terms_id: termsId });
	await cancelWaitingJobs(tx, 'invitation.remind_due', { terms_id: termsId });
}
