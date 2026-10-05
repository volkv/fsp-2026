// Job `vacancies.text_recheck` (docs/domain.md, section 13.1): a new version of the text check applies to the vacancies
// already stored, not only to the texts written after it. A vacancy whose `text_check` comes from another version is
// checked again, a batch per run; a run that found more enqueues its own continuation. An own vacancy follows the rules
// of an edit that keeps its text: a listed one whose text is now blocked goes to an operator unless the operator
// already approved the same phrases; one in moderation whose text now passes returns to where it left from, and one
// whose blocking phrases changed gets a new revision, so a decision on the phrases read before is refused. An external
// one is recomputed as its import does, so a blocked text hides it and a text no longer blocked brings it back. The
// schedule enqueues the job while vacancies lag behind the version.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Executor, Transaction } from '$lib/server/db';
import { jobs, vacancies } from '$lib/server/db/schema';
import { defineHandler, type JobHandler } from '$lib/server/jobs/handler';
import { enqueueJob, type JobCreator } from '$lib/server/jobs/queue';
import { jobSpec } from '$lib/server/jobs/registry';
import { LOCK_NAMESPACE } from '$lib/server/jobs/scheduler';
import { loadStaleAfterDays, recomputeCluster } from './clusters';
import { companyAdmitted, enqueueRevisionDerivations } from './derivations';
import { moderationCaseOf, publishNow } from './own';
import {
	TEXT_CHECK_VERSION,
	checkVacancyText,
	sameBlockingFindings,
	sameFindings,
	textCheckSchema,
	type TextCheck
} from './text-check';

const TYPE = 'vacancies.text_recheck';

/** Vacancies one run checks; the rest are left to its continuation. */
export const RECHECK_BATCH = 200;

const CREATOR: JobCreator = { kind: 'system', id: TYPE };

/** A vacancy whose stored check is of another version than the one in force. */
const lagging = sql`${vacancies.textCheck} ->> 'validator_version' is distinct from ${TEXT_CHECK_VERSION}`;

type Outcome = 'restamped' | 'moderation' | 'revised' | 'cleared' | 'hidden' | 'shown' | 'unchanged';

/**
 * The check of an own vacancy under the version in force. The operator decided on the phrases, not on the version that
 * found them: an approval, like a confirmation of warnings, stays while the new version finds the same phrases.
 */
async function recheckOwn(
	tx: Transaction,
	row: typeof vacancies.$inferSelect,
	now: Date,
	requestId: string
): Promise<Outcome> {
	const previous = textCheckSchema.parse(row.textCheck);
	const fresh = checkVacancyText({ title: row.title, description: row.description });
	const asFresh: TextCheck = { ...previous, validator_version: fresh.validator_version };
	const listedAs = row.status === 'published' || row.status === 'paused' ? row.status : null;
	let check: TextCheck = {
		...fresh,
		warnings_confirmed:
			fresh.result === 'warnings' && sameFindings(asFresh, fresh) ? previous.warnings_confirmed : null,
		moderation: previous.moderation
	};
	if (row.status === 'pending_moderation' && fresh.result !== 'blocked') {
		await clearModeration(tx, row, check, now, requestId);
		return 'cleared';
	}
	if (row.status === 'pending_moderation' && !sameBlockingFindings(asFresh, fresh)) {
		// The operator decides on the revision they read: other phrases in the case are a new revision, as an edit
		// would make, and a decision taken on the previous one is refused.
		const [revised] = await tx
			.update(vacancies)
			.set({
				textCheck: check,
				revision: sql`${vacancies.revision} + 1`,
				// The pool was counted at the previous revision: until `match.refresh` of this one it is «being counted».
				poolCount: null,
				poolCountedAt: null
			})
			.where(eq(vacancies.id, row.id))
			.returning({ revision: vacancies.revision });
		if (!revised) throw new Error('vacancy disappeared while locked');
		await enqueueRevisionDerivations(tx, row.id, revised.revision, CREATOR);
		return 'revised';
	}
	if (listedAs === null) {
		await tx.update(vacancies).set({ textCheck: check }).where(eq(vacancies.id, row.id));
		return 'restamped';
	}
	const approved = previous.moderation?.decision?.outcome === 'published' && sameBlockingFindings(asFresh, fresh);
	if (fresh.result === 'blocked' && !approved) {
		check = { ...check, moderation: { opened_at: now.toISOString(), resume_to: listedAs, decision: null } };
		await tx.update(vacancies).set({ status: 'pending_moderation', textCheck: check }).where(eq(vacancies.id, row.id));
		await recordAuditEvent(tx, {
			action: 'vacancy.blocked_text_check',
			outcome: 'success',
			actor: { kind: 'system' },
			object: { type: 'vacancy', id: row.id },
			requestId,
			details: { rules: fresh.phrases.filter((p) => p.severity === 'block').map((p) => p.rule) }
		});
		return 'moderation';
	}
	// A listed text that passes carries no case; an approved one keeps it, as an edit keeping the phrases does.
	if (fresh.result !== 'blocked') check = { ...check, moderation: null };
	await tx.update(vacancies).set({ textCheck: check }).where(eq(vacancies.id, row.id));
	return 'restamped';
}

/**
 * A vacancy in moderation whose text the version in force passes returns to where the check would have let it, as after
 * an edit that passes: to the listing it left, or to a draft when its company is no longer verified.
 */
