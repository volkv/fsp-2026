// Majority (docs/domain.md, sections 6.3, 6.4, 7.3): on the day a candidate turns 18, `candidate.majority_transition`
// records `lapse` for every consent still resting on a grant signed during minority — the candidate's own and the
// representative's alike — ends the representation (`majority`), hides the profile from the catalog and asks the
// candidate to sign again. The rule of `effectiveConsent` stops such grants from acting even without the job; the job
// makes it visible in the history, in the journal and to the candidate. The schedule looks once a day for adults whose
// consents or representation still date from minority and enqueues one job per candidate for that day.
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import { recordProfileChange } from '$lib/server/candidates/settings';
import type { Database, Transaction } from '$lib/server/db';
import { candidates, consentEvents, emailTokens, representations } from '$lib/server/db/schema';
import { defineHandler, type JobHandler } from '$lib/server/jobs/handler';
import { enqueueJob } from '$lib/server/jobs/queue';
import { LOCK_NAMESPACE } from '$lib/server/jobs/scheduler';
import { notify } from '$lib/server/notifications/notify';
import { ageBand, type BirthDateInfo } from '$lib/server/visibility/age';

/** Candidates enqueued by one tick at most; the rest are found by the next ticks of the same day. */
const TICK_LIMIT = 200;

const utcDate = (at: Date) => at.toISOString().slice(0, 10);

/**
 * Enqueues the transition of each adult candidate whose representation is not ended or whose consent still rests on a
 * grant of minority, once per UTC day: a candidate with a job of the day, whatever its outcome, waits for the next
 * day. The age is checked exactly by the job; the query only narrows by the birth date.
 */
export async function scheduleMajorityTransitions(db: Database, now: Date): Promise<number> {
	const day = utcDate(now);
	return db.transaction(async (tx) => {
		const [lock] = await tx.execute<{ locked: boolean }>(
			sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext('candidate.majority_transition')) as locked`
		);
		if (!lock?.locked) return 0;
		// With year precision the whole year must be past 18 (domain 7.2): the youngest birthday of the year counts.
		const majorityAt = sql`(c.birth_date + case when c.birth_date_precision = 'year' then interval '19 years' else interval '18 years' end)`;
		const due = await tx.execute<{ id: string }>(sql`
			select c.id from candidates c
			where c.status = 'active'
				and c.birth_date is not null
				and c.birth_date_status in ('unverified', 'verified')
				and ${majorityAt} <= ${day}::date
				and (
					exists (select 1 from representations r where r.candidate_id = c.id and r.status <> 'ended')
					or exists (
						select 1 from (
							select distinct on (e.kind, e.scope_invitation_id, e.scope_competition_ref) e.action, e.occurred_at
							from consent_events e
							where e.subject_candidate_id = c.id
							order by e.kind, e.scope_invitation_id, e.scope_competition_ref, e.occurred_at desc, e.id desc
						) last
						where last.action = 'grant' and last.occurred_at < ${majorityAt}
					)
				)
				and not exists (
					select 1 from jobs j
					where j.type = 'candidate.majority_transition'
						and j.payload ->> 'candidate_id' = c.id::text
						and j.input_version = ${day}
				)
			order by c.id
			limit ${TICK_LIMIT}`);
		for (const { id } of due) {
			await enqueueJob(
				tx,
				'candidate.majority_transition',
				{ candidate_id: id },
				{ inputVersion: day, createdBy: { kind: 'system', id: 'scheduler' } }
			);
		}
		return due.length;
	});
}

interface MajorityOutcome {
	lapsed: number;
	representationsEnded: number;
}

/**
 * The transition in the caller's transaction; `null` — the candidate is not an adult active profile now (a date
 * corrected meanwhile, a deleted profile): nothing to do.
 */
async function applyMajority(
	tx: Transaction,
	candidateId: string,
	at: Date,
	requestId: string
): Promise<MajorityOutcome | null> {
	const [candidate] = await tx
		.select({
			userId: candidates.userId,
			status: candidates.status,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId))
		.for('update');
	if (candidate?.status !== 'active') return null;
	const birth: BirthDateInfo = {
		birthDate: candidate.birthDate,
		precision: candidate.precision,
		status: candidate.birthStatus
	};
	if (ageBand(birth, at) !== 'adult') return null;
	const journal = {
		outcome: 'success' as const,
		actor: { kind: 'system' as const },
		subjectCandidateId: candidateId,
		requestId,
		occurredAt: at
	};

	const events = await tx
		.select()
		.from(consentEvents)
		.where(eq(consentEvents.subjectCandidateId, candidateId))
		.orderBy(asc(consentEvents.occurredAt), asc(consentEvents.id));
	const lastOfScope = new Map<string, (typeof events)[number]>();
	for (const event of events) {
		lastOfScope.set(`${event.kind}:${event.scopeInvitationId ?? ''}:${event.scopeCompetitionRef ?? ''}`, event);
	}
	let lapsed = 0;
	for (const last of lastOfScope.values()) {
		if (last.action !== 'grant' || ageBand(birth, last.occurredAt) === 'adult') continue;
		const [lapse] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidateId,
				kind: last.kind,
				documentId: last.documentId,
				action: 'lapse',
				signerKind: 'system',
				scopeCompanyId: last.scopeCompanyId,
				scopeInvitationId: last.scopeInvitationId,
				scopeCompetitionRef: last.scopeCompetitionRef,
				method: 'system',
				evidence: { cause: 'majority' },
				reason: 'majority',
				occurredAt: at
			})
			.returning({ id: consentEvents.id });
		if (!lapse) throw new Error('consent event was not inserted');
		await recordAuditEvent(tx, {
			...journal,
			action: 'consent.lapsed',
			object: { type: 'consent_event', id: lapse.id },
			details: { kind: last.kind, cause: 'majority' }
		});
		lapsed += 1;
	}

	const ended = await tx
		.update(representations)
		.set({ status: 'ended', endedAt: at, endReason: 'majority' })
		.where(and(eq(representations.candidateId, candidateId), ne(representations.status, 'ended')))
		.returning({ id: representations.id });
	for (const representation of ended) {
		await tx.delete(emailTokens).where(and(eq(emailTokens.targetRef, representation.id), sql`used_at is null`));
		await recordAuditEvent(tx, {
			...journal,
			action: 'representation.ended',
			object: { type: 'representation', id: representation.id },
			details: { end_reason: 'majority' }
		});
	}

	// The catalog is switched on again by the adult on the visibility page (domain 7.3).
	await tx.update(candidates).set({ visibility: 'hidden' }).where(eq(candidates.id, candidateId));
	await recordProfileChange(tx, candidateId, { evidenceInput: false, createdBy: { kind: 'system' } });
	await notify(tx, {
		userId: candidate.userId,
		type: 'candidate.majority_reached',
		objectId: candidateId,
		payload: { candidate_id: candidateId }
	});
	return { lapsed, representationsEnded: ended.length };
}

export const candidateMajorityTransition: JobHandler<'candidate.majority_transition'> = defineHandler({
	type: 'candidate.majority_transition',
	concurrency: 2,
	run: ({ job, requestId }) => {
		let outcome: MajorityOutcome | null = null;
		return Promise.resolve({
			// The transition reads the profile under its lock inside the write: the age is decided at the moment of it.
			isCurrent: () => Promise.resolve(true),
			write: async (tx) => {
				outcome = await applyMajority(tx, job.payload.candidate_id, new Date(), requestId);
			},
			describe: () => ({
				applied: outcome !== null,
				lapsed: outcome?.lapsed,
				representations_ended: outcome?.representationsEnded
			})
		});
	}
});
