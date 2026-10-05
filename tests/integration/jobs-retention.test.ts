import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAuditEvent } from '$lib/server/audit/record';
import {
	auditEvents,
	candidates,
	consentEvents,
	disclosures,
	invitations,
	jobs,
	notifications,
	productPolicies,
	staffRoles,
	testArtifacts,
	testItems,
	users
} from '$lib/server/db/schema';
import { SWEEP_LIMIT } from '$lib/server/erasure/retention';
import { JobFailure } from '$lib/server/jobs/handler';
import { JOB_HANDLERS } from '$lib/server/jobs/handlers';
import { createLogger } from '$lib/server/jobs/log';
import { enqueueJob } from '$lib/server/jobs/queue';
import { JOURNAL_MONTHS_AHEAD, sweepJournal, sweepPersonalData } from '$lib/server/jobs/retention';
import { startWorker } from '$lib/server/jobs/worker';
import { insertAttempt, releaseFixtureBank } from '../helpers/bank';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createPolicy,
	createPublishedDocument,
	createUser
} from '../helpers/factories';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.drop();
});

async function partitions(): Promise<string[]> {
	const rows = await database.sql<{ name: string }[]>`
		select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
		where i.inhparent = 'audit_events'::regclass order by c.relname`;
	return rows.map((row) => row.name);
}

/** First day of the month `offset` months from the current one, UTC, as `YYYY-MM-DD`. */
function monthStart(offset: number): string {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
}

const monthPartition = (offset: number) => `audit_events_${monthStart(offset).slice(0, 7).replace('-', '_')}`;

async function createMonth(first: string): Promise<void> {
	await database.sql`select audit_events_ensure_partitions(${first}::date, 1)`;
}