async function clearModeration(
	tx: Transaction,
	row: typeof vacancies.$inferSelect,
	check: TextCheck,
	now: Date,
	requestId: string
): Promise<void> {
	const resumeTo = moderationCaseOf(textCheckSchema.parse(row.textCheck)).resume_to;
	if (row.companyId === null) throw new Error('an own vacancy carries no company');
	const status = (await companyAdmitted(tx, row.companyId)) ? resumeTo : 'draft';
	const [cleared] = await tx
		.update(vacancies)
		.set({
			textCheck: { ...check, moderation: null },
			// Publication itself, with its moment and journal, is `publishNow` below.
			status: status === 'published' ? row.status : status
		})
		.where(eq(vacancies.id, row.id))
		.returning();
	if (!cleared) throw new Error('vacancy disappeared while locked');
	await recordAuditEvent(tx, {
		action: 'vacancy.moderation_cleared',
		outcome: 'success',
		actor: { kind: 'system' },
		object: { type: 'vacancy', id: row.id },
		requestId,
		details: { status }
	});
	if (status === 'published') await publishNow(tx, cleared, now, { kind: 'system' }, requestId, CREATOR);
}

/** An external vacancy recomputed from its postings, as the import and the freshness check do. */
async function recheckExternal(
	tx: Transaction,
	row: typeof vacancies.$inferSelect,
	now: Date,
	staleAfterDays: number | null
): Promise<Outcome> {
	const change = await recomputeCluster(tx, row.id, { taxonomyVersionId: null, now, staleAfterDays });
	if (change.revised) await enqueueRevisionDerivations(tx, row.id, change.revision, CREATOR);
	if (!change.statusChanged) return 'unchanged';
	return change.status === 'hidden' ? 'hidden' : row.status === 'hidden' ? 'shown' : 'unchanged';
}

async function laggingBatch(executor: Executor): Promise<{ ids: string[]; more: boolean }> {
	const rows = await executor
		.select({ id: vacancies.id })
		.from(vacancies)
		.where(lagging)
		.orderBy(asc(vacancies.id))
		.limit(RECHECK_BATCH + 1);
	return { ids: rows.slice(0, RECHECK_BATCH).map((row) => row.id), more: rows.length > RECHECK_BATCH };
}

/** Handler of `vacancies.text_recheck` for the job registry. */
export const vacanciesTextRecheck: JobHandler<'vacancies.text_recheck'> = defineHandler({
	type: TYPE,
	concurrency: 1,
	run: async ({ job, db, requestId }) => {
		const counts: Record<Outcome, number> = {
			restamped: 0,
			moderation: 0,
			revised: 0,
			cleared: 0,
			hidden: 0,
			shown: 0,
			unchanged: 0
		};
		// A job of another version was enqueued by a worker of another release: the version in force has a job of its own.
		const outdated = job.payload.validator_version !== TEXT_CHECK_VERSION;
		const batch = outdated ? { ids: [], more: false } : await laggingBatch(db);
		return {
			isCurrent: () => Promise.resolve(true),
			write: async (tx) => {
				if (batch.ids.length === 0) return;
				const now = new Date();
				const staleAfterDays = await loadStaleAfterDays(tx, now);
				// Locked in the order of ids, as they were read; a vacancy edited meanwhile already carries the new check.
				const rows = await tx
					.select()
					.from(vacancies)
					.where(and(inArray(vacancies.id, batch.ids), lagging))
					.orderBy(asc(vacancies.id))
					.for('update');
				for (const row of rows) {
					const outcome =
						row.origin === 'own'
							? await recheckOwn(tx, row, now, requestId)
							: await recheckExternal(tx, row, now, staleAfterDays);
					counts[outcome]++;
				}
				// The vacancies just checked no longer lag: the continuation reads the next ones. It waits under the same
				// key until this run finishes.
				if (batch.more) {
					await enqueueJob(tx, TYPE, job.payload, { inputVersion: job.inputVersion, createdBy: CREATOR });
				}
			},
			describe: () => ({ ...counts, outdated, more: batch.more })
		};
	}
});

/**
 * Schedule tick: enqueues the recheck of the version in force while a vacancy lags behind it and no job of the version
 * waits or runs. A failed one is not restarted: it holds back the recheck of this version until the next version of the
 * validator, which gets a job of its own. No page shows the jobs of this type — the failure is read in the worker's log
 * and in `jobs` (`last_error`), and there is no tool to restart it.
 */
export async function scheduleTextRecheck(db: Database): Promise<number> {
	const payload = { validator_version: TEXT_CHECK_VERSION };
	const dedupKey = jobSpec(TYPE).dedupKey(payload);
	return db.transaction(async (tx) => {
		const [lock] = await tx.execute<{ locked: boolean }>(
			sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${TYPE})) as locked`
		);
		if (!lock?.locked) return 0;
		const [blocking] = await tx
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.dedupKey, dedupKey), inArray(jobs.status, ['queued', 'running', 'failed'])))
			.limit(1);
		if (blocking) return 0;
		const [behind] = await tx.select({ id: vacancies.id }).from(vacancies).where(lagging).limit(1);
		if (!behind) return 0;
		await enqueueJob(tx, TYPE, payload, { inputVersion: TEXT_CHECK_VERSION, createdBy: CREATOR });
		return 1;
	});
}