/** Enqueues the sweep of `date` and runs it through the registered handler; returns the job and its finish log. */
async function runSweep(date: string): Promise<{ jobId: string; finished: Record<string, unknown> }> {
	const { db } = database;
	const { jobId } = await db.transaction((tx) =>
		enqueueJob(tx, 'retention.sweep', { date }, { inputVersion: date, createdBy: { kind: 'system' } })
	);
	const lines: Record<string, unknown>[] = [];
	const worker = startWorker({
		db,
		handlers: JOB_HANDLERS,
		types: ['retention.sweep'],
		pollIntervalMs: 20,
		// The schedule would enqueue today's sweep too; this runs the one above only.
		scheduleIntervalMs: 60_000,
		now: () => new Date(`${date}T00:00:00Z`),
		log: createLogger({}, (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>))
	});
	const finishLine = () => lines.find((line) => line.job_id === jobId && line.msg === 'job finished');
	try {
		const deadline = Date.now() + 10_000;
		// The finish line is logged after the result is written, so the job row is final once it is there.
		while (!finishLine()) {
			const [row] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId));
			if (row?.status === 'failed' || Date.now() > deadline) throw new Error(`sweep ended as ${row?.status}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	} finally {
		await worker.stop();
	}
	const finished = finishLine();
	if (finished?.outcome !== 'succeeded') throw new Error(`sweep finished as ${String(finished?.outcome)}`);
	return { jobId, finished };
}

describe('retention.sweep', () => {
	it('keeps journal partitions ahead and drops nothing without a retention policy', async () => {
		await createMonth('2020-01-01');
		// The furthest month of the horizon is missing (the migration created months up to 25 ahead).
		await database.sql.unsafe(`drop table ${monthPartition(JOURNAL_MONTHS_AHEAD)}`);
		const summary = await database.db.transaction((tx) => sweepJournal(tx, 'job:test'));
		expect(summary).toMatchObject({ partitionsDropped: 0, policyInEffect: false });
		const names = await partitions();
		expect(names).toContain('audit_events_2020_01');
		expect(names).toContain(monthPartition(JOURNAL_MONTHS_AHEAD));
		expect(summary.partitionsCreated).toBe(1);
	});

	it('drops the months past the retention period through the worker, one journal event each', async () => {
		const { db } = database;
		await recordAuditEvent(db, {
			action: 'auth.logout',
			outcome: 'success',
			actor: { kind: 'system' },
			requestId: 'req-old',
			occurredAt: new Date('2020-01-15T10:00:00Z')
		});
		// Within 36 months: stays.
		await createMonth(monthStart(-30));
		await db.insert(productPolicies).values({
			kind: 'retention_policy',
			version: 1,
			params: { audit_retention_months: 36, disclosure_retention_months: 36, inactive_candidate_purge_days: 730 },
			effectiveFrom: new Date(Date.now() - 60_000)
		});
		const { jobId } = await runSweep('2026-10-07');

		const names = await partitions();
		expect(names).not.toContain('audit_events_2020_01');
		expect(names).toContain(monthPartition(-30));
		expect(names).toContain(monthPartition(0));
		const events = await db
			.select({ requestId: auditEvents.requestId, details: auditEvents.details, actorKind: auditEvents.actorKind })
			.from(auditEvents)
			.where(eq(auditEvents.action, 'audit.partition_dropped'));
		expect(events).toContainEqual({
			requestId: `job:${jobId}`,
			actorKind: 'system',
			details: { partition: 'audit_events_2020_01', range_from: '2020-01-01', range_to: '2020-02-01' }
		});
		// Every dropped month has its event; nothing inside the retention period was dropped.
		const dropped = events.map((event) => (event.details as { partition: string }).partition);
		expect(dropped.every((name) => name < monthPartition(-36))).toBe(true);
		const [old] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(auditEvents)
			.where(eq(auditEvents.requestId, 'req-old'));
		expect(old?.count).toBe(0);
	});

	it('clears the content of attempt artifacts past their retention in the same sweep', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const { releaseId, families } = await releaseFixtureBank(db, 'qa');
		const family = families[0];
		if (!family) throw new Error('no fixture family');
		const startedAt = new Date('2020-03-01T10:00:00Z');
		const attempt = await insertAttempt(db, { candidateId: candidate.id, releaseId, status: 'expired', startedAt });
		const [item] = await db
			.insert(testItems)
			.values({
				attemptId: attempt.id,
				seq: 1,
				block: family.descriptor.block,
				format: family.descriptor.format,
				practice: false,
				familyKey: family.descriptor.key,
				familyVersion: 1,
				classId: 'a',
				instanceSeed: 's',
				instance: family.module.generate({ seed: 's', grade: 'intern', classId: 'a' }),
				angoff: 0.6,
				servedAt: startedAt,
				status: 'served'
			})
			.returning({ id: testItems.id });
		if (!item) throw new Error('item not inserted');
		await db.insert(testArtifacts).values([
			{
				attemptId: attempt.id,
				itemId: item.id,
				seq: 1,
				kind: 'answer',
				content: { answer: 'a' },
				sha256: 'b'.repeat(64),
				retentionUntil: '2021-03-01'
			},
			{
				attemptId: attempt.id,
				itemId: item.id,
				seq: 2,
				kind: 'answer',
				content: { answer: 'b' },
				sha256: 'c'.repeat(64),
				retentionUntil: '2100-01-01'
			}
		]);

		const { finished } = await runSweep('2026-10-08');
		expect(finished).toMatchObject({ artifacts_cleared: 1 });
		const rows = await db
			.select({
				seq: testArtifacts.seq,
				content: testArtifacts.content,
				sha256: testArtifacts.sha256
			})
			.from(testArtifacts)
			.where(eq(testArtifacts.attemptId, attempt.id))
			.orderBy(testArtifacts.seq);
		expect(rows).toEqual([
			{ seq: 1, content: null, sha256: 'b'.repeat(64) },
			{ seq: 2, content: { answer: 'b' }, sha256: 'c'.repeat(64) }
		]);
	});

	it('refuses a journal partition it did not create', async () => {
		await database.sql.unsafe(
			`create table audit_events_manual partition of audit_events for values from ('1999-01-01') to ('1999-02-01')`
		);
		const failure = await database.db
			.transaction((tx) => sweepJournal(tx, 'job:test'))
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(JobFailure);
		expect(failure).toMatchObject({ code: 'unknown_journal_partition', retryable: false });
		expect(await partitions()).toContain('audit_events_manual');
	});
});

const DAY = 86_400_000;

/** The notice before the removal for inactivity stated by the policy of these tests: not the shipped 30 days. */
const NOTICE_DAYS = 45;

const EARLIER_TERMS = {
	audit_retention_months: 36,
	disclosure_retention_months: 36,
	inactive_candidate_purge_days: 730,
	demo_session_hours: 24,
	demo_own_resume_hours: 24
};

async function retentionPolicy(): Promise<void> {
	await database.db
		.insert(productPolicies)
		.values({
			kind: 'retention_policy',
			version: 3,
			params: { ...EARLIER_TERMS, inactivity_notice_days: NOTICE_DAYS, fsp_batch_retention_days: 90 },
			effectiveFrom: new Date(Date.now() - 60_000)
		})
		.onConflictDoNothing();
}

/** A deleted profile whose contacts reached a company `daysAgo` days ago: the tombstones and the proof of the transfer. */
async function disclosedTombstone(daysAgo: number, disclosureDocumentId: string) {
	const { db } = database;
	const company = await createCompany(db);
	const member = await createMember(db, company.id);
	const policy = await createPolicy(db, 'invitation_policy', 100 + Math.floor(Math.random() * 1_000_000));
	const profile = await createCandidate(
		db,
		{
			status: 'deleted',
			birthDate: null,
			birthDatePrecision: null,
			birthDateSource: null,
			birthDateStatus: 'unknown'
		},
		{ processingConsent: false }
	);
	const at = new Date(Date.now() - daysAgo * DAY);
	const [invitation] = await db
		.insert(invitations)
		.values({
			companyId: company.id,
			candidateId: profile.id,
			sentByMemberId: member.id,
			status: 'accepted',
			policyId: policy.id,
			sentAt: at,
			purgedAt: new Date()
		})
		.returning();
	if (!invitation) throw new Error('invitation not inserted');
	const [consent] = await db
		.insert(consentEvents)
		.values({
			subjectCandidateId: profile.id,
			kind: 'contact_disclosure',
			documentId: disclosureDocumentId,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: profile.userId,
			scopeCompanyId: company.id,
			scopeInvitationId: invitation.id,
			scopeFields: ['full_name', 'email'],
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: at
		})
		.returning();
	if (!consent) throw new Error('consent not inserted');
	const [disclosure] = await db
		.insert(disclosures)
		.values({
			candidateId: profile.id,
			companyId: company.id,
			recipientMemberId: member.id,
			invitationId: invitation.id,
			consentEventId: consent.id,
			fields: ['full_name', 'email'],
			channel: 'ui',
			disclosedAt: at
		})
		.returning();
	if (!disclosure) throw new Error('disclosure not inserted');
	return { profile, consent, disclosure };
}

describe('retention.sweep over personal data', () => {
	it('removes disclosures past disclosure_retention_months with the consent events nothing proves any more', async () => {
		const { db } = database;
		await retentionPolicy();
		const document = await createPublishedDocument(db, 'contact_disclosure', {
			publishedAt: new Date(Date.now() - 2000 * DAY)
		});
		const expired = await disclosedTombstone(37 * 31, document.id);
		const recent = await disclosedTombstone(30, document.id);

		const swept = await db.transaction((tx) => sweepPersonalData(tx, 'job:test', new Date()));
		expect(swept?.disclosures).toEqual({ disclosuresRemoved: 1, consentEventsRemoved: 1 });
		expect(await db.select().from(disclosures).where(eq(disclosures.id, expired.disclosure.id))).toEqual([]);
		expect(await db.select().from(consentEvents).where(eq(consentEvents.id, expired.consent.id))).toEqual([]);
		expect(await db.select().from(disclosures).where(eq(disclosures.id, recent.disclosure.id))).toHaveLength(1);
		expect(await db.select().from(consentEvents).where(eq(consentEvents.id, recent.consent.id))).toHaveLength(1);
	});

	it('tells an inactive candidate, keeps one who came back and deletes one who did not', async () => {
		const { db } = database;
		await retentionPolicy();
		const now = new Date();
		const today = now.toISOString().slice(0, 10);
		const longAgo = new Date(now.getTime() - 800 * DAY);
		const inactive = async (overrides: { lastLoginAt: Date; purgeAfter?: string }) => {
			const user = await createUser(db, { lastLoginAt: overrides.lastLoginAt, createdAt: longAgo });
			return createCandidate(db, { userId: user.id, purgeAfter: overrides.purgeAfter ?? null });
		};
		const quiet = await inactive({ lastLoginAt: longAgo });
		const noticedAt = new Date(now.getTime() - (NOTICE_DAYS + 1) * DAY);
		const gone = await inactive({
			lastLoginAt: longAgo,
			purgeAfter: new Date(noticedAt.getTime() + NOTICE_DAYS * DAY).toISOString().slice(0, 10)
		});
		// Noticed 10 days ago by the notice of the policy, signed in yesterday.
		const back = await inactive({
			lastLoginAt: new Date(now.getTime() - DAY),
			purgeAfter: new Date(now.getTime() + (NOTICE_DAYS - 10) * DAY).toISOString().slice(0, 10)
		});
		// Noticed 10 days ago, signed in the day before the notice: the removal stands.
		const beforeNotice = await inactive({
			lastLoginAt: new Date(now.getTime() - 11 * DAY),
			purgeAfter: new Date(now.getTime() + (NOTICE_DAYS - 10) * DAY).toISOString().slice(0, 10)
		});
		const active = await inactive({ lastLoginAt: new Date(now.getTime() - 10 * DAY) });

		const swept = await db.transaction((tx) => sweepPersonalData(tx, 'job:test', now));
		expect(swept?.inactivity).toMatchObject({ kept: 1, deleted: 1 });
		expect(swept?.inactivity?.noticed).toBeGreaterThanOrEqual(1);

		const profile = async (id: string) => {
			const [row] = await db.select().from(candidates).where(eq(candidates.id, id));
			if (!row) throw new Error('profile disappeared');
			return row;
		};
		const expectedPurge = new Date(`${today}T00:00:00Z`);
		expectedPurge.setUTCDate(expectedPurge.getUTCDate() + NOTICE_DAYS);
		expect((await profile(quiet.id)).purgeAfter).toBe(expectedPurge.toISOString().slice(0, 10));
		const notice = await db
			.select({ type: notifications.type, payload: notifications.payload })
			.from(notifications)
			.where(eq(notifications.userId, quiet.userId));
		expect(notice).toEqual([
			{
				type: 'candidate.inactive_purge_scheduled',
				payload: { candidate_id: quiet.id, purge_on: expectedPurge.toISOString().slice(0, 10) }
			}
		]);
		expect((await profile(back.id)).purgeAfter).toBeNull();
		expect((await profile(beforeNotice.id)).purgeAfter).not.toBeNull();
		expect((await profile(active.id)).purgeAfter).toBeNull();
		expect((await profile(gone.id)).status).toBe('deletion_pending');
		const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, gone.userId));
		expect(user?.status).toBe('deletion_pending');
		const purge = await db
			.select({ status: jobs.status })
			.from(jobs)
			.where(and(eq(jobs.type, 'account.purge'), sql`${jobs.payload} ->> 'user_id' = ${gone.userId}`));
		expect(purge).toEqual([{ status: 'queued' }]);
		// Not the person's act: the processing consent lapses by the system.
		const [lapse] = await db
			.select({ action: consentEvents.action, signer: consentEvents.signerKind })
			.from(consentEvents)
			.where(and(eq(consentEvents.subjectCandidateId, gone.id), eq(consentEvents.kind, 'pd_processing')))
			.orderBy(sql`${consentEvents.occurredAt} desc`)
			.limit(1);
		expect(lapse).toEqual({ action: 'lapse', signer: 'system' });

		// A second sweep of the same day repeats nothing.
		const again = await db.transaction((tx) => sweepPersonalData(tx, 'job:test', now));
		expect(again?.inactivity).toMatchObject({ kept: 0, deleted: 0 });
		expect(await db.select().from(notifications).where(eq(notifications.userId, quiet.userId))).toHaveLength(1);
	});

	it('neither tells of a removal nor sweeps day after day the profiles whose deletion would be refused', async () => {
		const { db } = database;
		await retentionPolicy();
		const now = new Date();
		const longAgo = new Date(now.getTime() - 800 * DAY);
		const dayOf = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
		const inactive = async (purgeAfter: string | null) => {
			const user = await createUser(db, { lastLoginAt: longAgo, createdAt: longAgo });
			return createCandidate(db, { userId: user.id, purgeAfter });
		};
		// A staff member and the only owner of a company are not deleted for inactivity: nobody tells them they will be.
		const operator = await inactive(null);
		await db.insert(staffRoles).values({ userId: operator.userId, role: 'operator', grantedAt: longAgo });
		const owner = await inactive(null);
		await createMember(db, (await createCompany(db)).id, { userId: owner.userId });
		// A whole sweep of staff members told before they got the role, due before a profile that can be deleted.
		const refused = await db
			.insert(users)
			.values(
				Array.from({ length: SWEEP_LIMIT }, () => ({
					status: 'active' as const,
					emailEnc: randomBytes(40),
					emailHmac: randomBytes(32).toString('hex'),
					lastLoginAt: longAgo,
					createdAt: longAgo
				}))
			)
			.returning({ id: users.id });
		await db.insert(candidates).values(
			refused.map((user) => ({
				userId: user.id,
				status: 'active' as const,
				searchStatus: 'active' as const,
				preferences: {},
				purgeAfter: dayOf(7)
			}))
		);
		await db
			.insert(staffRoles)
			.values(refused.map((user) => ({ userId: user.id, role: 'operator' as const, grantedAt: longAgo })));
		const due = await inactive(dayOf(1));

		await db.transaction((tx) => sweepPersonalData(tx, 'job:test', now));
		const [dueProfile] = await db.select().from(candidates).where(eq(candidates.id, due.id));
		expect(dueProfile?.status).toBe('deletion_pending');
		for (const kept of [operator, owner]) {
			const [row] = await db.select().from(candidates).where(eq(candidates.id, kept.id));
			expect(row?.purgeAfter).toBeNull();
			expect(await db.select().from(notifications).where(eq(notifications.userId, kept.userId))).toEqual([]);
		}
	});
	it('tells and removes nobody while the policy in effect states no notice', async () => {
		const { db } = database;
		await retentionPolicy();
		const now = new Date();
		const user = await createUser(db, {
			lastLoginAt: new Date(now.getTime() - 800 * DAY),
			createdAt: new Date(now.getTime() - 800 * DAY)
		});
		const quiet = await createCandidate(db, { userId: user.id, purgeAfter: null });
		const rollback = new Error('rollback');
		const outcome = await db
			.transaction(async (tx) => {
				// A later version without the terms of version 3 takes effect.
				await tx.insert(productPolicies).values({
					kind: 'retention_policy',
					version: 90,
					params: EARLIER_TERMS,
					effectiveFrom: new Date(now.getTime() - 30_000)
				});
				const swept = await sweepPersonalData(tx, 'job:test', now);
				expect(swept?.inactivity).toBeNull();
				const [row] = await tx
					.select({ purgeAfter: candidates.purgeAfter })
					.from(candidates)
					.where(eq(candidates.id, quiet.id));
				expect(row?.purgeAfter).toBeNull();
				throw rollback;
			})
			.catch((error: unknown) => error);
		expect(outcome).toBe(rollback);
	});
});
